use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use once_cell::sync::Lazy;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionConfig {
    pub name: String,
    pub admin_code: String,
    pub city_code: String,
    pub bounds: Bounds,
    pub center: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bounds {
    pub min_lon: f64,
    pub max_lon: f64,
    pub min_lat: f64,
    pub max_lat: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionPreset {
    pub id: String,
    pub name: String,
    pub admin_code: String,
}

pub static PRESET_REGIONS: Lazy<HashMap<String, RegionConfig>> = Lazy::new(|| {
    let mut m = HashMap::new();
    
    m.insert("funing".to_string(), RegionConfig {
        name: "阜宁县".to_string(),
        admin_code: "320923".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.42, max_lon: 119.95, min_lat: 33.55, max_lat: 33.95 },
        center: Some((119.8, 33.78)),
    });
    
    m.insert("sheyang".to_string(), RegionConfig {
        name: "射阳县".to_string(),
        admin_code: "320924".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.75, max_lon: 120.45, min_lat: 33.60, max_lat: 34.10 },
        center: Some((120.13, 33.85)),
    });
    
    m.insert("jianhu".to_string(), RegionConfig {
        name: "建湖县".to_string(),
        admin_code: "320925".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.65, max_lon: 120.05, min_lat: 33.35, max_lat: 33.65 },
        center: Some((119.8, 33.47)),
    });
    
    m.insert("binhai".to_string(), RegionConfig {
        name: "滨海县".to_string(),
        admin_code: "320922".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.65, max_lon: 120.30, min_lat: 33.90, max_lat: 34.35 },
        center: Some((119.95, 34.10)),
    });
    
    m.insert("xiangshui".to_string(), RegionConfig {
        name: "响水县".to_string(),
        admin_code: "320921".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.50, max_lon: 120.10, min_lat: 34.05, max_lat: 34.50 },
        center: Some((119.85, 34.20)),
    });
    
    m.insert("yancheng".to_string(), RegionConfig {
        name: "盐城市".to_string(),
        admin_code: "320900".to_string(),
        city_code: "320900".to_string(),
        bounds: Bounds { min_lon: 119.25, max_lon: 120.95, min_lat: 32.80, max_lat: 34.60 },
        center: Some((120.15, 33.35)),
    });
    
    m.insert("nanjing".to_string(), RegionConfig {
        name: "南京市".to_string(),
        admin_code: "320100".to_string(),
        city_code: "320100".to_string(),
        bounds: Bounds { min_lon: 118.35, max_lon: 119.25, min_lat: 31.20, max_lat: 32.60 },
        center: Some((118.80, 32.06)),
    });
    
    m.insert("suzhou".to_string(), RegionConfig {
        name: "苏州市".to_string(),
        admin_code: "320500".to_string(),
        city_code: "320500".to_string(),
        bounds: Bounds { min_lon: 120.05, max_lon: 121.35, min_lat: 30.75, max_lat: 32.05 },
        center: Some((120.62, 31.30)),
    });
    
    m
});

fn config_path() -> PathBuf {
    PathBuf::from("region_config.json")
}

pub fn get_current_region() -> Result<RegionConfig, String> {
    let path = config_path();
    
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    } else {
        // Return default
        Ok(PRESET_REGIONS.get("funing").cloned().unwrap())
    }
}

pub fn set_region(config: RegionConfig) -> Result<(), String> {
    let path = config_path();
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}
