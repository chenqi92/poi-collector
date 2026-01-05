//! 百度地图 POI 采集器

use super::{Collector, POIData, RegionConfig};
use crate::coords::bd09_to_wgs84;
use reqwest::blocking::Client;
use serde_json::Value;

pub struct BaiduCollector {
    api_key: String,
    client: Client,
    region: Option<RegionConfig>,
}

impl BaiduCollector {
    const API_URL: &'static str = "https://api.map.baidu.com/place/v2/search";
    const PAGE_SIZE: i32 = 20;

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
        let location = raw.get("location")?;
        let bd_lon = location.get("lng")?.as_f64()?;
        let bd_lat = location.get("lat")?.as_f64()?;

        if bd_lon == 0.0 || bd_lat == 0.0 {
            return None;
        }

        // BD09 转 WGS84
        let (wgs_lon, wgs_lat) = bd09_to_wgs84(bd_lon, bd_lat);

        // 检查是否在区域范围内
        if let Some(ref region) = self.region {
            let bounds = &region.bounds;
            if wgs_lon < bounds.min_lon || wgs_lon > bounds.max_lon ||
               wgs_lat < bounds.min_lat || wgs_lat > bounds.max_lat {
                return None;
            }
        }

        let name = raw.get("name")?.as_str()?.trim();
        if name.is_empty() {
            return None;
        }

        Some(POIData {
            name: name.to_string(),
            lon: wgs_lon,
            lat: wgs_lat,
            original_lon: bd_lon,
            original_lat: bd_lat,
            category: category.to_string(),
            category_id: category_id.to_string(),
            address: raw.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            phone: raw.get("telephone").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            platform: "baidu".to_string(),
            raw_data: raw.to_string(),
        })
    }
}

impl Collector for BaiduCollector {
    fn platform(&self) -> &'static str {
        "baidu"
    }

    fn set_api_key(&mut self, key: String) {
        self.api_key = key;
    }

    fn set_region(&mut self, region: RegionConfig) {
        self.region = Some(region);
    }

    fn search_poi(&self, keyword: &str, page: usize) -> Result<(Vec<POIData>, bool), String> {
        let region = self.region.as_ref().ok_or("未设置区域配置")?;

        let response = self.client
            .get(Self::API_URL)
            .query(&[
                ("ak", self.api_key.as_str()),
                ("query", keyword),
                ("region", &region.name),
                ("city_limit", "true"),
                ("output", "json"),
                ("page_size", &Self::PAGE_SIZE.to_string()),
                ("page_num", &(page - 1).to_string()),
                ("scope", "2"),
            ])
            .send()
            .map_err(|e| format!("请求失败: {}", e))?;

        if response.status() == 429 {
            return Err("请求过于频繁 (429)".to_string());
        }

        let data: Value = response.json()
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 检查响应状态
        let status = data.get("status").and_then(|s| s.as_i64()).unwrap_or(-1);
        if status != 0 {
            if self.is_quota_error(&data) {
                return Err("API配额已耗尽".to_string());
            }
            return Ok((vec![], false));
        }

        let pois = data.get("results").and_then(|p| p.as_array()).cloned().unwrap_or_default();
        let total = data.get("total").and_then(|t| t.as_i64()).unwrap_or(0);

        let parsed: Vec<POIData> = pois.iter()
            .filter_map(|raw| self.parse_poi_from_json(raw, "", ""))
            .collect();

        let has_more = (page as i64 * Self::PAGE_SIZE as i64) < total 
            && pois.len() >= Self::PAGE_SIZE as usize;

        Ok((parsed, has_more))
    }

    fn is_quota_error(&self, response: &Value) -> bool {
        let status = response.get("status").and_then(|s| s.as_i64()).unwrap_or(0);
        matches!(status, 302 | 401 | 402 | 4)
    }
}
