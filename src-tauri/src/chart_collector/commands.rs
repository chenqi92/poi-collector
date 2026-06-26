//! Tauri 命令入口
//! 为前端暴露航道图采集相关的命令

use super::buoy_collector::BuoyCollector;
use super::composer::ChartComposer;
use super::database::ChartDatabase;
use super::feature_collector::FeatureCollector;
use super::tile_fetcher::{estimate_chart_tiles, ChartTileFetcher};
use super::types::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

/// 全局停止标志
static STOP_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// 全局任务状态
static TASK_STATUS: Lazy<RwLock<ChartTaskStatus>> =
    Lazy::new(|| RwLock::new(ChartTaskStatus::Idle));

/// 获取数据库路径
/// 解析后的 chart_data.db 路径（启动时定位到持久化的 app_data_dir）
static CHART_DB_PATH: Lazy<RwLock<Option<String>>> = Lazy::new(|| RwLock::new(None));

fn exe_db_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("chart_data.db")
}

pub fn get_db_path() -> String {
    if let Some(p) = CHART_DB_PATH.read().clone() {
        return p;
    }
    exe_db_path().to_string_lossy().to_string()
}

/// 把 chart_data.db 定位到持久化的 app_data_dir（与 tile_data.db / ais_data.db 一致），
/// 避免重新构建 / 移动 exe 时丢数据。首次会把旧的 exe 同级 chart_data.db 迁移过去。
pub fn init_chart_db_path(app: &AppHandle) {
    let Ok(app_dir) = app.path().app_data_dir() else {
        return;
    };
    std::fs::create_dir_all(&app_dir).ok();
    let target = app_dir.join("chart_data.db");
    if !target.exists() {
        let old = exe_db_path();
        if old.exists() && old != target {
            // 迁移旧库（航标 / 任务 / 要素），失败不致命
            std::fs::copy(&old, &target).ok();
        }
    }
    *CHART_DB_PATH.write() = Some(target.to_string_lossy().to_string());
}

/// 获取默认输出路径
fn get_default_output_dir() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("chart_tiles").to_string_lossy().to_string()
}

fn parse_chart_layers(layers: &[String]) -> Vec<ChartLayer> {
    layers
        .iter()
        .filter_map(|l| match l.as_str() {
            "yizhangtu" => Some(ChartLayer::Yizhangtu),
            "cjshoudong" => Some(ChartLayer::Cjshoudong),
            "soundg" => Some(ChartLayer::Soundg),
            _ => None,
        })
        .collect()
}

fn map_legacy_cjhy_layer(map_type: &str) -> Option<&'static str> {
    match map_type {
        "street" => Some("yizhangtu"),
        "satellite" => Some("cjshoudong"),
        "terrain" => Some("soundg"),
        _ => None,
    }
}

fn parse_json_string_vec(value: Option<&str>) -> Vec<String> {
    value
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
pub struct ChartDisplayTask {
    pub id: String,
    pub name: String,
    pub source: String,
    pub tile_mode: Option<String>,
    pub output_path: Option<String>,
    pub available_layers: Vec<String>,
    pub total_tiles: u64,
    pub completed_tiles: u64,
    pub failed_tiles: u64,
    pub bounds_north: f64,
    pub bounds_south: f64,
    pub bounds_east: f64,
    pub bounds_west: f64,
    pub zoom_levels: Vec<u32>,
    pub created_at: Option<String>,
    pub status: String,
}

// ===== Tauri Commands =====

/// 估算瓦片数量
#[tauri::command]
pub fn chart_estimate_tiles(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom_levels: Vec<u32>,
    layers: Vec<String>,
) -> Result<ChartTileEstimate, String> {
    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let chart_layers = parse_chart_layers(&layers);

    if chart_layers.is_empty() {
        return Err("未选择图层".to_string());
    }

    Ok(estimate_chart_tiles(&bounds, &zoom_levels, &chart_layers))
}

/// 开始航标采集（后台异步执行）
#[tauri::command]
pub async fn chart_start_buoy_collection(
    app: AppHandle,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    grid_step: Option<f64>,
    task_name: Option<String>,
) -> Result<String, String> {
    // 检查是否已有任务在运行
    {
        let status = TASK_STATUS.read();
        match *status {
            ChartTaskStatus::CollectingBuoys
            | ChartTaskStatus::CollectingFeatures
            | ChartTaskStatus::DownloadingTiles => {
                return Err("已有任务在运行中，请先停止当前任务".to_string());
            }
            _ => {}
        }
    }

    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let step = grid_step.unwrap_or(0.1);
    STOP_FLAG.store(false, Ordering::Relaxed);
    *TASK_STATUS.write() = ChartTaskStatus::CollectingBuoys;

    let stop_flag = STOP_FLAG.clone();

    // 进度通道
    let (progress_tx, mut progress_rx) = mpsc::channel::<ChartProgressEvent>(100);
    // 日志通道
    let (log_tx, mut log_rx) = mpsc::channel::<String>(500);

    // 创建任务记录（在进度转发之前创建，保证 task_id 可共享）
    let db_path = get_db_path();
    let task_id = match ChartDatabase::new(&db_path) {
        Ok(db) => db
            .create_chart_task(
                task_name.as_deref().filter(|s| !s.trim().is_empty()),
                "buoy",
                0,
                Some(&bounds),
                Some(step),
            )
            .unwrap_or(0),
        Err(_) => 0,
    };

    // 转发进度事件到前端，同时更新 DB
    let app_progress = app.clone();
    let db_path_progress = db_path.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_progress.emit("chart-progress", &event);
            // 将进度同步到数据库（任务历史可见）
            if task_id > 0 && event.total > 0 {
                if let Ok(db) = ChartDatabase::new(&db_path_progress) {
                    let _ = db.update_chart_task_progress(
                        task_id,
                        event.current as i64,
                        0,
                        Some(event.total as i64),
                    );
                }
            }
        }
    });

    // 转发日志到前端
    let app_log = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = log_rx.recv().await {
            let _ = app_log.emit("chart-log", &msg);
        }
    });

    // 后台执行采集，不阻塞 Tauri command
    let app_final = app.clone();
    tokio::spawn(async move {
        let collector = BuoyCollector::new(step);
        let result = collector
            .collect(&bounds, stop_flag, progress_tx, log_tx.clone())
            .await;

        match result {
            Ok(buoys) => {
                let _ = log_tx
                    .send(format!("[SAVE] 正在保存 {} 个航标到数据库...", buoys.len()))
                    .await;

                match ChartDatabase::new(&db_path) {
                    Ok(db) => match db.upsert_buoys(&buoys) {
                        Ok(count) => {
                            *TASK_STATUS.write() = ChartTaskStatus::Completed;
                            // 更新任务记录
                            if task_id > 0 {
                                let _ =
                                    db.complete_chart_task(task_id, "completed", count as i64, 0);
                            }
                            let _ = log_tx
                                .send(format!("[OK] 航标采集完成，入库 {} 条", count))
                                .await;
                            let _ = app_final.emit(
                                "chart-progress",
                                &ChartProgressEvent {
                                    task_type: "buoy".to_string(),
                                    status: "completed".to_string(),
                                    current: 0,
                                    total: 0,
                                    message: Some(format!("入库 {} 条", count)),
                                },
                            );
                        }
                        Err(e) => {
                            *TASK_STATUS.write() = ChartTaskStatus::Failed;
                            if task_id > 0 {
                                let _ = db.complete_chart_task(task_id, "failed", 0, 0);
                            }
                            let _ = log_tx.send(format!("[ERROR] 保存数据库失败: {}", e)).await;
                        }
                    },
                    Err(e) => {
                        *TASK_STATUS.write() = ChartTaskStatus::Failed;
                        let _ = log_tx.send(format!("[ERROR] 打开数据库失败: {}", e)).await;
                    }
                }
            }
            Err(e) => {
                *TASK_STATUS.write() = ChartTaskStatus::Failed;
                // 更新任务记录
                if task_id > 0 {
                    if let Ok(db) = ChartDatabase::new(&db_path) {
                        let _ = db.complete_chart_task(task_id, "failed", 0, 0);
                    }
                }
                let _ = log_tx.send(format!("[ERROR] 航标采集失败: {}", e)).await;
            }
        }
    });

    // 立即返回，不阻塞
    Ok("航标采集已启动（后台运行）".to_string())
}

