use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::config::{RegionConfig, PRESET_REGIONS, get_current_region, set_region};
use crate::database::Database;
use crate::collectors::{
    TianDiTuCollector, AmapCollector, BaiduCollector,
    Collector, RegionConfig as CollectorRegionConfig, Bounds, default_categories,
};

// Global state
static DB: Lazy<Mutex<Database>> = Lazy::new(|| {
    Mutex::new(Database::new("poi_data.db").expect("Failed to init database"))
});

static COLLECTOR_STATUSES: Lazy<Mutex<HashMap<String, CollectorStatus>>> = 
    Lazy::new(|| Mutex::new(HashMap::new()));

// 停止标志
static STOP_FLAGS: Lazy<Mutex<HashMap<String, AtomicBool>>> = 
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

fn get_poi_categories() -> Vec<Category> {
    default_categories().into_iter().map(|c| Category {
        id: c.id,
        name: c.name,
        keywords: c.keywords,
    }).collect()
}

fn update_status(platform: &str, f: impl FnOnce(&mut CollectorStatus)) {
    if let Ok(mut statuses) = COLLECTOR_STATUSES.lock() {
        if let Some(status) = statuses.get_mut(platform) {
            f(status);
        }
    }
}

fn should_stop(platform: &str) -> bool {
    if let Ok(flags) = STOP_FLAGS.lock() {
        if let Some(flag) = flags.get(platform) {
            return flag.load(Ordering::Relaxed);
        }
    }
    false
}

fn emit_log(app: &AppHandle, message: &str) {
    let _ = app.emit("collector-log", message);
}

// Tauri Commands

#[tauri::command]
pub fn get_stats() -> Result<Stats, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.get_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_region_config() -> Result<RegionConfig, String> {
    get_current_region()
}

