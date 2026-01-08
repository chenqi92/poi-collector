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
        let bounds = &region.bounds;

        // OSM 不支持分页，只返回第一页
        if page > 1 {
            return Ok((vec![], false));
        }

        // 构建 Overpass QL 查询
        // 根据关键词搜索名称包含该关键词的 POI
        let query = format!(
            r#"[out:json][timeout:30];
(
  node["name"~"{keyword}",i]({min_lat},{min_lon},{max_lat},{max_lon});
  way["name"~"{keyword}",i]({min_lat},{min_lon},{max_lat},{max_lon});
  relation["name"~"{keyword}",i]({min_lat},{min_lon},{max_lat},{max_lon});
);
out center body;
"#,
            keyword = keyword.replace("\"", ""),
            min_lat = bounds.min_lat,
            min_lon = bounds.min_lon,
            max_lat = bounds.max_lat,
            max_lon = bounds.max_lon
        );

        log::info!("[OSM] 搜索: {} 区域: {}", keyword, region.name);

        // 调用 Overpass API - 使用多个镜像服务器
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        // Overpass API 镜像列表（按优先级排序）
        let endpoints = [
            "https://overpass.kumi.systems/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass-api.de/api/interpreter",
            "https://overpass.openstreetmap.ru/api/interpreter",
        ];

        let mut last_error = String::new();
        let mut response_result = None;

        for (idx, endpoint) in endpoints.iter().enumerate() {
            log::info!("[OSM] 尝试服务器 {}: {}", idx + 1, endpoint);
            match client
                .post(*endpoint)
                .body(query.clone())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .send()
            {
                Ok(resp) if resp.status().is_success() => {
                    log::info!("[OSM] 服务器 {} 响应成功", idx + 1);
                    response_result = Some(resp);
                    break;
                }
                Ok(resp) => {
                    last_error = format!("服务器 {} 返回错误: {}", endpoint, resp.status());
                    log::warn!("[OSM] {}", last_error);
                }
                Err(e) => {
                    last_error = format!("服务器 {} 请求失败: {}", endpoint, e);
                    log::warn!("[OSM] {}", last_error);
                }
            }
        }

        let response = response_result
            .ok_or_else(|| format!("所有 Overpass API 服务器均不可用: {}", last_error))?;

        let data: OverpassResponse = response
            .json()
            .map_err(|e| format!("解析 Overpass 响应失败: {}", e))?;

        log::info!("[OSM] 找到 {} 个结果", data.elements.len());

        let mut pois = Vec::new();
        for element in data.elements {
            // 获取坐标（节点直接有，way/relation 使用 center）
            let (lat, lon) = if let (Some(lat), Some(lon)) = (element.lat, element.lon) {
                (lat, lon)
            } else if let Some(center) = element.center {
                (center.lat, center.lon)
            } else {
                continue; // 没有坐标，跳过
            };

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