/// 开始航道专题要素采集（电子围栏 + 水域面）
#[tauri::command]
pub async fn chart_start_feature_collection(
    app: AppHandle,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    grid_step: Option<f64>,
    include_fences: Option<bool>,
    include_hydro: Option<bool>,
    layers: Option<Vec<String>>,
    zoom_levels: Option<Vec<u32>>,
    output_path: Option<String>,
    task_name: Option<String>,
) -> Result<String, String> {
    {
        let status = TASK_STATUS.read();
        match *status {
            ChartTaskStatus::CollectingBuoys
            | ChartTaskStatus::CollectingFeatures
            | ChartTaskStatus::DownloadingTiles => {
                return Err("已有任务在运行中，请先停止当前任务".to_string());
            }
            _ => {}
        }
    }

    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let step = grid_step.unwrap_or(0.2);
    let fences = include_fences.unwrap_or(true);
    let hydro = include_hydro.unwrap_or(true);
    let requested_layers = layers.unwrap_or_default();
    let chart_layers = parse_chart_layers(&requested_layers);
    let has_tiles = !chart_layers.is_empty();
    if !fences && !hydro && !has_tiles {
        return Err("至少选择一种航道图内容".to_string());
    }

    let zooms = zoom_levels.unwrap_or_else(|| vec![4, 5, 6, 7, 8, 9, 10]);
    if has_tiles && zooms.is_empty() {
        return Err("下载航道图图层时请至少选择一个层级".to_string());
    }

    STOP_FLAG.store(false, Ordering::Relaxed);
    *TASK_STATUS.write() = ChartTaskStatus::CollectingFeatures;

    let stop_flag = STOP_FLAG.clone();
    let (progress_tx, mut progress_rx) = mpsc::channel::<ChartProgressEvent>(100);
    let (log_tx, mut log_rx) = mpsc::channel::<String>(500);

    let db_path = get_db_path();
    let mut task_layers: Vec<String> = Vec::new();
    if fences {
        task_layers.push("electronic_fence".to_string());
    }
    if hydro {
        task_layers.push("HYDRO_A".to_string());
    }
    task_layers.extend(chart_layers.iter().map(|l| l.id().to_string()));
    let layers_json = serde_json::to_string(&task_layers).ok();
    let zoom_levels_json = if has_tiles {
        serde_json::to_string(&zooms).ok()
    } else {
        None
    };
    let tile_output_path = if has_tiles {
        Some(output_path.unwrap_or_else(get_default_output_dir))
    } else {
        None
    };

    let task_id = match ChartDatabase::new(&db_path) {
        Ok(db) => db
            .create_chart_task_with_details(
                task_name.as_deref().filter(|s| !s.trim().is_empty()),
                "feature",
                0,
                Some(&bounds),
                Some(step),
                zoom_levels_json.as_deref(),
                layers_json.as_deref(),
                tile_output_path.as_deref(),
            )
            .unwrap_or(0),
        Err(_) => 0,
    };

    let app_progress = app.clone();
    let db_path_progress = db_path.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_progress.emit("chart-progress", &event);
            if task_id > 0 && event.total > 0 {
                if let Ok(db) = ChartDatabase::new(&db_path_progress) {
                    let _ = db.update_chart_task_progress(
                        task_id,
                        event.current as i64,
                        0,
                        Some(event.total as i64),
                    );
                }
            }
        }
    });

    let app_log = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = log_rx.recv().await {
            let _ = app_log.emit("chart-log", &msg);
        }
    });

    let app_final = app.clone();
    tokio::spawn(async move {
        let mut saved_features = 0u64;
        let mut saved_tiles = 0u64;

        if fences || hydro {
            let collector = FeatureCollector::new(step, fences, hydro);
            let result = collector
                .collect(&bounds, stop_flag.clone(), progress_tx.clone(), log_tx.clone())
                .await;

            match result {
                Ok(features) => {
                    let _ = log_tx
                        .send(format!(
                            "[SAVE] 正在保存 {} 个航道要素到数据库...",
                            features.len()
                        ))
                        .await;

                    match ChartDatabase::new(&db_path) {
                        Ok(db) => match db.upsert_features(&features) {
                            Ok(count) => {
                                saved_features = count as u64;
                                let _ = log_tx
                                    .send(format!("[OK] 航道要素采集完成，入库 {} 条", count))
                                    .await;
                            }
                            Err(e) => {
                                *TASK_STATUS.write() = ChartTaskStatus::Failed;
                                if task_id > 0 {
                                    let _ = db.complete_chart_task(task_id, "failed", 0, 0);
                                }
                                let _ = log_tx
                                    .send(format!("[ERROR] 保存航道要素失败: {}", e))
                                    .await;
                                return;
                            }
                        },
                        Err(e) => {
                            *TASK_STATUS.write() = ChartTaskStatus::Failed;
                            let _ = log_tx.send(format!("[ERROR] 打开数据库失败: {}", e)).await;
                            return;
                        }
                    }
                }
                Err(e) => {
                    *TASK_STATUS.write() = ChartTaskStatus::Failed;
                    if task_id > 0 {
                        if let Ok(db) = ChartDatabase::new(&db_path) {
                            let _ = db.complete_chart_task(task_id, "failed", 0, 0);
                        }
                    }
                    let _ = log_tx
                        .send(format!("[ERROR] 航道要素采集失败: {}", e))
                        .await;
                    return;
                }
            }
        }

        if has_tiles {
            if stop_flag.load(Ordering::Relaxed) {
                *TASK_STATUS.write() = ChartTaskStatus::Stopped;
                return;
            }
            let out_dir = tile_output_path.unwrap_or_else(get_default_output_dir);
            let _ = log_tx
                .send(format!(
                    "[INFO] 开始下载航道图覆盖层: {} 个图层, 级别 {:?}, 输出: {}",
                    chart_layers.len(),
                    zooms,
                    out_dir
                ))
                .await;

            let fetcher = ChartTileFetcher::new(&out_dir);
            match fetcher
                .download(&bounds, &zooms, &chart_layers, stop_flag.clone(), progress_tx.clone())
                .await
            {
                Ok(count) => {
                    saved_tiles = count;
                }
                Err(e) => {
                    *TASK_STATUS.write() = ChartTaskStatus::Failed;
                    if task_id > 0 {
                        if let Ok(db) = ChartDatabase::new(&db_path) {
                            let _ = db.complete_chart_task(task_id, "failed", 0, 0);
                        }
                    }
                    let _ = log_tx.send(format!("[ERROR] 航道图覆盖层下载失败: {}", e)).await;
                    return;
                }
            }
        }

        match ChartDatabase::new(&db_path) {
            Ok(db) => {
                let completed = (saved_features + saved_tiles) as i64;
                *TASK_STATUS.write() = ChartTaskStatus::Completed;
                if task_id > 0 {
                    let _ = db.complete_chart_task(task_id, "completed", completed, 0);
                }
                let _ = log_tx
                    .send(format!(
                        "[OK] 航道图专题任务完成，要素 {} 条，瓦片 {} 个",
                        saved_features, saved_tiles
                    ))
                    .await;
                let total = saved_features + saved_tiles;
                let _ = app_final.emit(
                    "chart-progress",
                    &ChartProgressEvent {
                        task_type: "feature".to_string(),
                        status: "completed".to_string(),
                        current: total,
                        total,
                        message: Some(format!("要素 {} 条，瓦片 {} 个", saved_features, saved_tiles)),
                    },
                );
            }
            Err(e) => {
                *TASK_STATUS.write() = ChartTaskStatus::Failed;
                let _ = log_tx.send(format!("[ERROR] 打开数据库失败: {}", e)).await;
            }
        }
    });

    Ok("航道图专题采集已启动（后台运行）".to_string())
}

