//! 长江航道图专题要素采集器
//! 采集电子围栏和用于 AIS 过滤的水域面数据。

use super::sign::generate_fence_sign;
use super::types::*;
use md5::{Digest, Md5};
use rand::Rng;
use reqwest::header::{HeaderMap, HeaderName, ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const FENCE_URL: &str = "https://www.cjhy.com.cn/eweb/dzhdtapp/fenceService/getFencFromEs";
const FENCE_TYPE_URL: &str = "https://www.cjhy.com.cn/eweb/rest/specialLayer/getFenceTypeList";
const HYDRO_A_QUERY_URL: &str =
    "https://api.cjienc.cn/zxtfw/server/rest/services/cjshoudong/MapServer/37/query";
const HYDRO_PAGE_SIZE: usize = 1000;

/// 航道专题要素采集器
pub struct FeatureCollector {
    client: reqwest::Client,
    organization_id: String,
    grid_step: f64,
    include_fences: bool,
    include_hydro: bool,
}

impl FeatureCollector {
    pub fn new(grid_step: f64, include_fences: bool, include_hydro: bool) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            organization_id: "100001".to_string(),
            grid_step,
            include_fences,
            include_hydro,
        }
    }

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

    fn get_json_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                .parse()
                .unwrap(),
        );
        headers.insert(REFERER, "https://www.cjhy.com.cn/eweb/".parse().unwrap());
        headers.insert(
            HeaderName::from_static("origin"),
            "https://www.cjhy.com.cn".parse().unwrap(),
        );
        headers.insert(ACCEPT, "application/json, text/plain, */*".parse().unwrap());
        headers.insert(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap());
        headers
    }

    async fn fetch_fence_type_names(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let Ok(response) = self
            .client
            .get(FENCE_TYPE_URL)
            .headers(self.get_json_headers())
            .send()
            .await
        else {
            return out;
        };

        let Ok(body) = response.text().await else {
            return out;
        };
        let Ok(value) = serde_json::from_str::<Value>(&body) else {
            return out;
        };

        for item in Self::extract_items(&value) {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let id = Self::value_to_string(
                obj.get("id")
                    .or_else(|| obj.get("value"))
                    .or_else(|| obj.get("fenceType"))
                    .or_else(|| obj.get("type")),
            );
            let name = Self::value_to_string(
                obj.get("name")
                    .or_else(|| obj.get("label"))
                    .or_else(|| obj.get("text"))
                    .or_else(|| obj.get("typeName")),
            );
            if let (Some(id), Some(name)) = (id, name) {
                out.insert(id, name);
            }
        }

        out
    }

    async fn fetch_grid_fences(
        &self,
        grid: &GridCell,
        fence_type_names: &HashMap<String, String>,
    ) -> (Result<Vec<ChartFeatureInfo>, String>, Vec<String>) {
        let mut logs = Vec::new();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let sign = generate_fence_sign(
            grid.lat1,
            grid.lon1,
            grid.lon2,
            grid.lat2,
            &self.organization_id,
            timestamp,
        );

        logs.push(format!(
            "[REQUEST] 电子围栏: [{:.4},{:.4}]-[{:.4},{:.4}] ts={} sign={}",
            grid.lon1,
            grid.lat1,
            grid.lon2,
            grid.lat2,
            timestamp,
            &sign[..8]
        ));

        let params = vec![
            ("bottom", grid.lat1.to_string()),
            ("left", grid.lon1.to_string()),
            ("organizationId", self.organization_id.clone()),
            ("right", grid.lon2.to_string()),
            ("timeStamp", timestamp.to_string()),
            ("up", grid.lat2.to_string()),
            ("sign", sign),
        ];

        let response = match self
            .client
            .get(FENCE_URL)
            .headers(self.get_json_headers())
            .query(&params)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("电子围栏请求失败: {}", e);
                logs.push(format!("[ERROR] {}", msg));
                return (Err(msg), logs);
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let msg = format!("电子围栏 HTTP {}: {}", status, Self::preview(&body, 200));
            logs.push(format!("[ERROR] {}", msg));
            return (Err(msg), logs);
        }

        let body = match response.text().await {
            Ok(b) => b,
            Err(e) => {
                let msg = format!("读取电子围栏响应失败: {}", e);
                logs.push(format!("[ERROR] {}", msg));
                return (Err(msg), logs);
            }
        };

        let value: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("电子围栏 JSON 解析失败: {}", e);
                logs.push(format!("[ERROR] {}", msg));
                return (Err(msg), logs);
            }
        };

        if value
            .get("result")
            .and_then(|v| v.as_str())
            .is_some_and(|r| r != "1")
        {
            let msg = value
                .get("errorMsg")
                .and_then(|v| v.as_str())
                .unwrap_or("接口返回失败")
                .to_string();
            logs.push(format!("[WARN] 电子围栏 API: {}", msg));
            return (Err(msg), logs);
        }

        let mut features = Vec::new();
        for (idx, item) in Self::extract_items(&value).iter().enumerate() {
            if let Some(feature) = self.parse_fence_feature(item, fence_type_names, idx) {
                features.push(feature);
            }
        }

        logs.push(format!("[OK] 电子围栏解析到 {} 个要素", features.len()));
        (Ok(features), logs)
    }

    async fn fetch_grid_hydro(
        &self,
        grid: &GridCell,
    ) -> (Result<Vec<ChartFeatureInfo>, String>, Vec<String>) {
        let mut logs = Vec::new();
        let mut out = Vec::new();
        let mut offset = 0usize;
        let geometry = format!("{},{},{},{}", grid.lon1, grid.lat1, grid.lon2, grid.lat2);

        logs.push(format!(
            "[REQUEST] HYDRO_A: [{:.4},{:.4}]-[{:.4},{:.4}]",
            grid.lon1, grid.lat1, grid.lon2, grid.lat2
        ));

        loop {
            let params = vec![
                ("f", "geojson".to_string()),
                ("where", "1=1".to_string()),
                ("geometry", geometry.clone()),
                ("geometryType", "esriGeometryEnvelope".to_string()),
                ("inSR", "4326".to_string()),
                ("spatialRel", "esriSpatialRelIntersects".to_string()),
                ("outFields", "*".to_string()),
                ("returnGeometry", "true".to_string()),
                ("outSR", "4326".to_string()),
                ("resultOffset", offset.to_string()),
                ("resultRecordCount", HYDRO_PAGE_SIZE.to_string()),
            ];

            let response = match self
                .client
                .get(HYDRO_A_QUERY_URL)
                .headers(self.get_json_headers())
                .query(&params)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let msg = format!("HYDRO_A 请求失败: {}", e);
                    logs.push(format!("[ERROR] {}", msg));
                    return (Err(msg), logs);
                }
            };

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                let msg = format!("HYDRO_A HTTP {}: {}", status, Self::preview(&body, 200));
                logs.push(format!("[ERROR] {}", msg));
                return (Err(msg), logs);
            }

            let body = match response.text().await {
                Ok(b) => b,
                Err(e) => {
                    let msg = format!("读取 HYDRO_A 响应失败: {}", e);
                    logs.push(format!("[ERROR] {}", msg));
                    return (Err(msg), logs);
                }
            };

            let value: Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("HYDRO_A JSON 解析失败: {}", e);
                    logs.push(format!("[ERROR] {}", msg));
                    return (Err(msg), logs);
                }
            };

            if let Some(error) = value.get("error") {
                let msg = format!(
                    "HYDRO_A API 错误: {}",
                    Self::preview(&error.to_string(), 200)
                );
                logs.push(format!("[ERROR] {}", msg));
                return (Err(msg), logs);
            }

            let page_features = value
                .get("features")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let page_len = page_features.len();
            for (idx, item) in page_features.iter().enumerate() {
                if let Some(feature) = self.parse_arcgis_feature(item, offset + idx) {
                    out.push(feature);
                }
            }

            let exceeded = value
                .get("exceededTransferLimit")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if page_len < HYDRO_PAGE_SIZE || !exceeded {
                break;
            }
            offset += HYDRO_PAGE_SIZE;
        }

        logs.push(format!("[OK] HYDRO_A 解析到 {} 个水域面", out.len()));
        (Ok(out), logs)
    }

    fn parse_fence_feature(
        &self,
        item: &Value,
        fence_type_names: &HashMap<String, String>,
        index: usize,
    ) -> Option<ChartFeatureInfo> {
        let obj = item.as_object()?;
        let raw_json = serde_json::to_string(item).unwrap_or_default();
        let polygon = obj.get("polygon")?;

        let feature_type_code = Self::value_to_string(
            obj.get("fenceType")
                .or_else(|| obj.get("type"))
                .or_else(|| obj.get("layerType")),
        );
        let feature_type = feature_type_code.as_ref().map(|code| {
            fence_type_names
                .get(code)
                .cloned()
                .unwrap_or_else(|| format!("电子围栏类型{}", code))
        });

        let source_feature_id = Self::value_to_string(
            obj.get("id")
                .or_else(|| obj.get("fenceId"))
                .or_else(|| obj.get("objectId"))
                .or_else(|| obj.get("uuid")),
        );
        let name = Self::value_to_string(
            obj.get("name")
                .or_else(|| obj.get("fenceName"))
                .or_else(|| obj.get("title"))
                .or_else(|| obj.get("mc"))
                .or_else(|| obj.get("content")),
        );
        let feature_type_raw = Self::value_to_string(obj.get("featureType"));
        let (geometry, geometry_type) =
            Self::normalize_fence_geometry(polygon, feature_type_raw.as_deref())?;
        let (min_lon, min_lat, max_lon, max_lat) = Self::geometry_bbox(&geometry);

        let fallback_id = Self::hash_id(&raw_json);
        let source_id = source_feature_id
            .clone()
            .unwrap_or_else(|| format!("{}_{}", feature_type_code.unwrap_or_default(), index));
        let id = format!(
            "cjhy_fence:{}",
            if source_id.is_empty() {
                fallback_id
            } else {
                source_id
            }
        );

        Some(ChartFeatureInfo {
            id,
            source: "cjhy_fence".to_string(),
            source_layer: "electronic_fence".to_string(),
            source_feature_id,
            name,
            feature_type,
            geometry_type: Some(geometry_type),
            geometry_json: serde_json::to_string(&geometry).unwrap_or_default(),
            min_lon,
            min_lat,
            max_lon,
            max_lat,
            raw_json,
        })
    }

    fn parse_arcgis_feature(&self, item: &Value, index: usize) -> Option<ChartFeatureInfo> {
        let raw_json = serde_json::to_string(item).unwrap_or_default();
        let geometry = item.get("geometry")?.clone();
        let properties = item.get("properties").and_then(|v| v.as_object());
        let source_feature_id = properties.and_then(|obj| {
            Self::value_to_string(
                obj.get("OBJECTID")
                    .or_else(|| obj.get("FID"))
                    .or_else(|| obj.get("ID"))
                    .or_else(|| obj.get("objectid")),
            )
        });
        let name = properties.and_then(|obj| {
            Self::value_to_string(
                obj.get("NAME")
                    .or_else(|| obj.get("OBJNAM"))
                    .or_else(|| obj.get("name")),
            )
        });
        let feature_type = properties
            .and_then(|obj| Self::value_to_string(obj.get("TYPE").or_else(|| obj.get("type"))))
            .or_else(|| Some("HYDRO_A".to_string()));
        let geometry_type = geometry
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let (min_lon, min_lat, max_lon, max_lat) = Self::geometry_bbox(&geometry);

        let source_id = source_feature_id
            .clone()
            .unwrap_or_else(|| format!("idx{}_{}", index, Self::hash_id(&raw_json)));
        let id = format!("cjshoudong:HYDRO_A:{}", source_id);

        Some(ChartFeatureInfo {
            id,
            source: "cjshoudong_mapserver".to_string(),
            source_layer: "HYDRO_A".to_string(),
            source_feature_id,
            name,
            feature_type,
            geometry_type,
            geometry_json: serde_json::to_string(&geometry).unwrap_or_default(),
            min_lon,
            min_lat,
            max_lon,
            max_lat,
            raw_json,
        })
    }

    fn normalize_fence_geometry(
        polygon: &Value,
        feature_type: Option<&str>,
    ) -> Option<(Value, String)> {
        let parsed_polygon = if let Some(s) = polygon.as_str() {
            serde_json::from_str::<Value>(s).ok()?
        } else {
            polygon.clone()
        };

        let coordinates = parsed_polygon.get("coordinates").cloned().or_else(|| {
            if parsed_polygon.is_array() {
                Some(parsed_polygon.clone())
            } else {
                None
            }
        })?;

        let geometry_type = match feature_type {
            Some("0") => "Point",
            Some("1") => "LineString",
            Some("2") => "Polygon",
            _ => parsed_polygon
                .get("type")
                .and_then(|v| v.as_str())
                .map(Self::normalize_geometry_type)
                .unwrap_or("Geometry"),
        };

        Some((
            json!({
                "type": geometry_type,
                "coordinates": coordinates,
            }),
            geometry_type.to_string(),
        ))
    }

    fn normalize_geometry_type(raw: &str) -> &'static str {
        match raw.to_ascii_lowercase().as_str() {
            "point" => "Point",
            "linestring" | "line_string" => "LineString",
            "polygon" => "Polygon",
            "multipolygon" | "multi_polygon" => "MultiPolygon",
            "multilinestring" | "multi_line_string" => "MultiLineString",
            _ => "Geometry",
        }
    }

    fn extract_items(value: &Value) -> Vec<Value> {
        if let Some(arr) = value.as_array() {
            return arr.clone();
        }
        if let Some(obj) = value.as_object() {
            for key in ["data", "rows", "list", "features", "records"] {
                if let Some(v) = obj.get(key) {
                    let items = Self::extract_items(v);
                    if !items.is_empty() {
                        return items;
                    }
                }
            }
        }
        Vec::new()
    }

    fn value_to_string(value: Option<&Value>) -> Option<String> {
        let v = value?;
        if let Some(s) = v.as_str() {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else if let Some(n) = v.as_i64() {
            Some(n.to_string())
        } else if let Some(n) = v.as_u64() {
            Some(n.to_string())
        } else if let Some(n) = v.as_f64() {
            Some(n.to_string())
        } else {
            None
        }
    }

    fn geometry_bbox(geometry: &Value) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
        let mut bbox = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        let Some(coords) = geometry.get("coordinates") else {
            return (None, None, None, None);
        };

        Self::walk_coords(coords, &mut bbox);
        if bbox[0].is_finite() && bbox[1].is_finite() && bbox[2].is_finite() && bbox[3].is_finite()
        {
            (Some(bbox[0]), Some(bbox[1]), Some(bbox[2]), Some(bbox[3]))
        } else {
            (None, None, None, None)
        }
    }

    fn walk_coords(value: &Value, bbox: &mut [f64; 4]) {
        let Some(arr) = value.as_array() else {
            return;
        };
        if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
            if let (Some(lon), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                bbox[0] = bbox[0].min(lon);
                bbox[1] = bbox[1].min(lat);
                bbox[2] = bbox[2].max(lon);
                bbox[3] = bbox[3].max(lat);
            }
            return;
        }
        for child in arr {
            Self::walk_coords(child, bbox);
        }
    }

    fn hash_id(raw: &str) -> String {
        let mut hasher = Md5::new();
        hasher.update(raw.as_bytes());
        format!("{:X}", hasher.finalize())
    }

    fn preview(s: &str, max_len: usize) -> String {
        if s.chars().count() <= max_len {
            s.to_string()
        } else {
            let mut out = s.chars().take(max_len).collect::<String>();
            out.push_str("...");
            out
        }
    }

    /// 采集指定范围内的电子围栏和水域面要素
    pub async fn collect(
        &self,
        bounds: &ChartBounds,
        stop_flag: Arc<AtomicBool>,
        progress_tx: mpsc::Sender<ChartProgressEvent>,
        log_tx: mpsc::Sender<String>,
    ) -> Result<Vec<ChartFeatureInfo>, String> {
        if !self.include_fences && !self.include_hydro {
            return Err("未选择要采集的航道要素".to_string());
        }

        let grids = self.split_into_grids(bounds);
        let source_count = self.include_fences as u64 + self.include_hydro as u64;
        let total_ops = grids.len() as u64 * source_count;
        let mut current_ops = 0u64;
        let mut error_count = 0u64;
        let mut features: HashMap<String, ChartFeatureInfo> = HashMap::new();

        let _ = log_tx
            .send(format!(
                "[INFO] 航道要素范围切分为 {} 个网格 (步长: {}°)，采集源: {}{}",
                grids.len(),
                self.grid_step,
                if self.include_fences {
                    "电子围栏 "
                } else {
                    ""
                },
                if self.include_hydro {
                    "HYDRO_A水域面"
                } else {
                    ""
                },
            ))
            .await;

        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "feature".to_string(),
                status: "collecting".to_string(),
                current: 0,
                total: total_ops,
                message: Some(format!("开始采集，共 {} 个请求", total_ops)),
            })
            .await;

        let fence_type_names = if self.include_fences {
            let names = self.fetch_fence_type_names().await;
            let _ = log_tx
                .send(format!("[INFO] 已加载 {} 个电子围栏类型", names.len()))
                .await;
            names
        } else {
            HashMap::new()
        };

        for (idx, grid) in grids.iter().enumerate() {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = log_tx
                    .send("[STOP] 航道要素采集已被用户停止".to_string())
                    .await;
                return Ok(features.into_values().collect());
            }

            let _ = log_tx
                .send(format!("--- 航道要素网格 {}/{} ---", idx + 1, grids.len()))
                .await;

            if self.include_fences {
                let (result, logs) = self.fetch_grid_fences(grid, &fence_type_names).await;
                for log in logs {
                    let _ = log_tx.send(log).await;
                }
                match result {
                    Ok(items) => {
                        let before = features.len();
                        for item in items {
                            features.insert(item.id.clone(), item);
                        }
                        let _ = log_tx
                            .send(format!(
                                "[STATS] 电子围栏去重新增 {} 个，累计 {} 个",
                                features.len().saturating_sub(before),
                                features.len()
                            ))
                            .await;
                    }
                    Err(e) => {
                        error_count += 1;
                        let _ = log_tx.send(format!("[ERROR] 电子围栏失败: {}", e)).await;
                    }
                }
                current_ops += 1;
                let _ = progress_tx
                    .send(ChartProgressEvent {
                        task_type: "feature".to_string(),
                        status: "collecting".to_string(),
                        current: current_ops,
                        total: total_ops,
                        message: Some(format!(
                            "已完成 {}/{} 请求，累计 {} 个要素 (失败: {})",
                            current_ops,
                            total_ops,
                            features.len(),
                            error_count
                        )),
                    })
                    .await;
            }

            if self.include_hydro {
                let (result, logs) = self.fetch_grid_hydro(grid).await;
                for log in logs {
                    let _ = log_tx.send(log).await;
                }
                match result {
                    Ok(items) => {
                        let before = features.len();
                        for item in items {
                            features.insert(item.id.clone(), item);
                        }
                        let _ = log_tx
                            .send(format!(
                                "[STATS] HYDRO_A 去重新增 {} 个，累计 {} 个",
                                features.len().saturating_sub(before),
                                features.len()
                            ))
                            .await;
                    }
                    Err(e) => {
                        error_count += 1;
                        let _ = log_tx.send(format!("[ERROR] HYDRO_A 失败: {}", e)).await;
                    }
                }
                current_ops += 1;
                let _ = progress_tx
                    .send(ChartProgressEvent {
                        task_type: "feature".to_string(),
                        status: "collecting".to_string(),
                        current: current_ops,
                        total: total_ops,
                        message: Some(format!(
                            "已完成 {}/{} 请求，累计 {} 个要素 (失败: {})",
                            current_ops,
                            total_ops,
                            features.len(),
                            error_count
                        )),
                    })
                    .await;
            }

            let delay = {
                let mut rng = rand::thread_rng();
                rng.gen_range(300..900u64)
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        let total_features = features.len();
        let _ = log_tx
            .send(format!(
                "[DONE] 航道要素采集完成: 共 {} 个要素, {} 个请求失败",
                total_features, error_count
            ))
            .await;
        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "feature".to_string(),
                status: "completed".to_string(),
                current: total_ops,
                total: total_ops,
                message: Some(format!(
                    "采集完成，共 {} 个要素 (失败: {})",
                    total_features, error_count
                )),
            })
            .await;

        Ok(features.into_values().collect())
    }
}
