use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::collectors::{
    default_categories, AmapCollector, BaiduCollector, Bounds, Collector, OsmCollector,
    RegionConfig as CollectorRegionConfig, TianDiTuCollector,
};
use crate::config::{get_current_region, set_region, RegionConfig, PRESET_REGIONS};
use crate::database::Database;

// Global state
static DB: Lazy<Mutex<Database>> =
    Lazy::new(|| Mutex::new(Database::new("poi_data.db").expect("Failed to init database")));

/// 只读连接池：search/extent/preview 这类纯查询走这里，避免阻塞写入。
/// WAL 模式下多读 + 单写互不阻塞，所以池里 4 把读连接基本能撑住界面所有并发查询。
static READ_POOL: Lazy<Mutex<Vec<rusqlite::Connection>>> = Lazy::new(|| {
    let mut pool = Vec::with_capacity(4);
    for _ in 0..4 {
        match rusqlite::Connection::open("poi_data.db") {
            Ok(c) => {
                let _ = c.execute_batch(
                    "PRAGMA journal_mode=WAL;
                     PRAGMA query_only=ON;
                     PRAGMA temp_store=MEMORY;
                     PRAGMA mmap_size=268435456;
                     PRAGMA cache_size=-32768;
                     PRAGMA busy_timeout=5000;",
                );
                pool.push(c);
            }
            Err(e) => log::warn!("read pool open failed: {}", e),
        }
    }
    Mutex::new(pool)
});

/// 从读连接池借一个 conn，闭包用完自动还回去；池里没有则回退到主写连接。
fn with_read_conn<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<R, String>,
{
    let conn_opt = {
        let mut pool = READ_POOL.lock().map_err(|e| e.to_string())?;
        pool.pop()
    };
    match conn_opt {
        Some(conn) => {
            let result = f(&conn);
            // 还回池
            if let Ok(mut pool) = READ_POOL.lock() {
                pool.push(conn);
            }
            result
        }
        None => {
            let db = DB.lock().map_err(|e| e.to_string())?;
            f(db.raw_conn())
        }
    }
}

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
    pub current_category_index: usize,
    pub total_categories: usize,
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
    pub phone: String,
    pub category: String,
    pub platform: String,
    pub region_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total: i64,
    pub by_platform: HashMap<String, i64>,
    pub by_category: HashMap<String, i64>,
}