/// 开始瓦片下载（后台异步执行）
#[tauri::command]
pub async fn chart_start_tile_download(
    app: AppHandle,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom_levels: Vec<u32>,
    layers: Vec<String>,
    output_path: Option<String>,
) -> Result<String, String> {
    // 检查是否已有任务在运行
    {
        let status = TASK_STATUS.read();
        match *status {
            ChartTaskStatus::CollectingBuoys
            | ChartTaskStatus::CollectingFeatures
            | ChartTaskStatus::DownloadingTiles => {
                return Err("已有任务在运行中，请先停止当前任务".to_string());
            }
            _ => {}
        }
    }

    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let chart_layers: Vec<ChartLayer> = layers
        .iter()
        .filter_map(|l| match l.as_str() {
            "yizhangtu" => Some(ChartLayer::Yizhangtu),
            "cjshoudong" => Some(ChartLayer::Cjshoudong),
            "soundg" => Some(ChartLayer::Soundg),
            _ => None,
        })
        .collect();

    if chart_layers.is_empty() {
        return Err("未选择图层".to_string());
    }

    STOP_FLAG.store(false, Ordering::Relaxed);
    *TASK_STATUS.write() = ChartTaskStatus::DownloadingTiles;

    let stop_flag = STOP_FLAG.clone();
    let (progress_tx, mut progress_rx) = mpsc::channel::<ChartProgressEvent>(100);
    let (log_tx, mut log_rx) = mpsc::channel::<String>(500);

    // 转发进度
    let app_progress = app.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_progress.emit("chart-progress", &event);
        }
    });

    // 转发日志
    let app_log = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = log_rx.recv().await {
            let _ = app_log.emit("chart-log", &msg);
        }
    });

    let out_dir = output_path.unwrap_or_else(|| get_default_output_dir());

    // 后台执行
    tokio::spawn(async move {
        let _ = log_tx
            .send(format!(
                "[INFO] 开始瓦片下载: {} 个图层, 级别 {:?}, 输出: {}",
                chart_layers.len(),
                zoom_levels,
                out_dir
            ))
            .await;

        let fetcher = ChartTileFetcher::new(&out_dir);
        let result = fetcher
            .download(&bounds, &zoom_levels, &chart_layers, stop_flag, progress_tx)
            .await;

        match result {
            Ok(count) => {
                *TASK_STATUS.write() = ChartTaskStatus::Completed;
                let _ = log_tx
                    .send(format!("[OK] 瓦片下载完成，共 {} 个", count))
                    .await;
            }
            Err(e) => {
                *TASK_STATUS.write() = ChartTaskStatus::Failed;
                let _ = log_tx.send(format!("[ERROR] 瓦片下载失败: {}", e)).await;
            }
        }
    });

    Ok("瓦片下载已启动（后台运行）".to_string())
}

