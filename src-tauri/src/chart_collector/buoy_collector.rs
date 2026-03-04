//! 航标数据采集器
//! 使用网格切片 (Grid Splitting) 策略采集航标矢量数据

use super::sign::generate_buoy_sign;
use super::types::*;
use rand::Rng;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// 航标数据采集器
pub struct BuoyCollector {
    client: reqwest::Client,
    organization_id: String,
    uid: String,
    grid_step: f64,
}

impl BuoyCollector {
    pub fn new(grid_step: f64) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            organization_id: "100001".to_string(),
            uid: String::new(),
            grid_step,
        }
    }

    /// 将大范围切分为小网格
    fn split_into_grids(&self, bounds: &ChartBounds) -> Vec<GridCell> {
        let mut grids = Vec::new();
        let mut index = 0;

        let mut lat = bounds.south;
        while lat < bounds.north {
            let lat_end = (lat + self.grid_step).min(bounds.north);
            let mut lon = bounds.west;
            while lon < bounds.east {
                let lon_end = (lon + self.grid_step).min(bounds.east);
                grids.push(GridCell {
                    lon1: lon,
                    lat1: lat,
                    lon2: lon_end,
                    lat2: lat_end,
                    index,
                });
                index += 1;
                lon += self.grid_step;
            }
            lat += self.grid_step;
        }

        grids
    }

    /// 获取请求头
    fn get_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                .parse().unwrap(),
        );
        headers.insert(
            reqwest::header::REFERER,
            "https://www.cjhy.com.cn/eweb/".parse().unwrap(),
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("origin"),
            "https://www.cjhy.com.cn".parse().unwrap(),
        );
        headers.insert(
            reqwest::header::ACCEPT,
            "application/json, text/plain, */*".parse().unwrap(),
        );
        headers.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap(),
        );
        headers
    }

    /// 请求单个网格的航标数据，返回 (buoys, log_messages)
    async fn fetch_grid_buoys(
        &self,
        grid: &GridCell,
    ) -> (Result<Vec<BuoyInfo>, String>, Vec<String>) {
        let mut logs = Vec::new();

        // 生成签名
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let sign = generate_buoy_sign(
            grid.lon1,
            grid.lat1,
            grid.lon2,
            grid.lat2,
            &self.organization_id,
            timestamp,
            &self.uid,
        );

        let url = format!(
            "https://www.cjhy.com.cn/eweb/api/buoyService/getAllBuoyInfoByRectUid?\
            lon1={}&lat1={}&lon2={}&lat2={}&organizationId={}&timeStamp={}&uid={}&sign={}",
            grid.lon1,
            grid.lat1,
            grid.lon2,
            grid.lat2,
            self.organization_id,
            timestamp,
            &self.uid,
            sign
        );

        logs.push(format!(
            "📡 请求: [{:.4},{:.4}]-[{:.4},{:.4}] ts={} sign={}",
            grid.lon1,
            grid.lat1,
            grid.lon2,
            grid.lat2,
            timestamp,
            &sign[..8]
        ));

        let response = match self
            .client
            .get(&url)
            .headers(self.get_headers())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("❌ 网络请求失败: {}", e);
                logs.push(msg.clone());
                return (Err(msg), logs);
            }
        };

        let status = response.status();
        logs.push(format!("📥 HTTP {}", status.as_u16()));

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let body_preview = if body.len() > 200 {
                format!("{}...", &body[..200])
            } else {
                body.clone()
            };
            let msg = format!("❌ HTTP 错误 {}: {}", status, body_preview);
            logs.push(msg.clone());
            return (Err(msg), logs);
        }

        let body = match response.text().await {
            Ok(b) => b,
            Err(e) => {
                let msg = format!("❌ 读取响应体失败: {}", e);
                logs.push(msg.clone());
                return (Err(msg), logs);
            }
        };

        // 显示响应体预览
        let body_preview = if body.len() > 300 {
            format!("{}...(共{}字节)", &body[..300], body.len())
        } else {
            body.clone()
        };
        logs.push(format!("📄 响应: {}", body_preview));

        let api_response: BuoyApiResponse = match serde_json::from_str(&body) {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("❌ JSON 解析失败: {}", e);
                logs.push(msg.clone());
                return (Err(msg), logs);
            }
        };

        // 检查 API 返回状态
        if let Some(ref result) = api_response.result {
            if result != "1" {
                let err_msg = api_response
                    .error_msg
                    .unwrap_or_else(|| "未知错误".to_string());
                let err_code = api_response.error_code.unwrap_or(-1);
                let msg = format!("⚠️ API 返回错误: {} (code: {})", err_msg, err_code);
                logs.push(msg.clone());
                return (Err(msg), logs);
            }
        }

        // 解析航标数据
        let buoys = self.parse_buoy_data(&api_response.data);
        logs.push(format!("✅ 解析到 {} 个航标", buoys.len()));

        (Ok(buoys), logs)
    }

    /// 从 API 响应中解析航标数据
    fn parse_buoy_data(&self, data: &Option<serde_json::Value>) -> Vec<BuoyInfo> {
        let mut buoys = Vec::new();

        let data_val = match data {
            Some(v) => v,
            None => return buoys,
        };

        // data 可能是数组或包含数组的对象
        let items = if let Some(arr) = data_val.as_array() {
            arr.clone()
        } else if let Some(obj) = data_val.as_object() {
            if let Some(arr) = obj.get("list").and_then(|v| v.as_array()) {
                arr.clone()
            } else if let Some(arr) = obj.get("rows").and_then(|v| v.as_array()) {
                arr.clone()
            } else if let Some(arr) = obj.get("data").and_then(|v| v.as_array()) {
                arr.clone()
            } else {
                if obj.is_empty() {
                    return buoys;
                }
                vec![data_val.clone()]
            }
        } else {
            return buoys;
        };

        for item in &items {
            if let Some(obj) = item.as_object() {
                let id = obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                if id.is_empty() {
                    continue;
                }

                let name = obj
                    .get("hbmc")
                    .or_else(|| obj.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let lon_84 = obj.get("jdwz_84jd").and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                });

                let lat_84 = obj.get("jdwz_84wd").and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                });

                let buoy_type = obj
                    .get("hblx")
                    .or_else(|| obj.get("type"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let icon_url = obj
                    .get("hbtlpz")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let color = obj
                    .get("hbys")
                    .or_else(|| obj.get("bsys"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let organization_id = obj
                    .get("organizationId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // 新增字段
                let waterway = obj
                    .get("sshd")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());

                let shape = obj
                    .get("hbxz")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());

                let light_info = obj
                    .get("dzxx")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());

                // 从 ID 前缀推导所属地区
                let region = Self::id_prefix_to_region(&id);

                buoys.push(BuoyInfo {
                    id,
                    name,
                    lon_84,
                    lat_84,
                    buoy_type,
                    icon_url,
                    organization_id,
                    color,
                    waterway,
                    shape,
                    light_info,
                    region,
                    raw_json: serde_json::to_string(item).unwrap_or_default(),
                });
            }
        }

        buoys
    }

    /// 根据航标 ID 前缀推导所属地区
    fn id_prefix_to_region(id: &str) -> Option<String> {
        if let Some(prefix) = id.split('_').next() {
            match prefix {
                "WH" => Some("武汉".to_string()),
                "YC" => Some("宜昌".to_string()),
                "JZ" => Some("荆州".to_string()),
                "HXJ" => Some("湘鄂赣".to_string()),
                "XN" => Some("咸宁".to_string()),
                "HG" => Some("黄冈".to_string()),
                "EZ" => Some("鄂州".to_string()),
                "HS" => Some("黄石".to_string()),
                "JM" => Some("荆门".to_string()),
                "GJH" => Some("公安(荆江河段)".to_string()),
                "XJ" => Some("新建".to_string()),
                "CS" => Some("长沙".to_string()),
                "YY" => Some("岳阳".to_string()),
                "JJ" => Some("九江".to_string()),
                _ => Some(format!("{}", prefix)),
            }
        } else {
            None
        }
    }

    /// 采集指定范围内的所有航标数据
    pub async fn collect(
        &self,
        bounds: &ChartBounds,
        stop_flag: Arc<AtomicBool>,
        progress_tx: mpsc::Sender<ChartProgressEvent>,
        log_tx: mpsc::Sender<String>,
    ) -> Result<Vec<BuoyInfo>, String> {
        let grids = self.split_into_grids(bounds);
        let total_grids = grids.len() as u64;

        let _ = log_tx
            .send(format!(
                "🗺️ 范围切分为 {} 个网格 (步长: {}°), 范围: [{:.4},{:.4}]-[{:.4},{:.4}]",
                total_grids, self.grid_step, bounds.west, bounds.south, bounds.east, bounds.north
            ))
            .await;

        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "buoy".to_string(),
                status: "collecting".to_string(),
                current: 0,
                total: total_grids,
                message: Some(format!("开始采集，共 {} 个网格", total_grids)),
            })
            .await;

        let mut all_buoys: HashMap<String, BuoyInfo> = HashMap::new();
        let mut error_count = 0u64;

        for (idx, grid) in grids.iter().enumerate() {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = log_tx.send("⏹️ 采集已被用户停止".to_string()).await;
                return Ok(all_buoys.into_values().collect());
            }

            let _ = log_tx
                .send(format!("--- 网格 {}/{} ---", idx + 1, total_grids))
                .await;

            let (result, logs) = self.fetch_grid_buoys(grid).await;

            // 发送所有详细日志
            for log in logs {
                let _ = log_tx.send(log).await;
            }

            match result {
                Ok(buoys) => {
                    let new_count = buoys.len();
                    let mut added = 0;
                    for buoy in buoys {
                        if !all_buoys.contains_key(&buoy.id) {
                            all_buoys.insert(buoy.id.clone(), buoy);
                            added += 1;
                        }
                    }
                    let _ = log_tx
                        .send(format!(
                            "📊 获取 {} 个, 新增 {} 个, 去重后累计: {}",
                            new_count,
                            added,
                            all_buoys.len()
                        ))
                        .await;
                }
                Err(e) => {
                    error_count += 1;
                    let _ = log_tx
                        .send(format!("❌ 网格 {} 失败: {}", idx + 1, e))
                        .await;
                }
            }

            let _ = progress_tx
                .send(ChartProgressEvent {
                    task_type: "buoy".to_string(),
                    status: "collecting".to_string(),
                    current: (idx + 1) as u64,
                    total: total_grids,
                    message: Some(format!(
                        "网格 {}/{}, 已获取 {} 个航标 (失败: {})",
                        idx + 1,
                        total_grids,
                        all_buoys.len(),
                        error_count,
                    )),
                })
                .await;

            // 随机延迟 500-1500ms
            let delay = {
                let mut rng = rand::thread_rng();
                rng.gen_range(500..1500u64)
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        let total_buoys = all_buoys.len();

        let _ = log_tx
            .send(format!(
                "🏁 航标采集完成: 共 {} 个航标, {} 个网格失败",
                total_buoys, error_count
            ))
            .await;

        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "buoy".to_string(),
                status: "completed".to_string(),
                current: total_grids,
                total: total_grids,
                message: Some(format!(
                    "采集完成，共 {} 个航标 (失败: {})",
                    total_buoys, error_count
                )),
            })
            .await;

        Ok(all_buoys.into_values().collect())
    }
}
