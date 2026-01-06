//! 天地图 POI 采集器

use super::{Bounds, Collector, POIData, RegionConfig};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub struct TianDiTuCollector {
    api_key: String,
    client: Client,
    region: Option<RegionConfig>,
}

#[derive(Debug, Serialize)]
struct SearchParams {
    #[serde(rename = "keyWord")]
    keyword: String,
    level: i32,
    #[serde(rename = "mapBound")]
    map_bound: String,
    #[serde(rename = "queryType")]
    query_type: i32,
    start: i32,
    count: i32,
}

impl TianDiTuCollector {
    const API_URL: &'static str = "http://api.tianditu.gov.cn/v2/search";
    const PAGE_SIZE: i32 = 100;

    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            region: None,
        }
    }

    fn parse_poi_from_json(&self, raw: &Value, category: &str, category_id: &str) -> Option<POIData> {
        let lonlat = raw.get("lonlat")?.as_str()?;
        let parts: Vec<&str> = lonlat.split(',').collect();
        if parts.len() != 2 {
            return None;
        }

        let lon: f64 = parts[0].parse().ok()?;
        let lat: f64 = parts[1].parse().ok()?;

        // 检查是否在区域范围内
        if let Some(ref region) = self.region {
            let bounds = &region.bounds;
            if lon < bounds.min_lon || lon > bounds.max_lon ||
               lat < bounds.min_lat || lat > bounds.max_lat {
                return None;
            }
        }

        let name = raw.get("name")?.as_str()?.trim();
        if name.is_empty() {
            return None;
        }

        Some(POIData {
            name: name.to_string(),
            lon,
            lat,
            original_lon: lon,
            original_lat: lat,
            category: category.to_string(),
            category_id: category_id.to_string(),
            address: raw.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            phone: raw.get("phone").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            platform: "tianditu".to_string(),
            raw_data: raw.to_string(),
        })
    }
}

impl Collector for TianDiTuCollector {
    fn platform(&self) -> &'static str {
        "tianditu"
    }

    fn set_api_key(&mut self, key: String) {
        self.api_key = key;
    }

    fn set_region(&mut self, region: RegionConfig) {
        self.region = Some(region);
    }

    fn search_poi(&self, keyword: &str, page: usize, category_name: &str, category_id: &str) -> Result<(Vec<POIData>, bool), String> {
        let region = self.region.as_ref().ok_or("未设置区域配置")?;
        let bounds = &region.bounds;

        // 在关键词前加上区域名称提高精确度
        let search_keyword = format!("{} {}", region.name, keyword);

        let search_params = SearchParams {
            keyword: search_keyword,
            level: 12,
            map_bound: format!(
                "{},{},{},{}",
                bounds.min_lon, bounds.min_lat, bounds.max_lon, bounds.max_lat
            ),
            query_type: 1,
            start: ((page - 1) * Self::PAGE_SIZE as usize) as i32,
            count: Self::PAGE_SIZE,
        };

        let post_str = serde_json::to_string(&search_params)
            .map_err(|e| format!("序列化参数失败: {}", e))?;

        let response = self.client
            .get(Self::API_URL)
            .query(&[
                ("postStr", post_str.as_str()),
                ("type", "query"),
                ("tk", &self.api_key),
            ])
            .send()
            .map_err(|e| format!("请求失败: {}", e))?;

        if response.status() == 429 {
            return Err("请求过于频繁 (429)".to_string());
        }

        let data: Value = response.json()
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 检查响应状态
        let status = data.get("status").and_then(|s| s.get("infocode"))
            .and_then(|c| c.as_i64()).unwrap_or(0);

        if status != 1000 {
            if self.is_quota_error(&data) {
                return Err("API配额已耗尽".to_string());
            }
            return Ok((vec![], false));
        }

        let pois = data.get("pois").and_then(|p| p.as_array()).cloned().unwrap_or_default();

        let parsed: Vec<POIData> = pois.iter()
            .filter_map(|raw| self.parse_poi_from_json(raw, category_name, category_id))
            .collect();

        let has_more = pois.len() >= Self::PAGE_SIZE as usize;
        Ok((parsed, has_more))
    }

    fn is_quota_error(&self, response: &Value) -> bool {
        let infocode = response.get("status")
            .and_then(|s| s.get("infocode"))
            .and_then(|c| c.as_i64())
            .unwrap_or(0);
        
        matches!(infocode, 10001 | 10002 | 10003)
    }
}