/// 停止当前任务
#[tauri::command]
pub fn chart_stop_collection() -> Result<String, String> {
    STOP_FLAG.store(true, Ordering::Relaxed);
    *TASK_STATUS.write() = ChartTaskStatus::Stopped;
    Ok("已发送停止信号".to_string())
}

/// 获取当前任务状态
#[tauri::command]
pub fn chart_get_status() -> ChartTaskStatus {
    TASK_STATUS.read().clone()
}

/// 获取已采集的航标数据
#[tauri::command]
pub fn chart_get_buoys(
    west: Option<f64>,
    south: Option<f64>,
    east: Option<f64>,
    north: Option<f64>,
) -> Result<Vec<BuoyInfo>, String> {
    let db = ChartDatabase::new(&get_db_path())?;

    if let (Some(w), Some(s), Some(e), Some(n)) = (west, south, east, north) {
        let bounds = ChartBounds::new(w, s, e, n);
        db.get_buoys_in_bounds(&bounds)
    } else {
        db.get_all_buoys()
    }
}

/// 获取航标总数
#[tauri::command]
pub fn chart_get_buoy_count() -> Result<u64, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_buoy_count()
}

/// 获取航道专题要素总数
#[tauri::command]
pub fn chart_get_feature_count() -> Result<u64, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_feature_count()
}

/// 清空航标数据
#[tauri::command]
pub fn chart_clear_buoys() -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.clear_buoys()?;
    Ok("航标数据已清空".to_string())
}

/// 清空航道专题要素
#[tauri::command]
pub fn chart_clear_features() -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.clear_features()?;
    Ok("航道要素数据已清空".to_string())
}

/// 执行图像合成
#[tauri::command]
pub fn chart_compose_image(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom: u32,
    layers: Vec<String>,
    output_path: String,
    tiles_dir: Option<String>,
) -> Result<String, String> {
    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let chart_layers: Vec<ChartLayer> = layers
        .iter()
        .filter_map(|l| match l.as_str() {
            "yizhangtu" => Some(ChartLayer::Yizhangtu),
            "cjshoudong" => Some(ChartLayer::Cjshoudong),
            "soundg" => Some(ChartLayer::Soundg),
            _ => None,
        })
        .collect();

    let db = ChartDatabase::new(&get_db_path())?;
    let buoys = db.get_buoys_in_bounds(&bounds)?;

    let dir = tiles_dir.unwrap_or_else(|| get_default_output_dir());
    let composer = ChartComposer::new(&dir);

    *TASK_STATUS.write() = ChartTaskStatus::Composing;
    let result = composer.compose(&bounds, zoom, &chart_layers, &buoys, &output_path);

    match result {
        Ok(path) => {
            *TASK_STATUS.write() = ChartTaskStatus::Completed;
            Ok(path)
        }
        Err(e) => {
            *TASK_STATUS.write() = ChartTaskStatus::Failed;
            Err(e)
        }
    }
}

/// 获取默认边界（荆州-岳阳航段）
#[tauri::command]
pub fn chart_get_default_bounds() -> ChartBounds {
    ChartBounds::default_jingzhou_yueyang()
}

/// 重置任务状态（用于前端页面加载时清理残留状态）
#[tauri::command]
pub fn chart_reset_status() -> Result<String, String> {
    STOP_FLAG.store(true, Ordering::Relaxed);
    *TASK_STATUS.write() = ChartTaskStatus::Idle;
    Ok("状态已重置".to_string())
}

/// CSV 字段转义（包含逗号或引号时加双引号）
fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 导出航标数据（JSON、CSV 或 SQL）
#[tauri::command]
pub fn chart_export_buoys(
    format: String,
    output_path: String,
    west: Option<f64>,
    south: Option<f64>,
    east: Option<f64>,
    north: Option<f64>,
) -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;

    let buoys = if let (Some(w), Some(s), Some(e), Some(n)) = (west, south, east, north) {
        let bounds = ChartBounds::new(w, s, e, n);
        db.get_buoys_in_bounds(&bounds)?
    } else {
        db.get_all_buoys()?
    };

    if buoys.is_empty() {
        return Err("没有可导出的航标数据".to_string());
    }

    let content_bytes: Vec<u8> = match format.as_str() {
        "json" => {
            let json = serde_json::to_string_pretty(&buoys)
                .map_err(|e| format!("JSON 序列化失败: {}", e))?;
            json.into_bytes()
        }
        "csv" => {
            let mut csv = String::from("id,name,lon_84,lat_84,buoy_type,color,waterway,shape,light_info,region,organization_id\n");
            for b in &buoys {
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{},{},{}\n",
                    csv_escape(&b.id),
                    csv_escape(b.name.as_deref().unwrap_or("")),
                    b.lon_84.map(|v| v.to_string()).unwrap_or_default(),
                    b.lat_84.map(|v| v.to_string()).unwrap_or_default(),
                    csv_escape(b.buoy_type.as_deref().unwrap_or("")),
                    csv_escape(b.color.as_deref().unwrap_or("")),
                    csv_escape(b.waterway.as_deref().unwrap_or("")),
                    csv_escape(b.shape.as_deref().unwrap_or("")),
                    csv_escape(b.light_info.as_deref().unwrap_or("")),
                    csv_escape(b.region.as_deref().unwrap_or("")),
                    csv_escape(b.organization_id.as_deref().unwrap_or("")),
                ));
            }
            // UTF-8 BOM + CSV 内容，让 Excel 正确识别中文
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(csv.as_bytes());
            bytes
        }
        "mysql" => {
            let mut sql_bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
            let mut sql = String::new();
            sql.push_str("-- 航标数据导出\n");
            sql.push_str("-- 生成时间: ");
            sql.push_str(&chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
            sql.push_str("\n-- 编码: UTF-8\n\n");
            sql.push_str("SET NAMES utf8mb4;\n\n");
            sql.push_str("CREATE TABLE IF NOT EXISTS buoy_data (\n");
            sql.push_str("  id VARCHAR(64) PRIMARY KEY,\n");
            sql.push_str("  name VARCHAR(255),\n");
            sql.push_str("  lon_84 DOUBLE,\n");
            sql.push_str("  lat_84 DOUBLE,\n");
            sql.push_str("  buoy_type VARCHAR(100),\n");
            sql.push_str("  color VARCHAR(50),\n");
            sql.push_str("  waterway VARCHAR(255),\n");
            sql.push_str("  shape VARCHAR(100),\n");
            sql.push_str("  light_info VARCHAR(255),\n");
            sql.push_str("  region VARCHAR(100),\n");
            sql.push_str("  organization_id VARCHAR(100)\n");
            sql.push_str(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n");

            for b in &buoys {
                let sql_escape = |s: &str| s.replace("'", "''");
                sql.push_str(&format!(
                    "INSERT INTO buoy_data (id, name, lon_84, lat_84, buoy_type, color, waterway, shape, light_info, region, organization_id) VALUES ('{}', {}, {}, {}, {}, {}, {}, {}, {}, {}, {});\n",
                    sql_escape(&b.id),
                    b.name.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.lon_84.map(|v| v.to_string()).unwrap_or_else(|| "NULL".to_string()),
                    b.lat_84.map(|v| v.to_string()).unwrap_or_else(|| "NULL".to_string()),
                    b.buoy_type.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.color.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.waterway.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.shape.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.light_info.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.region.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                    b.organization_id.as_ref().map(|v| format!("'{}'", sql_escape(v))).unwrap_or_else(|| "NULL".to_string()),
                ));
            }
            sql_bytes.extend_from_slice(sql.as_bytes());
            sql_bytes
        }
        _ => return Err(format!("不支持的格式: {}", format)),
    };

    std::fs::write(&output_path, &content_bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(format!(
        "导出成功: {} 条航标 → {}",
        buoys.len(),
        output_path
    ))
}

fn sql_literal(value: Option<&str>) -> String {
    value
        .map(|v| format!("'{}'", v.replace('\'', "''")))
        .unwrap_or_else(|| "NULL".to_string())
}

fn sql_number(value: Option<f64>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "NULL".to_string())
}

