use once_cell::sync::Lazy;
use parking_lot::RwLock;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
});

// 边界缓存
static BOUNDARY_CACHE: Lazy<RwLock<HashMap<String, Value>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionBounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryResult {
    pub geojson: Value,
    pub bounds: RegionBounds,
}

/// 从阿里云 DataV.GeoAtlas 获取行政区边界
/// API: https://geo.datav.aliyun.com/areas_v3/bound/{code}_full.json
#[tauri::command]
pub async fn get_region_boundary(region_code: String) -> Result<BoundaryResult, String> {
    // 检查缓存
    {
        let cache = BOUNDARY_CACHE.read();
        if let Some(geojson) = cache.get(&region_code) {
            let bounds = extract_bounds(geojson);
            return Ok(BoundaryResult {
                geojson: geojson.clone(),
                bounds,
            });
        }
    }

    // 根据代码长度确定 URL
    // 省级(2位)、市级(4位)用 _full.json，区县级(6位)用 .json
    let url = if region_code.len() <= 4 {
        format!(
            "https://geo.datav.aliyun.com/areas_v3/bound/{}_full.json",
            region_code
        )
    } else {
        format!(
            "https://geo.datav.aliyun.com/areas_v3/bound/{}.json",
            region_code
        )
    };

    log::info!("获取行政区边界: {} -> {}", region_code, url);

    let response = HTTP_CLIENT
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("请求边界数据失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("获取边界失败: HTTP {}", response.status()));
    }

    let geojson: Value = response
        .json()
        .await
        .map_err(|e| format!("解析边界数据失败: {}", e))?;

    // 计算边界框
    let bounds = extract_bounds(&geojson);

    // 存入缓存
    {
        let mut cache = BOUNDARY_CACHE.write();
        cache.insert(region_code, geojson.clone());
    }

    Ok(BoundaryResult { geojson, bounds })
}

/// 从 GeoJSON 提取边界框
fn extract_bounds(geojson: &Value) -> RegionBounds {
    let mut min_lon = 180.0_f64;
    let mut max_lon = -180.0_f64;
    let mut min_lat = 90.0_f64;
    let mut max_lat = -90.0_f64;

    // 递归提取所有坐标
    fn extract_coords(value: &Value, coords: &mut Vec<(f64, f64)>) {
        match value {
            Value::Array(arr) => {
                // 检查是否是坐标对 [lon, lat]
                if arr.len() == 2 {
                    if let (Some(lon), Some(lat)) = (
                        arr[0].as_f64(),
                        arr[1].as_f64(),
                    ) {
                        // 看起来像坐标对
                        if lon >= -180.0 && lon <= 180.0 && lat >= -90.0 && lat <= 90.0 {
                            coords.push((lon, lat));
                            return;
                        }
                    }
                }
                // 递归处理数组元素
                for item in arr {
                    extract_coords(item, coords);
                }
            }
            Value::Object(obj) => {
                // 处理 GeoJSON 结构
                if let Some(features) = obj.get("features") {
                    extract_coords(features, coords);
                }
                if let Some(geometry) = obj.get("geometry") {
                    extract_coords(geometry, coords);
                }
                if let Some(coordinates) = obj.get("coordinates") {
                    extract_coords(coordinates, coords);
                }
            }
            _ => {}
        }
    }

    let mut coords = Vec::new();
    extract_coords(geojson, &mut coords);

    for (lon, lat) in coords {
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
    }

    RegionBounds {
        north: max_lat,
        south: min_lat,
        east: max_lon,
        west: min_lon,
    }
}

/// 清除边界缓存
#[tauri::command]
pub fn clear_boundary_cache() {
    let mut cache = BOUNDARY_CACHE.write();
    cache.clear();
    log::info!("边界缓存已清除");
}
