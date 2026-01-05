//! 高德地图 POI 采集器

use super::{Collector, POIData, RegionConfig};
use crate::coords::amap_to_wgs84;
use reqwest::blocking::Client;
use serde_json::Value;

pub struct AmapCollector {
    api_key: String,
    client: Client,
    region: Option<RegionConfig>,
}

impl AmapCollector {
    const API_URL: &'static str = "https://restapi.amap.com/v3/place/text";
    const PAGE_SIZE: i32 = 25;

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
        let location = raw.get("location")?.as_str()?;
        let parts: Vec<&str> = location.split(',').collect();
        if parts.len() != 2 {
            return None;
        }

        let gcj_lon: f64 = parts[0].parse().ok()?;
        let gcj_lat: f64 = parts[1].parse().ok()?;

        // GCJ02 转 WGS84
        let (wgs_lon, wgs_lat) = amap_to_wgs84(gcj_lon, gcj_lat);

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

        // 地址和电话可能是数组或字符串
        let address = match raw.get("address") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };

        let phone = match raw.get("tel") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };

        Some(POIData {
            name: name.to_string(),
            lon: wgs_lon,
            lat: wgs_lat,
            original_lon: gcj_lon,
            original_lat: gcj_lat,
            category: category.to_string(),
            category_id: category_id.to_string(),
            address,
            phone,
            platform: "amap".to_string(),
            raw_data: raw.to_string(),
        })
    }
}

impl Collector for AmapCollector {
    fn platform(&self) -> &'static str {
        "amap"
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
                ("key", self.api_key.as_str()),
                ("keywords", keyword),
                ("city", &region.city_code),
                ("citylimit", "true"),
                ("offset", &Self::PAGE_SIZE.to_string()),
                ("page", &page.to_string()),
                ("extensions", "all"),
            ])
            .send()
            .map_err(|e| format!("请求失败: {}", e))?;

        if response.status() == 429 {
            return Err("请求过于频繁 (429)".to_string());
        }

        let data: Value = response.json()
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 检查响应状态
        let status = data.get("status").and_then(|s| s.as_str()).unwrap_or("0");
        if status != "1" {
            if self.is_quota_error(&data) {
                return Err("API配额已耗尽".to_string());
            }
            return Ok((vec![], false));
        }

        let pois = data.get("pois").and_then(|p| p.as_array()).cloned().unwrap_or_default();
        let total: i64 = data.get("count")
            .and_then(|c| c.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let parsed: Vec<POIData> = pois.iter()
            .filter_map(|raw| self.parse_poi_from_json(raw, "", ""))
            .collect();

        let has_more = (page as i64 * Self::PAGE_SIZE as i64) < total 
            && pois.len() >= Self::PAGE_SIZE as usize;

        Ok((parsed, has_more))
    }

    fn is_quota_error(&self, response: &Value) -> bool {
        if response.get("status").and_then(|s| s.as_str()) == Some("0") {
            let infocode = response.get("infocode").and_then(|c| c.as_str()).unwrap_or("");
            return matches!(infocode, "10003" | "10004" | "10005" | "10009" | "10044");
        }
        false
    }
}