// —— 水域面"只取最外层边框"导出辅助 ——
// 把大大小小嵌套的 HYDRO_A 水域面收敛成最外层外环（去洞、去嵌套内层），
// 其它图层原样保留。与前端 geo.ts 的 outermostPolygons 同一套判定逻辑。

type OutlineRing = Vec<[f64; 2]>;

struct OutlineBbox {
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
}

impl OutlineBbox {
    fn empty() -> Self {
        OutlineBbox {
            min_lon: f64::INFINITY,
            min_lat: f64::INFINITY,
            max_lon: f64::NEG_INFINITY,
            max_lat: f64::NEG_INFINITY,
        }
    }
    fn extend(&mut self, o: &OutlineBbox) {
        if o.min_lon < self.min_lon {
            self.min_lon = o.min_lon;
        }
        if o.min_lat < self.min_lat {
            self.min_lat = o.min_lat;
        }
        if o.max_lon > self.max_lon {
            self.max_lon = o.max_lon;
        }
        if o.max_lat > self.max_lat {
            self.max_lat = o.max_lat;
        }
    }
}

fn parse_outline_ring(v: &serde_json::Value) -> OutlineRing {
    v.as_array()
        .map(|pts| {
            pts.iter()
                .filter_map(|p| {
                    let a = p.as_array()?;
                    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 取一个 GeoJSON geometry 的所有外环（Polygon 取 coordinates[0]，MultiPolygon 取每个 polygon 的 [0]）
fn outer_rings_of(geom: &serde_json::Value) -> Vec<OutlineRing> {
    match geom.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "Polygon" => geom
            .get("coordinates")
            .and_then(|c| c.as_array())
            .and_then(|rings| rings.first())
            .map(parse_outline_ring)
            .filter(|r| r.len() >= 3)
            .into_iter()
            .collect(),
        "MultiPolygon" => geom
            .get("coordinates")
            .and_then(|c| c.as_array())
            .map(|polys| {
                polys
                    .iter()
                    .filter_map(|poly| {
                        poly.as_array()
                            .and_then(|rings| rings.first())
                            .map(parse_outline_ring)
                    })
                    .filter(|r| r.len() >= 3)
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

fn outline_ring_bbox(ring: &OutlineRing) -> OutlineBbox {
    let mut b = OutlineBbox::empty();
    for c in ring {
        if c[0] < b.min_lon {
            b.min_lon = c[0];
        }
        if c[0] > b.max_lon {
            b.max_lon = c[0];
        }
        if c[1] < b.min_lat {
            b.min_lat = c[1];
        }
        if c[1] > b.max_lat {
            b.max_lat = c[1];
        }
    }
    b
}

fn outline_ring_area(ring: &OutlineRing) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
        j = i;
    }
    a.abs() / 2.0
}

fn outline_bbox_inside(inner: &OutlineBbox, outer: &OutlineBbox) -> bool {
    inner.min_lon >= outer.min_lon
        && inner.max_lon <= outer.max_lon
        && inner.min_lat >= outer.min_lat
        && inner.max_lat <= outer.max_lat
}

fn outline_point_in_ring(lon: f64, lat: f64, ring: &OutlineRing) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// inner 外环是否基本落在 outer 外环内：bbox 包含 + 抽样顶点多数在内
fn outline_ring_contains(
    outer: &OutlineRing,
    outer_bbox: &OutlineBbox,
    inner: &OutlineRing,
    inner_bbox: &OutlineBbox,
) -> bool {
    if !outline_bbox_inside(inner_bbox, outer_bbox) {
        return false;
    }
    if inner.is_empty() || outer.len() < 3 {
        return false;
    }
    let stride = (inner.len() / 40).max(1);
    let mut tested = 0usize;
    let mut hit = 0usize;
    let mut i = 0usize;
    while i < inner.len() {
        tested += 1;
        if outline_point_in_ring(inner[i][0], inner[i][1], outer) {
            hit += 1;
        }
        i += stride;
    }
    tested > 0 && (hit as f64) / (tested as f64) >= 0.9
}

/// 把 HYDRO_A 水域面收敛为最外层边框（只外环、去洞、去嵌套内层）。
/// 非 HYDRO_A 要素、以及 HYDRO_A 中非多边形几何，原样保留。
fn collapse_water_outlines(features: Vec<ChartFeatureInfo>) -> Vec<ChartFeatureInfo> {
    struct Cand {
        feat: usize,
        ring: OutlineRing,
        bbox: OutlineBbox,
        area: f64,
    }

    // 1) 收集所有水域面外环候选
    let mut cands: Vec<Cand> = Vec::new();
    let mut feat_had_polygon: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (idx, f) in features.iter().enumerate() {
        if f.source_layer != "HYDRO_A" {
            continue;
        }
        let geom: serde_json::Value = match serde_json::from_str(&f.geometry_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for ring in outer_rings_of(&geom) {
            feat_had_polygon.insert(idx);
            let bbox = outline_ring_bbox(&ring);
            let area = outline_ring_area(&ring);
            cands.push(Cand {
                feat: idx,
                ring,
                bbox,
                area,
            });
        }
    }

    if cands.is_empty() {
        return features; // 没有水域多边形，原样返回
    }

    // 2) 面积从大到小，保留外环不被任何更大外环包含的那些
    let mut order: Vec<usize> = (0..cands.len()).collect();
    order.sort_by(|&a, &b| {
        cands[b]
            .area
            .partial_cmp(&cands[a].area)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<usize> = Vec::new();
    for &ci in &order {
        let contained = kept.iter().any(|&ki| {
            outline_ring_contains(&cands[ki].ring, &cands[ki].bbox, &cands[ci].ring, &cands[ci].bbox)
        });
        if !contained {
            kept.push(ci);
        }
    }

    // 3) 按要素归并保留的外环
    let mut by_feat: std::collections::HashMap<usize, Vec<usize>> =
        std::collections::HashMap::new();
    for &ci in &kept {
        by_feat.entry(cands[ci].feat).or_default().push(ci);
    }

    // 4) 重建要素
    let mut out: Vec<ChartFeatureInfo> = Vec::new();
    for (idx, mut f) in features.into_iter().enumerate() {
        if f.source_layer != "HYDRO_A" || !feat_had_polygon.contains(&idx) {
            out.push(f); // 非水域面或非多边形几何，原样保留
            continue;
        }
        let rings = match by_feat.get(&idx) {
            Some(r) if !r.is_empty() => r,
            _ => continue, // 整个要素都是内层，丢弃
        };
        let ring_vals: Vec<serde_json::Value> = rings
            .iter()
            .map(|&ci| {
                serde_json::Value::Array(
                    cands[ci]
                        .ring
                        .iter()
                        .map(|c| serde_json::json!([c[0], c[1]]))
                        .collect(),
                )
            })
            .collect();
        let (geom_val, gtype) = if ring_vals.len() == 1 {
            (
                serde_json::json!({ "type": "Polygon", "coordinates": [ring_vals[0]] }),
                "Polygon",
            )
        } else {
            let polys: Vec<serde_json::Value> =
                ring_vals.into_iter().map(|r| serde_json::json!([r])).collect();
            (
                serde_json::json!({ "type": "MultiPolygon", "coordinates": polys }),
                "MultiPolygon",
            )
        };
        let mut bb = OutlineBbox::empty();
        for &ci in rings {
            bb.extend(&cands[ci].bbox);
        }
        f.geometry_json = serde_json::to_string(&geom_val).unwrap_or(f.geometry_json);
        f.geometry_type = Some(gtype.to_string());
        f.min_lon = Some(bb.min_lon);
        f.min_lat = Some(bb.min_lat);
        f.max_lon = Some(bb.max_lon);
        f.max_lat = Some(bb.max_lat);
        out.push(f);
    }
    out
}

/// 导出航道专题要素（JSON、GeoJSON、CSV 或 SQL）
#[tauri::command]
pub fn chart_export_features(
    format: String,
    output_path: String,
    west: Option<f64>,
    south: Option<f64>,
    east: Option<f64>,
    north: Option<f64>,
    source_layers: Option<Vec<String>>,
    outline_only: Option<bool>,
) -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;

    let mut features = if let (Some(w), Some(s), Some(e), Some(n)) = (west, south, east, north) {
        let bounds = ChartBounds::new(w, s, e, n);
        db.get_features_in_bounds(&bounds)?
    } else {
        db.get_all_features()?
    };

    if let Some(layers) = source_layers {
        let requested: std::collections::HashSet<String> = layers
            .into_iter()
            .filter(|layer| layer == "electronic_fence" || layer == "HYDRO_A")
            .collect();
        if requested.is_empty() {
            return Err("请选择要导出的水域面或航道要素".to_string());
        }
        features.retain(|f| requested.contains(&f.source_layer));
    }

    if outline_only.unwrap_or(false) {
        features = collapse_water_outlines(features);
    }

    if features.is_empty() {
        return Err("没有可导出的航道要素数据".to_string());
    }

    let content_bytes: Vec<u8> = match format.as_str() {
        "json" => {
            let json = serde_json::to_string_pretty(&features)
                .map_err(|e| format!("JSON 序列化失败: {}", e))?;
            json.into_bytes()
        }
        "geojson" => {
            let geo_features: Vec<serde_json::Value> = features
                .iter()
                .map(|f| {
                    let geometry = serde_json::from_str::<serde_json::Value>(&f.geometry_json)
                        .unwrap_or(serde_json::Value::Null);
                    serde_json::json!({
                        "type": "Feature",
                        "id": f.id,
                        "properties": {
                            "source": f.source,
                            "source_layer": f.source_layer,
                            "source_feature_id": f.source_feature_id,
                            "name": f.name,
                            "feature_type": f.feature_type,
                            "geometry_type": f.geometry_type,
                            "min_lon": f.min_lon,
                            "min_lat": f.min_lat,
                            "max_lon": f.max_lon,
                            "max_lat": f.max_lat,
                        },
                        "geometry": geometry,
                    })
                })
                .collect();
            let fc = serde_json::json!({
                "type": "FeatureCollection",
                "name": "cjhy_chart_features",
                "features": geo_features,
            });
            serde_json::to_string_pretty(&fc)
                .map_err(|e| format!("GeoJSON 序列化失败: {}", e))?
                .into_bytes()
        }
        "csv" => {
            let mut csv = String::from("id,source,source_layer,source_feature_id,name,feature_type,geometry_type,min_lon,min_lat,max_lon,max_lat\n");
            for f in &features {
                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{},{},{}\n",
                    csv_escape(&f.id),
                    csv_escape(&f.source),
                    csv_escape(&f.source_layer),
                    csv_escape(f.source_feature_id.as_deref().unwrap_or("")),
                    csv_escape(f.name.as_deref().unwrap_or("")),
                    csv_escape(f.feature_type.as_deref().unwrap_or("")),
                    csv_escape(f.geometry_type.as_deref().unwrap_or("")),
                    f.min_lon.map(|v| v.to_string()).unwrap_or_default(),
                    f.min_lat.map(|v| v.to_string()).unwrap_or_default(),
                    f.max_lon.map(|v| v.to_string()).unwrap_or_default(),
                    f.max_lat.map(|v| v.to_string()).unwrap_or_default(),
                ));
            }
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(csv.as_bytes());
            bytes
        }
        "mysql" => {
            let mut sql_bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
            let mut sql = String::new();
            sql.push_str("-- 航道专题要素导出\n");
            sql.push_str("-- 生成时间: ");
            sql.push_str(&chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
            sql.push_str(
                "\n-- geometry_json 为 GeoJSON Geometry，可导入后转换为 PostGIS geometry\n\n",
            );
            sql.push_str("SET NAMES utf8mb4;\n\n");
            sql.push_str("CREATE TABLE IF NOT EXISTS chart_feature_data (\n");
            sql.push_str("  id VARCHAR(128) PRIMARY KEY,\n");
            sql.push_str("  source VARCHAR(64) NOT NULL,\n");
            sql.push_str("  source_layer VARCHAR(64) NOT NULL,\n");
            sql.push_str("  source_feature_id VARCHAR(128),\n");
            sql.push_str("  name VARCHAR(255),\n");
            sql.push_str("  feature_type VARCHAR(128),\n");
            sql.push_str("  geometry_type VARCHAR(64),\n");
            sql.push_str("  min_lon DOUBLE,\n");
            sql.push_str("  min_lat DOUBLE,\n");
            sql.push_str("  max_lon DOUBLE,\n");
            sql.push_str("  max_lat DOUBLE,\n");
            sql.push_str("  geometry_json LONGTEXT NOT NULL,\n");
            sql.push_str("  raw_json LONGTEXT NOT NULL\n");
            sql.push_str(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n");

            for f in &features {
                sql.push_str(&format!(
                    "INSERT INTO chart_feature_data (id, source, source_layer, source_feature_id, name, feature_type, geometry_type, min_lon, min_lat, max_lon, max_lat, geometry_json, raw_json) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {});\n",
                    sql_literal(Some(&f.id)),
                    sql_literal(Some(&f.source)),
                    sql_literal(Some(&f.source_layer)),
                    sql_literal(f.source_feature_id.as_deref()),
                    sql_literal(f.name.as_deref()),
                    sql_literal(f.feature_type.as_deref()),
                    sql_literal(f.geometry_type.as_deref()),
                    sql_number(f.min_lon),
                    sql_number(f.min_lat),
                    sql_number(f.max_lon),
                    sql_number(f.max_lat),
                    sql_literal(Some(&f.geometry_json)),
                    sql_literal(Some(&f.raw_json)),
                ));
            }
            sql_bytes.extend_from_slice(sql.as_bytes());
            sql_bytes
        }
        _ => return Err(format!("不支持的格式: {}", format)),
    };

    std::fs::write(&output_path, &content_bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(format!(
        "导出成功: {} 条{} → {}",
        features.len(),
        if outline_only.unwrap_or(false) {
            "要素（水域面只取最外层边框）"
        } else {
            "航道要素"
        },
        output_path
    ))
}

/// 瓦片文件统计结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChartTileStats {
    pub total: u64,
    pub by_layer: Vec<(String, u64)>,
}

/// 获取已下载的航道图瓦片数量（通过遍历文件系统）
#[tauri::command]
pub fn chart_get_tile_count() -> Result<ChartTileStats, String> {
    let tiles_dir = get_default_output_dir();
    let base = std::path::Path::new(&tiles_dir);

    if !base.exists() {
        return Ok(ChartTileStats {
            total: 0,
            by_layer: vec![],
        });
    }

    let layer_names = [
        ("yizhangtu", "底图"),
        ("cjshoudong", "水域"),
        ("soundg", "水深"),
    ];

    let mut total: u64 = 0;
    let mut by_layer = Vec::new();

    for (layer_id, layer_label) in &layer_names {
        let layer_dir = base.join(layer_id);
        if !layer_dir.exists() {
            continue;
        }
        let mut count: u64 = 0;
        // Walk the directory recursively
        fn count_files(dir: &std::path::Path, count: &mut u64) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        count_files(&path, count);
                    } else if path.extension().and_then(|e| e.to_str()) == Some("png") {
                        *count += 1;
                    }
                }
            }
        }
        count_files(&layer_dir, &mut count);
        if count > 0 {
            by_layer.push((format!("{} ({})", layer_label, layer_id), count));
            total += count;
        }
    }

    Ok(ChartTileStats { total, by_layer })
}

/// 获取数据中心航道图 Tab 可展示的专题任务。
#[tauri::command]
pub fn chart_get_display_tasks(app: AppHandle) -> Result<Vec<ChartDisplayTask>, String> {
    let mut tasks = Vec::new();

    if let Ok(db) = ChartDatabase::new(&get_db_path()) {
        if let Ok(chart_tasks) = db.get_chart_tasks() {
            for t in chart_tasks {
                let has_bounds = t.bounds_west.is_some()
                    && t.bounds_south.is_some()
                    && t.bounds_east.is_some()
                    && t.bounds_north.is_some();
                if !has_bounds {
                    continue;
                }

                let mut available_layers = parse_json_string_vec(t.layers.as_deref());
                if available_layers.is_empty() && t.task_type == "feature" {
                    // 老版本要素任务没有记录 include_fences/include_hydro，只能按历史默认值展示。
                    available_layers.push("electronic_fence".to_string());
                    available_layers.push("HYDRO_A".to_string());
                }
                let has_any_chart_layer = available_layers
                    .iter()
                    .any(|l| matches!(l.as_str(), "yizhangtu" | "cjshoudong" | "soundg"));
                let has_any_feature_layer = available_layers
                    .iter()
                    .any(|l| matches!(l.as_str(), "electronic_fence" | "HYDRO_A"));
                if !has_any_chart_layer && !has_any_feature_layer {
                    continue;
                }

                let zoom_levels = t
                    .zoom_levels
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<u32>>(s).ok())
                    .unwrap_or_default();
                let source = if has_any_chart_layer && has_any_feature_layer {
                    "chart_mixed"
                } else if has_any_chart_layer {
                    "chart_tile"
                } else {
                    "chart_feature"
                };
                let name = match source {
                    "chart_mixed" => format!("航道图专题 #{}", t.id),
                    "chart_tile" => format!("航道图覆盖层 #{}", t.id),
                    _ => format!("航道要素 #{}", t.id),
                };
                let name = t
                    .task_name
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(name.as_str())
                    .to_string();

                tasks.push(ChartDisplayTask {
                    id: format!("chart_{}", t.id),
                    name,
                    source: source.to_string(),
                    tile_mode: if has_any_chart_layer {
                        Some("chart".to_string())
                    } else {
                        None
                    },
                    output_path: t.output_path,
                    available_layers,
                    total_tiles: t.total_items.max(0) as u64,
                    completed_tiles: t.completed_items.max(0) as u64,
                    failed_tiles: t.failed_items.max(0) as u64,
                    bounds_north: t.bounds_north.unwrap_or_default(),
                    bounds_south: t.bounds_south.unwrap_or_default(),
                    bounds_east: t.bounds_east.unwrap_or_default(),
                    bounds_west: t.bounds_west.unwrap_or_default(),
                    zoom_levels,
                    created_at: t.created_at,
                    status: t.status,
                });
            }
        }
    }

    // 兼容老的“离线地图瓦片”中创建的 cjhy 单图层任务。
    if let Ok(tile_db) = crate::tile_downloader::commands::get_tile_db(&app) {
        if let Ok(tile_tasks) = tile_db.get_all_tasks() {
            for t in tile_tasks {
                if t.platform != "cjhy" || t.output_format != "folder" {
                    continue;
                }
                let Some(layer) = map_legacy_cjhy_layer(&t.map_type) else {
                    continue;
                };
                tasks.push(ChartDisplayTask {
                    id: format!("legacy_tile_{}", t.id),
                    name: t.name,
                    source: "legacy_tile".to_string(),
                    tile_mode: Some("legacy".to_string()),
                    output_path: Some(t.output_path),
                    available_layers: vec![layer.to_string()],
                    total_tiles: t.total_tiles,
                    completed_tiles: t.completed_tiles,
                    failed_tiles: t.failed_tiles,
                    bounds_north: t.bounds.north,
                    bounds_south: t.bounds.south,
                    bounds_east: t.bounds.east,
                    bounds_west: t.bounds.west,
                    zoom_levels: t.zoom_levels,
                    created_at: Some(t.created_at),
                    status: t.status,
                });
            }
        }
    }

    tasks.sort_by(|a, b| {
        b.created_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.created_at.as_deref().unwrap_or(""))
    });
    Ok(tasks)
}

/// 读取航道图专题任务中的某一覆盖层瓦片。
#[tauri::command]
pub fn chart_serve_layer_tile(
    base_path: String,
    layer: String,
    z: u32,
    x: u32,
    y: u32,
) -> Result<String, String> {
    if !matches!(layer.as_str(), "yizhangtu" | "cjshoudong" | "soundg") {
        return Err(format!("不支持的航道图图层: {}", layer));
    }

    let path = Path::new(&base_path)
        .join(layer)
        .join(z.to_string())
        .join(format!("{}_{}.png", y, x));

    match std::fs::read(&path) {
        Ok(data) => {
            if data.len() == 872 {
                return Ok(String::new());
            }
            Ok(BASE64.encode(&data))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取航道图瓦片失败: {}", e)),
    }
}

/// 获取航标按类型分组统计
#[tauri::command]
pub fn chart_get_buoy_stats() -> Result<Vec<(String, i64)>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_buoy_stats()
}

/// 获取航道专题要素按类型分组统计
#[tauri::command]
pub fn chart_get_feature_stats() -> Result<Vec<(String, i64)>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_feature_stats()
}

/// 获取所有航标数据（供前端表格展示）
#[tauri::command]
pub fn chart_get_all_buoys() -> Result<Vec<BuoyInfo>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_all_buoys()
}

