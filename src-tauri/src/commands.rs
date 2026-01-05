use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

use crate::config::{RegionConfig, PRESET_REGIONS, get_current_region, set_region};
use crate::database::Database;

// Global state
static DB: Lazy<Mutex<Database>> = Lazy::new(|| {
    Mutex::new(Database::new("poi_data.db").expect("Failed to init database"))
});

static COLLECTOR_STATUSES: Lazy<Mutex<HashMap<String, CollectorStatus>>> = 
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorStatus {
    pub platform: String,
    pub status: String,
    pub total_collected: i64,
    pub completed_categories: Vec<String>,
    pub current_category_id: String,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: i64,
    pub name: String,
    pub api_key: String,
    pub is_active: bool,
    pub quota_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct POI {
    pub id: i64,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub address: String,
    pub category: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total: i64,
    pub by_platform: HashMap<String, i64>,
    pub by_category: HashMap<String, i64>,
}

// POI Categories
pub fn get_poi_categories() -> Vec<Category> {
    vec![
        Category { id: "residential".into(), name: "住宅小区".into(), keywords: vec!["小区", "花园", "家园", "公寓"].into_iter().map(String::from).collect() },
        Category { id: "commercial".into(), name: "商业楼盘".into(), keywords: vec!["广场", "中心", "大厦", "商城"].into_iter().map(String::from).collect() },
        Category { id: "school".into(), name: "学校".into(), keywords: vec!["学校", "小学", "中学", "大学", "幼儿园"].into_iter().map(String::from).collect() },
        Category { id: "hospital".into(), name: "医疗".into(), keywords: vec!["医院", "诊所", "卫生院", "药店"].into_iter().map(String::from).collect() },
        Category { id: "government".into(), name: "政府".into(), keywords: vec!["政府", "派出所", "法院", "街道办"].into_iter().map(String::from).collect() },
        Category { id: "transport".into(), name: "交通".into(), keywords: vec!["汽车站", "火车站", "公交站", "加油站"].into_iter().map(String::from).collect() },
        Category { id: "business".into(), name: "商业服务".into(), keywords: vec!["超市", "商场", "银行", "酒店"].into_iter().map(String::from).collect() },
        Category { id: "entertainment".into(), name: "休闲娱乐".into(), keywords: vec!["电影院", "KTV", "健身房", "咖啡厅"].into_iter().map(String::from).collect() },
        Category { id: "nature".into(), name: "自然地貌".into(), keywords: vec!["湖", "河", "公园", "景区"].into_iter().map(String::from).collect() },
        Category { id: "admin".into(), name: "行政区划".into(), keywords: vec!["镇", "乡", "村", "社区"].into_iter().map(String::from).collect() },
        Category { id: "landmark".into(), name: "地标建筑".into(), keywords: vec!["塔", "桥", "体育馆", "博物馆"].into_iter().map(String::from).collect() },
        Category { id: "industrial".into(), name: "工业园区".into(), keywords: vec!["工业园", "产业园", "工厂", "仓库"].into_iter().map(String::from).collect() },
        Category { id: "agriculture".into(), name: "农业设施".into(), keywords: vec!["农场", "果园", "大棚", "养殖场"].into_iter().map(String::from).collect() },
        Category { id: "municipal".into(), name: "市政设施".into(), keywords: vec!["变电站", "水厂", "消防站"].into_iter().map(String::from).collect() },
        Category { id: "public_service".into(), name: "公共服务".into(), keywords: vec!["邮局", "快递站", "社区服务中心"].into_iter().map(String::from).collect() },
        Category { id: "religious".into(), name: "宗教场所".into(), keywords: vec!["寺庙", "教堂", "道观"].into_iter().map(String::from).collect() },
    ]
}

// ============ Commands ============

#[tauri::command]
pub fn get_stats() -> Result<Stats, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.get_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_region_config() -> Result<RegionConfig, String> {
    get_current_region().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_region_presets() -> Vec<crate::config::RegionPreset> {
    PRESET_REGIONS.iter().map(|(id, r)| crate::config::RegionPreset {
        id: id.clone(),
        name: r.name.clone(),
        admin_code: r.admin_code.clone(),
    }).collect()
}

#[tauri::command]
pub fn set_region_by_preset(preset_id: String) -> Result<RegionConfig, String> {
    let preset = PRESET_REGIONS.get(&preset_id)
        .ok_or_else(|| "Invalid preset ID".to_string())?;
    set_region(preset.clone()).map_err(|e| e.to_string())?;
    Ok(preset.clone())
}

#[tauri::command]
pub fn get_api_keys() -> Result<HashMap<String, Vec<ApiKey>>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.get_all_api_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_api_key(platform: String, api_key: String, name: Option<String>) -> Result<i64, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.add_api_key(&platform, &api_key, name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(platform: String, key_id: i64) -> Result<(), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.delete_api_key(key_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_categories() -> Vec<Category> {
    get_poi_categories()
}

#[tauri::command]
pub fn get_collector_statuses() -> HashMap<String, CollectorStatus> {
    COLLECTOR_STATUSES.lock().unwrap().clone()
}

#[tauri::command]
pub fn start_collector(platform: String, categories: Option<Vec<String>>) -> Result<(), String> {
    let mut statuses = COLLECTOR_STATUSES.lock().map_err(|e| e.to_string())?;
    
    if let Some(status) = statuses.get(&platform) {
        if status.status == "running" {
            return Err("Collector is already running".to_string());
        }
    }

    statuses.insert(platform.clone(), CollectorStatus {
        platform: platform.clone(),
        status: "running".to_string(),
        total_collected: 0,
        completed_categories: vec![],
        current_category_id: String::new(),
        error_message: None,
    });

    // TODO: Spawn collector task
    log::info!("Started collector for platform: {}", platform);
    
    Ok(())
}

#[tauri::command]
pub fn stop_collector(platform: String) -> Result<(), String> {
    let mut statuses = COLLECTOR_STATUSES.lock().map_err(|e| e.to_string())?;
    
    if let Some(status) = statuses.get_mut(&platform) {
        status.status = "paused".to_string();
    }
    
    Ok(())
}

#[tauri::command]
pub fn reset_collector(platform: String) -> Result<(), String> {
    let mut statuses = COLLECTOR_STATUSES.lock().map_err(|e| e.to_string())?;
    
    statuses.insert(platform.clone(), CollectorStatus {
        platform,
        status: "idle".to_string(),
        total_collected: 0,
        completed_categories: vec![],
        current_category_id: String::new(),
        error_message: None,
    });
    
    Ok(())
}

#[tauri::command]
pub fn search_poi(query: String, platform: String, mode: String, limit: Option<i64>) -> Result<Vec<POI>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let platform_filter = if platform == "all" { None } else { Some(platform.as_str()) };
    db.search_poi(&query, platform_filter, &mode, limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

// ============ 行政区划命令 ============

#[tauri::command]
pub fn get_regions() -> Vec<crate::regions::Region> {
    crate::regions::get_all_regions().clone()
}

#[tauri::command]
pub fn get_provinces() -> Vec<crate::regions::Region> {
    crate::regions::get_provinces()
}

#[tauri::command]
pub fn get_region_children(parent_code: String) -> Vec<crate::regions::Region> {
    crate::regions::get_children(&parent_code)
}

#[tauri::command]
pub fn search_regions(query: String) -> Vec<crate::regions::Region> {
    crate::regions::search_regions(&query)
}

#[tauri::command]
pub fn get_district_codes_for_region(code: String) -> Vec<String> {
    crate::regions::get_all_district_codes(&code)
}
