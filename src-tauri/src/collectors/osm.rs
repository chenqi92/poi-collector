//! OpenStreetMap POI 采集器
//!
//! 使用 Overpass API，无需 API Key

use super::{Collector, POIData, RegionConfig};
use serde::Deserialize;

pub struct OsmCollector {
    region: Option<RegionConfig>,
}

impl OsmCollector {
    pub fn new() -> Self {
        Self { region: None }
    }
}

#[derive(Debug, Deserialize)]
struct OverpassResponse {
    elements: Vec<OverpassElement>,
}

#[derive(Debug, Deserialize)]
struct OverpassElement {
    #[serde(rename = "type")]
    element_type: String,
    id: i64,
    lat: Option<f64>,
    lon: Option<f64>,
    center: Option<OverpassCenter>,
    tags: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct OverpassCenter {
    lat: f64,
    lon: f64,
}

impl Collector for OsmCollector {
    fn platform(&self) -> &'static str {
        "osm"
    }

    fn set_api_key(&mut self, _key: String) {
        // OSM 不需要 API Key
    }

    fn set_region(&mut self, region: RegionConfig) {
        self.region = Some(region);
    }

    fn search_poi(
        &self,
        keyword: &str,
        page: usize,
        category_name: &str,
        category_id: &str,
    ) -> Result<(Vec<POIData>, bool), String> {
        let region = self.region.as_ref().ok_or("未设置区域")?;

        // OSM 不支持分页，只返回第一页
        if page > 1 {
            return Ok((vec![], false));
        }

        // 构建 Overpass QL 查询
        // 使用基于区域名称的 area 查询，避免使用过大的 bounds
        // area 查询比 bbox 查询更精确，对于中国城市效果更好
        let escaped_keyword = keyword.replace("\"", "").replace("\\", "");
        let escaped_region = region.name.replace("\"", "").replace("\\", "");

        // 使用 area 查询来限制到特定行政区
        let query = format!(
            r#"[out:json][timeout:60];
area["name"~"{region}"]["boundary"="administrative"]->.searchArea;
(
  node["name"~"{keyword}",i](area.searchArea);
  way["name"~"{keyword}",i](area.searchArea);
  relation["name"~"{keyword}",i](area.searchArea);
);
out center body;
"#,
            keyword = escaped_keyword,
            region = escaped_region
        );

        log::info!("[OSM] 搜索关键词: {} 区域: {}", keyword, region.name);
        log::info!("[OSM] 正在连接 Overpass API 服务器...");

        // 调用 Overpass API - 使用多个镜像服务器
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        // Overpass API 镜像列表（按优先级排序，优先使用俄罗斯镜像，国内访问更稳定）
        let endpoints = [
            "https://overpass.openstreetmap.ru/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass-api.de/api/interpreter",
        ];

        let mut last_error = String::new();
        let mut response_result = None;

        for (idx, endpoint) in endpoints.iter().enumerate() {
            log::info!("[OSM] 尝试服务器 {}/{}...", idx + 1, endpoints.len());
            match client
                .post(*endpoint)
                .body(query.clone())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("User-Agent", "POI-Collector/1.0")
                .send()
            {
                Ok(resp) if resp.status().is_success() => {
                    log::info!("[OSM] 服务器 {} 响应成功!", idx + 1);
                    response_result = Some(resp);
                    break;
                }
                Ok(resp) => {
                    last_error = format!("服务器返回 HTTP {}", resp.status());
                    log::warn!("[OSM] 服务器 {} 失败: {}", idx + 1, last_error);
                }
                Err(e) => {
                    // 判断错误类型，给出更友好的提示
                    if e.is_timeout() {
                        last_error = "连接超时（可能需要网络代理）".to_string();
                    } else if e.is_connect() {
                        last_error = "无法连接服务器（请检查网络）".to_string();
                    } else {
                        last_error = e.to_string();
                    }
                    log::warn!("[OSM] 服务器 {} 失败: {}", idx + 1, last_error);
                }
            }
        }

        let response = response_result.ok_or_else(|| {
            format!(
                "无法访问 Overpass API，请检查网络连接。最后错误: {}",
                last_error
            )
        })?;

        let data: OverpassResponse = response
            .json()
            .map_err(|e| format!("解析 Overpass 响应失败: {}", e))?;

        log::info!("[OSM] 找到 {} 个结果", data.elements.len());

        let mut pois = Vec::new();
        let mut filtered_count = 0;
        for element in data.elements {
            // 获取坐标（节点直接有，way/relation 使用 center）
            let (lat, lon) = if let (Some(lat), Some(lon)) = (element.lat, element.lon) {
                (lat, lon)
            } else if let Some(center) = element.center {
                (center.lat, center.lon)
            } else {
                continue; // 没有坐标，跳过
            };

            // 检查是否在区域 bounds 范围内（与其他采集器保持一致）
            let bounds = &region.bounds;
            if lon < bounds.min_lon
                || lon > bounds.max_lon
                || lat < bounds.min_lat
                || lat > bounds.max_lat
            {
                filtered_count += 1;
                continue; // 不在区域范围内，跳过
            }

            let tags = element.tags.unwrap_or_default();
            let name = tags.get("name").cloned().unwrap_or_default();

            if name.is_empty() {
                continue; // 没有名称，跳过
            }

            // 构建地址
            let address = self.build_address(&tags, &region.name);

            // 获取电话
            let phone = tags
                .get("phone")
                .or_else(|| tags.get("contact:phone"))
                .cloned()
                .unwrap_or_default();

            // 获取 OSM 类型标签
            let osm_category = self.get_osm_category(&tags);

            pois.push(POIData {
                name,
                lon,
                lat,
                original_lon: lon,
                original_lat: lat,
                category: category_name.to_string(),
                category_id: category_id.to_string(),
                address,
                phone,
                platform: "osm".to_string(),
                raw_data: format!(
                    r#"{{"id":{},"type":"{}","osm_category":"{}"}}"#,
                    element.id, element.element_type, osm_category
                ),
            });
        }

        if filtered_count > 0 {
            log::info!("[OSM] 过滤区域外 POI: {} 个", filtered_count);
        }
        log::info!("[OSM] 有效 POI: {} 个", pois.len());

        // OSM 一次返回所有结果，没有更多页
        Ok((pois, false))
    }

    fn is_quota_error(&self, _response: &serde_json::Value) -> bool {
        // OSM 没有配额限制，但有速率限制
        false
    }
}

impl OsmCollector {
    /// 从 OSM tags 构建地址
    fn build_address(
        &self,
        tags: &std::collections::HashMap<String, String>,
        region_name: &str,
    ) -> String {
        let mut parts = Vec::new();

        // 添加地区名作为前缀
        parts.push(region_name.to_string());

        // 添加街道地址
        if let Some(street) = tags.get("addr:street") {
            if let Some(housenumber) = tags.get("addr:housenumber") {
                parts.push(format!("{}{}", street, housenumber));
            } else {
                parts.push(street.clone());
            }
        }

        // 添加地址完整字段
        if let Some(full) = tags.get("addr:full") {
            if !parts.iter().any(|p| full.contains(p)) {
                parts.push(full.clone());
            }
        }

        parts.join("")
    }

    /// 获取 OSM 类别
    fn get_osm_category(&self, tags: &std::collections::HashMap<String, String>) -> String {
        // 按优先级检查常见类别标签
        let category_keys = [
            "amenity", "shop", "tourism", "leisure", "building", "landuse", "highway",
        ];

        for key in &category_keys {
            if let Some(value) = tags.get(*key) {
                return format!("{}={}", key, value);
            }
        }

        "unknown".to_string()
    }
}