/// 获取所有航道专题要素
#[tauri::command]
pub fn chart_get_all_features() -> Result<Vec<ChartFeatureInfo>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_all_features()
}

/// 获取电子围栏要素（供航道图叠加展示）
#[tauri::command]
pub fn chart_get_fence_features() -> Result<Vec<ChartFeatureInfo>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_features_by_layer("electronic_fence")
}

/// 按来源图层获取航道专题要素（供航道图叠加展示）
#[tauri::command]
pub fn chart_get_features_by_layer(source_layer: String) -> Result<Vec<ChartFeatureInfo>, String> {
    if source_layer != "electronic_fence" && source_layer != "HYDRO_A" {
        return Err(format!("不支持的航道要素图层: {}", source_layer));
    }

    let db = ChartDatabase::new(&get_db_path())?;
    db.get_features_by_layer(&source_layer)
}

/// 按来源图层和 bbox 获取航道专题要素（供视野内叠加展示）
#[tauri::command]
pub fn chart_get_features_by_layer_in_bounds(
    source_layer: String,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<ChartFeatureInfo>, String> {
    if source_layer != "electronic_fence" && source_layer != "HYDRO_A" {
        return Err(format!("不支持的航道要素图层: {}", source_layer));
    }

    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let db = ChartDatabase::new(&get_db_path())?;
    db.get_features_by_layer_in_bounds(&source_layer, &bounds)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BuoyExtent {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

#[tauri::command]
pub fn chart_get_buoy_extent() -> Result<Option<BuoyExtent>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    Ok(db.get_buoy_extent()?.map(|(s, w, n, e)| BuoyExtent {
        south: s,
        west: w,
        north: n,
        east: e,
    }))
}
