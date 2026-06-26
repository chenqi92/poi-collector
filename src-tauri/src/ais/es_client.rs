//! 直接打 Elasticsearch REST 的轻量客户端（不引入 elasticsearch crate）。
//! 这样才能同时兼容老版本 5/6/7 与新版本 8：搜索/聚合 DSL 跨版本通用，
//! 鉴权用标准 HTTP 头，响应里 hits.total 的数字/对象两种形态在这里归一化。

use super::types::EsConnection;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::time::Duration;

pub struct EsClient {
    client: reqwest::Client,
    base: String,
    headers: HeaderMap,
}

impl EsClient {
    pub fn new(conn: &EsConnection) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
        if conn.accept_invalid_certs {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let scheme = if conn.scheme.trim().is_empty() {
            "http"
        } else {
            conn.scheme.trim()
        };
        let host = conn.host.trim().trim_end_matches('/');
        if host.is_empty() {
            return Err("ES 主机不能为空".to_string());
        }
        let base = format!("{}://{}:{}", scheme, host, conn.port);

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        match conn.auth_type.as_str() {
            "basic" => {
                let token = B64.encode(format!("{}:{}", conn.username, conn.password));
                if let Ok(v) = HeaderValue::from_str(&format!("Basic {}", token)) {
                    headers.insert(AUTHORIZATION, v);
                }
            }
            "apikey" => {
                if let Ok(v) = HeaderValue::from_str(&format!("ApiKey {}", conn.api_key.trim())) {
                    headers.insert(AUTHORIZATION, v);
                }
            }
            _ => {}
        }

        Ok(Self {
            client,
            base,
            headers,
        })
    }

    /// GET {base}{path}，返回解析后的 JSON。path 为空即请求根（集群信息）。
    pub async fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .client
            .get(&url)
            .headers(self.headers.clone())
            .send()
            .await
            .map_err(|e| format!("连接失败: {}", e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&body, 300)));
        }
        serde_json::from_str(&body).map_err(|e| format!("解析 JSON 失败: {}", e))
    }

    /// GET / —— 读取集群信息（含 version.number）。
    pub async fn get_root(&self) -> Result<Value, String> {
        self.get("").await
    }

    /// POST /{index}/_search。index 可为逗号分隔的多个索引或通配（如 `a,b` / `ais-*`）。
    pub async fn search(&self, index: &str, body: &Value) -> Result<Value, String> {
        let index = index.trim();
        if index.is_empty() {
            return Err("索引名不能为空".to_string());
        }
        let url = format!("{}/{}/_search", self.base, index);
        let resp = self
            .client
            .post(&url)
            .headers(self.headers.clone())
            .body(serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string()))
            .send()
            .await
            .map_err(|e| format!("查询失败: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "ES 返回 HTTP {}: {}",
                status.as_u16(),
                truncate(&text, 500)
            ));
        }
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {}", e))
    }

    /// 开启 scroll：POST /{index}/_search?scroll=keep，返回 (scroll_id, 首批响应)。
    pub async fn scroll_start(
        &self,
        index: &str,
        body: &Value,
        keep: &str,
    ) -> Result<(String, Value), String> {
        let index = index.trim();
        if index.is_empty() {
            return Err("索引名不能为空".to_string());
        }
        let url = format!("{}/{}/_search?scroll={}", self.base, index, keep);
        let resp = self
            .client
            .post(&url)
            .headers(self.headers.clone())
            .body(serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string()))
            .send()
            .await
            .map_err(|e| format!("查询失败: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "ES 返回 HTTP {}: {}",
                status.as_u16(),
                truncate(&text, 500)
            ));
        }
        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {}", e))?;
        let sid = v["_scroll_id"].as_str().unwrap_or("").to_string();
        Ok((sid, v))
    }

    /// 取下一批 scroll 数据。
    pub async fn scroll_next(&self, scroll_id: &str, keep: &str) -> Result<Value, String> {
        let url = format!("{}/_search/scroll", self.base);
        let body = json!({ "scroll": keep, "scroll_id": scroll_id });
        let resp = self
            .client
            .post(&url)
            .headers(self.headers.clone())
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("查询失败: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "ES 返回 HTTP {}: {}",
                status.as_u16(),
                truncate(&text, 500)
            ));
        }
        serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {}", e))
    }

    /// 清理 scroll 上下文（尽力而为）。
    pub async fn scroll_clear(&self, scroll_id: &str) {
        let url = format!("{}/_search/scroll", self.base);
        let body = json!({ "scroll_id": [scroll_id] });
        let _ = self
            .client
            .request(reqwest::Method::DELETE, &url)
            .headers(self.headers.clone())
            .body(body.to_string())
            .send()
            .await;
    }
}

/// 归一化 hits.total：老版本是数字，7+ 是 `{value, relation}`。
/// 返回 (命中数, 是否 ">=" 即被截断)。
pub fn total_from_hits(resp: &Value) -> (u64, bool) {
    let t = &resp["hits"]["total"];
    match t {
        Value::Number(n) => (n.as_u64().unwrap_or(0), false),
        Value::Object(_) => {
            let value = t.get("value").and_then(|v| v.as_u64()).unwrap_or(0);
            let gte = t
                .get("relation")
                .and_then(|v| v.as_str())
                .map(|s| s == "gte")
                .unwrap_or(false);
            (value, gte)
        }
        _ => (0, false),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{}…", cut)
    }
}