#[tauri::command]
pub fn get_region_presets() -> Vec<RegionPreset> {
    PRESET_REGIONS.iter().map(|(id, r)| RegionPreset {
        id: id.clone(),
        name: r.name.clone(),
        admin_code: r.admin_code.clone(),
    }).collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct RegionPreset {
    pub id: String,
    pub name: String,
    pub admin_code: String,
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
pub fn start_collector(
    app: AppHandle,
    platform: String, 
    categories: Option<Vec<String>>,
    regions: Option<Vec<String>>,
) -> Result<(), String> {
    // 检查是否已在运行
    {
        let statuses = COLLECTOR_STATUSES.lock().map_err(|e| e.to_string())?;
        if let Some(status) = statuses.get(&platform) {
            if status.status == "running" {
                return Err("采集器已在运行中".to_string());
            }
        }
    }

    // 获取 API Key
    let api_key = {
        let db = DB.lock().map_err(|e| e.to_string())?;
        let keys = db.get_all_api_keys().map_err(|e| e.to_string())?;
        let platform_keys = keys.get(&platform).cloned().unwrap_or_default();
        platform_keys.into_iter()
            .find(|k| k.is_active && !k.quota_exhausted)
            .map(|k| k.api_key)
            .ok_or_else(|| format!("{}没有可用的 API Key", platform))?
    };

    // 获取区域配置
    let region_config = get_current_region()?;
    let collector_region = CollectorRegionConfig {
        name: region_config.name.clone(),
        admin_code: region_config.admin_code.clone(),
        city_code: region_config.city_code.clone(),
        bounds: Bounds {
            min_lon: region_config.bounds.min_lon,
            max_lon: region_config.bounds.max_lon,
            min_lat: region_config.bounds.min_lat,
            max_lat: region_config.bounds.max_lat,
        },
    };

    // 获取选中的类别
    let all_categories = get_poi_categories();
    let selected_cats: Vec<Category> = match categories {
        Some(ids) => all_categories.into_iter()
            .filter(|c| ids.contains(&c.id))
            .collect(),
        None => all_categories,
    };

    if selected_cats.is_empty() {
        return Err("未选择采集类别".to_string());
    }

    // 初始化状态
    {
        let mut statuses = COLLECTOR_STATUSES.lock().map_err(|e| e.to_string())?;
        statuses.insert(platform.clone(), CollectorStatus {
            platform: platform.clone(),
            status: "running".to_string(),
            total_collected: 0,
            completed_categories: vec![],
            current_category_id: String::new(),
            error_message: None,
        });
    }

    // 设置停止标志
    {
        let mut flags = STOP_FLAGS.lock().map_err(|e| e.to_string())?;
        flags.insert(platform.clone(), AtomicBool::new(false));
    }

    // 启动后台线程
    let platform_clone = platform.clone();
    thread::spawn(move || {
        run_collector(app, platform_clone, api_key, collector_region, selected_cats);
    });

    log::info!("Started collector for platform: {}", platform);
    Ok(())
}

fn run_collector(
    app: AppHandle,
    platform: String,
    api_key: String,
    region: CollectorRegionConfig,
    categories: Vec<Category>,
) {
    emit_log(&app, &format!("[{}] 开始采集...", platform));

    // 创建采集器
    let mut collector: Box<dyn Collector> = match platform.as_str() {
        "tianditu" => Box::new(TianDiTuCollector::new(api_key)),
        "amap" => Box::new(AmapCollector::new(api_key)),
        "baidu" => Box::new(BaiduCollector::new(api_key)),
        _ => {
            update_status(&platform, |s| {
                s.status = "error".to_string();
                s.error_message = Some("不支持的平台".to_string());
            });
            return;
        }
    };

    collector.set_region(region);

    let mut total_collected: i64 = 0;
    let mut completed_categories: Vec<String> = vec![];

    for cat in &categories {
        if should_stop(&platform) {
            emit_log(&app, &format!("[{}] 采集已暂停", platform));
            update_status(&platform, |s| {
                s.status = "paused".to_string();
            });
            return;
        }

        update_status(&platform, |s| {
            s.current_category_id = cat.id.clone();
        });

        emit_log(&app, &format!("[{}] 采集类别: {}", platform, cat.name));

        for keyword in &cat.keywords {
            if should_stop(&platform) {
                return;
            }

            let mut page = 1;
            loop {
                if should_stop(&platform) {
                    return;
                }

                // 限流：每次请求间隔 500ms
                thread::sleep(Duration::from_millis(500));

                match collector.search_poi(keyword, page, &cat.name, &cat.id) {
                    Ok((pois, has_more)) => {
                        if pois.is_empty() {
                            break;
                        }

                        // 保存到数据库
                        let saved = {
                            if let Ok(db) = DB.lock() {
                                let mut count = 0;
                                for poi in &pois {
                                    match db.insert_poi(
                                        &poi.name,
                                        poi.lon,
                                        poi.lat,
                                        poi.original_lon,
                                        poi.original_lat,
                                        &cat.name,
                                        &cat.id,
                                        &poi.address,
                                        &poi.phone,
                                        &poi.platform,
                                        &poi.raw_data,
                                    ) {
                                        Ok(true) => count += 1,
                                        Ok(false) => {} // 重复数据，忽略
                                        Err(e) => {
                                            log::warn!("插入 POI 失败: {}", e);
                                        }
                                    }
                                }
                                count
                            } else {
                                log::error!("无法获取数据库锁");
                                0
                            }
                        };

                        total_collected += saved;

                        emit_log(&app, &format!(
                            "[{}] {} 第{}页: 获取{}条, 新增{}条",
                            platform, keyword, page, pois.len(), saved
                        ));

                        update_status(&platform, |s| {
                            s.total_collected = total_collected;
                        });

                        if !has_more {
                            break;
                        }
                        page += 1;
                    }
                    Err(e) => {
                        emit_log(&app, &format!("[{}] 采集错误: {}", platform, e));
                        // 配额错误时停止
                        if e.contains("配额") {
                            update_status(&platform, |s| {
                                s.status = "error".to_string();
                                s.error_message = Some(e);
                            });
                            return;
                        }
                        break;
                    }
                }
            }
        }

        completed_categories.push(cat.id.clone());
        update_status(&platform, |s| {
            s.completed_categories = completed_categories.clone();
        });
    }

    emit_log(&app, &format!("[{}] 采集完成，共{}条", platform, total_collected));
    update_status(&platform, |s| {
        s.status = "completed".to_string();
        s.current_category_id = String::new();
    });
}

#[tauri::command]
pub fn stop_collector(platform: String) -> Result<(), String> {
    // 设置停止标志
    if let Ok(flags) = STOP_FLAGS.lock() {
        if let Some(flag) = flags.get(&platform) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    
    update_status(&platform, |s| {
        s.status = "paused".to_string();
    });
    
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

// 行政区划相关命令
use crate::regions;

#[tauri::command]
pub fn get_regions() -> Vec<regions::Region> {
    regions::get_all_regions().clone()
}

#[tauri::command]
pub fn get_provinces() -> Vec<regions::Region> {
    regions::get_provinces()
}

#[tauri::command]
pub fn get_region_children(parent_code: String) -> Vec<regions::Region> {
    regions::get_children(&parent_code)
}

#[tauri::command]
pub fn search_regions(query: String) -> Vec<regions::Region> {
    regions::search_regions(&query)
}

#[tauri::command]
pub fn get_district_codes_for_region(code: String) -> Vec<String> {
    regions::get_all_district_codes(&code)
}