fn get_poi_categories() -> Vec<Category> {
    default_categories()
        .into_iter()
        .map(|c| Category {
            id: c.id,
            name: c.name,
            keywords: c.keywords,
        })
        .collect()
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
    PRESET_REGIONS
        .iter()
        .map(|(id, r)| RegionPreset {
            id: id.clone(),
            name: r.name.clone(),
            admin_code: r.admin_code.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct RegionPreset {
    pub id: String,
    pub name: String,
    pub admin_code: String,
}

#[tauri::command]
pub fn set_region_by_preset(preset_id: String) -> Result<RegionConfig, String> {
    let preset = PRESET_REGIONS
        .get(&preset_id)
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
    db.add_api_key(&platform, &api_key, name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(_platform: String, key_id: i64) -> Result<(), String> {
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

    // 获取 API Key (OSM 不需要，使用免费的 Overpass API)
    let api_key = if platform == "osm" {
        String::new()
    } else {
        let db = DB.lock().map_err(|e| e.to_string())?;
        let keys = db.get_all_api_keys().map_err(|e| e.to_string())?;
        let platform_keys = keys.get(&platform).cloned().unwrap_or_default();
        platform_keys
            .into_iter()
            .find(|k| k.is_active && !k.quota_exhausted)
            .map(|k| k.api_key)
            .ok_or_else(|| format!("{}没有可用的 API Key", platform))?
    };

    // 获取区域配置 - 必须使用用户选择的地区
    let region_codes = regions.ok_or_else(|| "请先选择采集地区".to_string())?;
    if region_codes.is_empty() {
        return Err("请先选择采集地区".to_string());
    }

    // 使用第一个选中的区域
    let region_code = &region_codes[0];

    // 从 regions 模块获取区域信息
    let region_info = crate::regions::get_region_by_code(region_code)
        .ok_or_else(|| format!("未找到区域代码: {}", region_code))?;

    // 使用中国范围作为 bounds，让 API 按区域名称过滤
    let bounds = Bounds {
        min_lon: 73.0,
        max_lon: 135.0,
        min_lat: 18.0,
        max_lat: 54.0,
    };

    // 获取父级城市代码
    let city_code = if region_info.level == "district" {
        region_info
            .parent_code
            .clone()
            .unwrap_or_else(|| region_code.clone())
    } else {
        region_code.clone()
    };

    log::info!("使用区域: {} ({})", region_info.name, region_code);

    let collector_region = CollectorRegionConfig {
        name: region_info.name,
        admin_code: region_code.clone(),
        city_code,
        bounds,
    };

    // 获取选中的类别
    let all_categories = get_poi_categories();
    let selected_cats: Vec<Category> = match categories {
        Some(ids) => all_categories
            .into_iter()
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
        statuses.insert(
            platform.clone(),
            CollectorStatus {
                platform: platform.clone(),
                status: "running".to_string(),
                total_collected: 0,
                completed_categories: vec![],
                current_category_id: String::new(),
                current_category_index: 0,
                total_categories: selected_cats.len(),
                error_message: None,
            },
        );
    }

    // 设置停止标志
    {
        let mut flags = STOP_FLAGS.lock().map_err(|e| e.to_string())?;
        flags.insert(platform.clone(), AtomicBool::new(false));
    }

    // 启动后台线程
    let platform_clone = platform.clone();
    thread::spawn(move || {
        run_collector(
            app,
            platform_clone,
            api_key,
            collector_region,
            selected_cats,
        );
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

    // 创建 POI 采集任务记录
    let cat_names: Vec<String> = categories.iter().map(|c| c.name.clone()).collect();
    let poi_task_id = {
        if let Ok(db) = DB.lock() {
            db.create_poi_task(
                &platform,
                Some(&region.name),
                Some(&region.admin_code),
                &serde_json::to_string(&cat_names).unwrap_or_default(),
                categories.len() as i64,
            )
            .ok()
        } else {
            None
        }
    };

    // 创建采集器
    let mut collector: Box<dyn Collector> = match platform.as_str() {
        "tianditu" => Box::new(TianDiTuCollector::new(api_key)),
        "amap" => Box::new(AmapCollector::new(api_key)),
        "baidu" => Box::new(BaiduCollector::new(api_key)),
        "osm" => Box::new(OsmCollector::new()),
        _ => {
            update_status(&platform, |s| {
                s.status = "error".to_string();
                s.error_message = Some("不支持的平台".to_string());
            });
            if let Some(tid) = poi_task_id {
                if let Ok(db) = DB.lock() {
                    db.complete_poi_task(tid, "error", 0, Some("不支持的平台"))
                        .ok();
                }
            }
            return;
        }
    };

    // 保存区域代码用于数据库插入（region 会被 move）
    let region_code = region.admin_code.clone();
    collector.set_region(region);

    let mut total_collected: i64 = 0;
    let mut completed_categories: Vec<String> = vec![];

    for cat in &categories {
        if should_stop(&platform) {
            emit_log(&app, &format!("[{}] 采集已暂停", platform));
            update_status(&platform, |s| {
                s.status = "paused".to_string();
            });
            if let Some(tid) = poi_task_id {
                if let Ok(db) = DB.lock() {
                    db.complete_poi_task(tid, "cancelled", total_collected, None)
                        .ok();
                }
            }
            return;
        }

        update_status(&platform, |s| {
            s.current_category_id = cat.id.clone();
            s.current_category_index = completed_categories.len();
        });

        emit_log(&app, &format!("[{}] 采集类别: {}", platform, cat.name));

        for keyword in &cat.keywords {
            if should_stop(&platform) {
                if let Some(tid) = poi_task_id {
                    if let Ok(db) = DB.lock() {
                        db.complete_poi_task(tid, "cancelled", total_collected, None)
                            .ok();
                    }
                }
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
                                        &region_code,
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

                        emit_log(
                            &app,
                            &format!(
                                "[{}] {} 第{}页: 获取{}条, 新增{}条",
                                platform,
                                keyword,
                                page,
                                pois.len(),
                                saved
                            ),
                        );

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
                                s.error_message = Some(e.clone());
                            });
                            if let Some(tid) = poi_task_id {
                                if let Ok(db) = DB.lock() {
                                    db.complete_poi_task(tid, "error", total_collected, Some(&e))
                                        .ok();
                                }
                            }
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

        // 更新 POI 任务进度
        if let Some(tid) = poi_task_id {
            if let Ok(db) = DB.lock() {
                db.update_poi_task_progress(
                    tid,
                    completed_categories.len() as i64,
                    total_collected,
                )
                .ok();
            }
        }
    }

    emit_log(
        &app,
        &format!("[{}] 采集完成，共{}条", platform, total_collected),
    );
    update_status(&platform, |s| {
        s.status = "completed".to_string();
        s.current_category_id = String::new();
    });

    // 记录完成
    if let Some(tid) = poi_task_id {
        if let Ok(db) = DB.lock() {
            db.complete_poi_task(tid, "completed", total_collected, None)
                .ok();
        }
    }
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

    statuses.insert(
        platform.clone(),
        CollectorStatus {
            platform,
            status: "idle".to_string(),
            total_collected: 0,
            completed_categories: vec![],
            current_category_id: String::new(),
            current_category_index: 0,
            total_categories: 0,
            error_message: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn search_poi(
    query: String,
    platform: Option<String>,
    mode: String,
    limit: Option<i64>,
) -> Result<Vec<POI>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let platform_filter = platform
        .as_ref()
        .filter(|p| p.as_str() != "all")
        .map(|s| s.as_str());
    db.search_poi(&query, platform_filter, &mode, limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_poi_by_bounds(
    south: f64,
    west: f64,
    north: f64,
    east: f64,
    query: Option<String>,
    platform: Option<String>,
) -> Result<Vec<POI>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let query_filter = query
        .as_ref()
        .filter(|q| !q.trim().is_empty())
        .map(|s| s.as_str());
    let platform_filter = platform
        .as_ref()
        .filter(|p| p.as_str() != "all")
        .map(|s| s.as_str());
    db.get_poi_in_bounds(south, west, north, east, query_filter, platform_filter, 2000)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_buoys_by_bounds(
    south: f64,
    west: f64,
    north: f64,
    east: f64,
) -> Result<Vec<crate::chart_collector::types::BuoyInfo>, String> {
    use crate::chart_collector::commands::get_db_path;
    use crate::chart_collector::database::ChartDatabase;
    use crate::chart_collector::types::ChartBounds;
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_buoys_in_bounds(&ChartBounds {
        west,
        south,
        east,
        north,
    })
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

/// 默认下载目录：安装目录（exe 所在目录）下的 data 子目录
#[tauri::command]
pub fn get_default_download_dir() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    exe_dir.join("data").to_string_lossy().to_string()
}

// 导出相关命令
use crate::database::ExportPOI;

#[derive(Debug, Clone, Deserialize)]
pub struct PoiSearchFilters {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub bounds: Option<BoundsArg>,
    #[serde(default)]
    pub region_codes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BoundsArg {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Pagination {
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PoiPage {
    pub items: Vec<POI>,
    pub total: i64,
}

/// 综合过滤 + 分页查询。底层使用 FTS5 trigram 索引做文本搜索。
/// 走只读连接池，不阻塞写入。
#[tauri::command]
pub fn search_pois(
    filters: PoiSearchFilters,
    pagination: Pagination,
) -> Result<PoiPage, String> {
    let bounds_tuple = filters
        .bounds
        .as_ref()
        .map(|b| (b.south, b.west, b.north, b.east));
    let (items, total) = with_read_conn(|conn| {
        crate::database::Database::search_pois_filtered_conn(
            conn,
            filters.query.as_deref(),
            &filters.platforms,
            bounds_tuple,
            &filters.region_codes,
            pagination.limit.max(0),
            pagination.offset.max(0),
        )
        .map_err(|e| e.to_string())
    })?;
    Ok(PoiPage { items, total })
}

#[derive(Debug, Clone, Serialize)]
pub struct DataExtent {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

/// 返回 POI 数据外接矩形。用于地图首次 fit。
#[tauri::command]
pub fn get_poi_data_extent(platforms: Option<Vec<String>>) -> Result<Option<DataExtent>, String> {
    let pf = platforms.unwrap_or_default();
    let r = with_read_conn(|conn| {
        crate::database::Database::get_poi_extent_conn(conn, &pf).map_err(|e| e.to_string())
    })?;
    Ok(r.map(|(s, w, n, e)| DataExtent {
        south: s,
        west: w,
        north: n,
        east: e,
    }))
}

#[tauri::command]
pub fn get_all_poi_data(platform: Option<String>) -> Result<Vec<ExportPOI>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    let platform_filter = platform
        .as_ref()
        .filter(|p| p.as_str() != "all")
        .map(|s| s.as_str());
    db.get_all_poi(platform_filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_poi_to_file(
    path: String,
    format: String,
    filters: Option<PoiSearchFilters>,
) -> Result<usize, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;

    // 用过滤条件直接在 SQLite 内 SELECT 出符合的所有行，避免前端把 23k 全拉到 JS。
    let data: Vec<ExportPOI> = if let Some(f) = filters {
        let bounds_tuple = f.bounds.as_ref().map(|b| (b.south, b.west, b.north, b.east));
        db.search_export_pois_filtered(
            f.query.as_deref(),
            &f.platforms,
            bounds_tuple,
            &f.region_codes,
        )
        .map_err(|e| e.to_string())?
    } else {
        db.get_all_poi(None).map_err(|e| e.to_string())?
    };

    let count = data.len();

    match format.as_str() {
        "json" => {
            // JSON 导出，添加 UTF-8 BOM
            let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
            let mut json_bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
            json_bytes.extend_from_slice(json.as_bytes());
            std::fs::write(&path, json_bytes).map_err(|e| e.to_string())?;
        }
        "excel" => {
            // CSV 导出，添加 UTF-8 BOM 以便 Excel 正确识别中文
            let mut csv_bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
            csv_bytes.extend_from_slice("ID,名称,经度,纬度,地址,电话,类别,平台\n".as_bytes());
            for poi in &data {
                let line = format!(
                    "{},\"{}\",{},{},\"{}\",\"{}\",\"{}\",{}\n",
                    poi.id,
                    poi.name.replace("\"", "\"\""),
                    poi.lon,
                    poi.lat,
                    poi.address.replace("\"", "\"\""),
                    poi.phone.replace("\"", "\"\""),
                    poi.category.replace("\"", "\"\""),
                    poi.platform
                );
                csv_bytes.extend_from_slice(line.as_bytes());
            }
            std::fs::write(&path, csv_bytes).map_err(|e| e.to_string())?;
        }
        "mysql" => {
            // MySQL SQL 导出，添加 UTF-8 BOM
            let mut sql_bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
            let mut sql = String::new();
            sql.push_str("-- POI 数据导出\n");
            sql.push_str("-- 生成时间: ");
            sql.push_str(&chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
            sql.push_str("\n-- 编码: UTF-8\n\n");
            sql.push_str("SET NAMES utf8mb4;\n\n");
            sql.push_str("CREATE TABLE IF NOT EXISTS poi_data (\n");
            sql.push_str("  id BIGINT PRIMARY KEY,\n");
            sql.push_str("  name VARCHAR(255) NOT NULL,\n");
            sql.push_str("  lon DOUBLE NOT NULL,\n");
            sql.push_str("  lat DOUBLE NOT NULL,\n");
            sql.push_str("  address VARCHAR(500),\n");
            sql.push_str("  phone VARCHAR(100),\n");
            sql.push_str("  category VARCHAR(100),\n");
            sql.push_str("  platform VARCHAR(50)\n");
            sql.push_str(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n");

            for poi in &data {
                sql.push_str(&format!(
                    "INSERT INTO poi_data (id, name, lon, lat, address, phone, category, platform) VALUES ({}, '{}', {}, {}, '{}', '{}', '{}', '{}');\n",
                    poi.id,
                    poi.name.replace("'", "''"),
                    poi.lon,
                    poi.lat,
                    poi.address.replace("'", "''"),
                    poi.phone.replace("'", "''"),
                    poi.category.replace("'", "''"),
                    poi.platform
                ));
            }
            sql_bytes.extend_from_slice(sql.as_bytes());
            std::fs::write(&path, sql_bytes).map_err(|e| e.to_string())?;
        }
        _ => return Err("不支持的导出格式".to_string()),
    }

    Ok(count)
}

/// 修复缺失的 region_code 数据
#[tauri::command]
pub fn fix_region_codes() -> Result<(i64, i64), String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.fix_region_codes().map_err(|e| e.to_string())
}

/// 获取按 region_code 分组的 POI 统计
#[tauri::command]
pub fn get_poi_stats_by_region() -> Result<Vec<(String, i64)>, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.get_poi_stats_by_region().map_err(|e| e.to_string())
}

/// 根据 region_code 列表删除 POI
#[tauri::command]
pub fn delete_poi_by_regions(codes: Vec<String>) -> Result<usize, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.delete_poi_by_region_codes(&codes)
        .map_err(|e| e.to_string())
}

/// 清空所有 POI 数据
#[tauri::command]
pub fn clear_all_poi() -> Result<usize, String> {
    let db = DB.lock().map_err(|e| e.to_string())?;
    db.clear_all_poi().map_err(|e| e.to_string())
}

// === 统一任务历史 ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedTask {
    pub id: String,
    pub task_type: String,
    pub name: String,
    pub status: String,
    pub total: u64,
    pub completed: u64,
    pub failed: u64,
    pub platform: Option<String>,
    pub output_path: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
    pub extra: Option<String>,
}

/// 获取所有类型的任务历史
#[tauri::command]
pub fn get_all_task_history(app: AppHandle) -> Result<Vec<UnifiedTask>, String> {
    let mut tasks = Vec::new();

    // 1. POI 采集任务
    {
        // 实时采集状态（内存）按平台索引，用于覆盖 DB 中滞后的进度。
        let live = COLLECTOR_STATUSES
            .lock()
            .ok()
            .map(|m| m.clone())
            .unwrap_or_default();
        // 每个平台的实时状态只对应一条正在运行的任务（id 最大者）。
        let mut live_consumed: std::collections::HashSet<String> = std::collections::HashSet::new();

        let db = DB.lock().map_err(|e| e.to_string())?;
        if let Ok(poi_tasks) = db.get_poi_tasks() {
            for t in poi_tasks {
                let name = format!(
                    "{} - {}",
                    match t.platform.as_str() {
                        "amap" => "高德地图",
                        "baidu" => "百度地图",
                        "tianditu" => "天地图",
                        "osm" => "OpenStreetMap",
                        _ => &t.platform,
                    },
                    t.region_name.as_deref().unwrap_or("未知区域")
                );

                let mut status = t.status.clone();
                let mut completed = t.completed_categories as u64;
                let mut total_collected = t.total_collected;

                // DB 标记为 running/paused 时，用内存中的实时状态覆盖：
                // - 命中实时运行状态 → 用实时类别索引 + 实时采集条数
                // - 没有命中（上次会话残留的 running）→ 标记为 interrupted
                if t.status == "running" || t.status == "paused" {
                    match live.get(&t.platform) {
                        Some(s)
                            if !live_consumed.contains(&t.platform)
                                && (s.status == "running" || s.status == "paused") =>
                        {
                            live_consumed.insert(t.platform.clone());
                            status = s.status.clone();
                            completed = s.current_category_index as u64;
                            total_collected = s.total_collected;
                        }
                        _ => {
                            status = "interrupted".to_string();
                        }
                    }
                }

                tasks.push(UnifiedTask {
                    id: format!("poi_{}", t.id),
                    task_type: "poi".to_string(),
                    name,
                    status,
                    total: t.total_categories as u64,
                    completed,
                    failed: 0,
                    platform: Some(t.platform),
                    output_path: None,
                    created_at: t.created_at,
                    completed_at: t.completed_at,
                    extra: Some(
                        serde_json::json!({
                            "total_collected": total_collected,
                            "categories": t.categories,
                            "region_code": t.region_code,
                        })
                        .to_string(),
                    ),
                });
            }
        }
    }

    // 2. 航标采集任务
    {
        use crate::chart_collector::commands::get_db_path;
        use crate::chart_collector::database::ChartDatabase;
        if let Ok(chart_db) = ChartDatabase::new(&get_db_path()) {
            if let Ok(chart_tasks) = chart_db.get_chart_tasks() {
                for t in chart_tasks {
                    let name = format!("航标采集 - {}", t.task_type);
                    tasks.push(UnifiedTask {
                        id: format!("buoy_{}", t.id),
                        task_type: "buoy".to_string(),
                        name,
                        status: t.status,
                        total: t.total_items as u64,
                        completed: t.completed_items as u64,
                        failed: t.failed_items as u64,
                        platform: None,
                        output_path: t.output_path,
                        created_at: t.created_at,
                        completed_at: t.completed_at,
                        extra: Some(
                            serde_json::json!({
                                "layers": t.layers,
                                "zoom_levels": t.zoom_levels,
                                "bounds_west": t.bounds_west,
                                "bounds_south": t.bounds_south,
                                "bounds_east": t.bounds_east,
                                "bounds_north": t.bounds_north,
                                "grid_step": t.grid_step,
                            })
                            .to_string(),
                        ),
                    });
                }
            }
        }
    }

    // 3. 瓦片下载任务
    {
        use crate::tile_downloader::commands::get_tile_db;
        if let Ok(tile_db) = get_tile_db(&app) {
            if let Ok(tile_tasks) = tile_db.get_all_tasks() {
                for t in tile_tasks {
                    tasks.push(UnifiedTask {
                        id: format!("tile_{}", t.id),
                        task_type: "tile".to_string(),
                        name: t.name,
                        status: t.status,
                        total: t.total_tiles,
                        completed: t.completed_tiles,
                        failed: t.failed_tiles,
                        platform: Some(t.platform),
                        output_path: Some(t.output_path),
                        created_at: Some(t.created_at),
                        completed_at: t.completed_at,
                        extra: Some(
                            serde_json::json!({
                                "map_type": t.map_type,
                                "zoom_levels": t.zoom_levels,
                                "output_format": t.output_format,
                                "download_speed": t.download_speed,
                            })
                            .to_string(),
                        ),
                    });
                }
            }
        }
    }

    // 按创建时间排序（新的在前）
    tasks.sort_by(|a, b| {
        let a_time = a.created_at.as_deref().unwrap_or("");
        let b_time = b.created_at.as_deref().unwrap_or("");
        b_time.cmp(a_time)
    });

    Ok(tasks)
}
