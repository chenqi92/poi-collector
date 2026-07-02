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
            // 先把任务标记为「按归属过滤」：即使这次采集失败/一条没采到，数据中心也只显示
            // 它自己的（空），不回退到按范围把别的任务串进来。真实归属在 upsert_features 里写。
            if task_id > 0 {
                if let Ok(db) = ChartDatabase::new(&db_path) {
                    let _ = db.mark_task_feature_scoped(task_id);
                }
            }
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
                        // task_id > 0 时记录「任务↔要素」归属，供数据中心按任务精确过滤
                        Ok(db) => match db.upsert_features(
                            &features,
                            if task_id > 0 { Some(task_id) } else { None },
                        ) {
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
    output_crs: Option<String>,
) -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;

    let mut buoys = if let (Some(w), Some(s), Some(e), Some(n)) = (west, south, east, north) {
        let bounds = ChartBounds::new(w, s, e, n);
        db.get_buoys_in_bounds(&bounds)?
    } else {
        db.get_all_buoys()?
    };

    if buoys.is_empty() {
        return Err("没有可导出的航标数据".to_string());
    }

    // 航标 lon_84/lat_84 为 WGS-84；按需转到导出坐标系（gcj02 / bd09）
    if let Some(crs) = output_crs.as_deref() {
        if crs != "wgs84" && !crs.is_empty() {
            for b in buoys.iter_mut() {
                if let (Some(lon), Some(lat)) = (b.lon_84, b.lat_84) {
                    let (x, y) = crate::coords::wgs84_to_crs(crs, lon, lat);
                    b.lon_84 = Some(x);
                    b.lat_84 = Some(y);
                }
            }
        }
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

/// 解析一个 GeoJSON 多边形的全部环（外环 + 洞），过滤掉点数 < 3 的环。
fn parse_one_polygon(rings_val: &serde_json::Value) -> Vec<OutlineRing> {
    rings_val
        .as_array()
        .map(|rs| {
            rs.iter()
                .map(parse_outline_ring)
                .filter(|r| r.len() >= 3)
                .collect()
        })
        .unwrap_or_default()
}

/// 取 GeoJSON geometry 的所有多边形，每个多边形含全部环（外环 + 洞）。
fn polygons_all_rings(geom: &serde_json::Value) -> Vec<Vec<OutlineRing>> {
    match geom.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "Polygon" => {
            let p = geom
                .get("coordinates")
                .map(parse_one_polygon)
                .unwrap_or_default();
            if p.is_empty() {
                vec![]
            } else {
                vec![p]
            }
        }
        "MultiPolygon" => geom
            .get("coordinates")
            .and_then(|c| c.as_array())
            .map(|polys| {
                polys
                    .iter()
                    .map(parse_one_polygon)
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// 射线法：点是否在环内
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

/// 外环有符号面积（lon=x, lat=y；CCW 为正）
fn signed_ring_area(ring: &OutlineRing) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        j = i;
    }
    a / 2.0
}

/// 开线 Douglas–Peucker 简化（保留首末点）
fn douglas_peucker(pts: &[[f64; 2]], eps: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n <= 2 || eps <= 0.0 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((s, e)) = stack.pop() {
        let (ax, ay) = (pts[s][0], pts[s][1]);
        let (bx, by) = (pts[e][0], pts[e][1]);
        let dx = bx - ax;
        let dy = by - ay;
        let len = (dx * dx + dy * dy).sqrt().max(1e-12);
        let mut max_d = -1.0;
        let mut idx = 0usize;
        for i in (s + 1)..e {
            let (px, py) = (pts[i][0], pts[i][1]);
            let d = ((px - ax) * dy - (py - ay) * dx).abs() / len;
            if d > max_d {
                max_d = d;
                idx = i;
            }
        }
        if max_d > eps && idx > 0 {
            keep[idx] = true;
            stack.push((s, idx));
            stack.push((idx, e));
        }
    }
    let mut out = Vec::new();
    for i in 0..n {
        if keep[i] {
            out.push(pts[i]);
        }
    }
    out
}

/// 闭合环 DP 简化：闭合环首尾同点，直接套用开线 DP 会因基线长度为 0 把中间点全删掉。
/// 在离起点最远顶点处把环切成两段开线分别简化，再拼回闭合环，避免退化。
/// 与前端 geo.ts 的 simplifyClosedRing 同一套算法。
fn simplify_closed_ring(ring: &OutlineRing, eps: f64) -> OutlineRing {
    let n = ring.len();
    if n <= 5 {
        return ring.clone();
    }
    let pts = &ring[..n - 1]; // 去掉闭合重复末点
    let m = pts.len();
    let mut far = 0usize;
    let mut far_d = -1.0;
    for i in 1..m {
        let dx = pts[i][0] - pts[0][0];
        let dy = pts[i][1] - pts[0][1];
        let d = dx * dx + dy * dy;
        if d > far_d {
            far_d = d;
            far = i;
        }
    }
    let arc1: Vec<[f64; 2]> = pts[..=far].to_vec();
    let mut arc2: Vec<[f64; 2]> = pts[far..].to_vec();
    arc2.push(pts[0]);
    let s1 = douglas_peucker(&arc1, eps);
    let s2 = douglas_peucker(&arc2, eps);
    let mut merged = s1;
    merged.extend_from_slice(&s2[1..]);
    if merged.len() >= 4 {
        merged
    } else {
        ring.clone()
    }
}

/// 把 HYDRO_A 水域面真正并集（dissolve）成岸线围栏：栅格化（单元中心点落在任一
/// 水域外环内即为水）+ 单元边界有向边追踪，输出合并后的外环（CCW），消掉内部
/// 共享边与洞。跨要素合并，结果是若干条「围栏」要素，替换掉原始 HYDRO_A 多边形
/// 要素；非 HYDRO_A 要素、HYDRO_A 中的非多边形要素，原样保留。
/// 与前端 geo.ts 的 dissolveOutlineGrid 同一套算法。
fn dissolve_water_outlines(features: Vec<ChartFeatureInfo>) -> Vec<ChartFeatureInfo> {
    const TARGET_CELLS: f64 = 4096.0;

    // 1) 收集所有水域面多边形（含全部环：外环 + 洞）+ 总 bbox；记录哪些要素是水域多边形
    let mut polygons: Vec<Vec<OutlineRing>> = Vec::new();
    let mut poly_bboxes: Vec<OutlineBbox> = Vec::new();
    let mut bbox = OutlineBbox::empty();
    let mut had_polygon: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut template: Option<ChartFeatureInfo> = None;
    for (idx, f) in features.iter().enumerate() {
        if f.source_layer != "HYDRO_A" {
            continue;
        }
        let geom: serde_json::Value = match serde_json::from_str(&f.geometry_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for poly in polygons_all_rings(&geom) {
            had_polygon.insert(idx);
            let bb = outline_ring_bbox(&poly[0]); // 外环 bbox
            bbox.extend(&bb);
            poly_bboxes.push(bb);
            polygons.push(poly);
            if template.is_none() {
                template = Some(f.clone());
            }
        }
    }
    if polygons.is_empty() {
        return features; // 没有水域多边形，原样返回
    }

    let lon_span = bbox.max_lon - bbox.min_lon;
    let lat_span = bbox.max_lat - bbox.min_lat;
    if !(lon_span > 0.0) || !(lat_span > 0.0) {
        return features;
    }
    let cell = lon_span.max(lat_span) / TARGET_CELLS;
    let origin_lon = bbox.min_lon - cell;
    let origin_lat = bbox.min_lat - cell;
    let cols = (lon_span / cell).ceil() as usize + 2;
    let rows = (lat_span / cell).ceil() as usize + 2;

    // 2) 扫描线栅格化：每个多边形按其全部环 even-odd 填进占据网格 occ（自动挖掉洞），
    //    多边形相互覆盖即得并集占据。采样取每格中心；水平边按半开区间规则跳过。
    let mut occ = vec![0u8; cols * rows];
    let mut xs: Vec<f64> = Vec::new();
    for (pi, poly) in polygons.iter().enumerate() {
        let pb = &poly_bboxes[pi];
        let mut j0 = ((pb.min_lat - origin_lat) / cell - 0.5).floor() as isize;
        let mut j1 = ((pb.max_lat - origin_lat) / cell - 0.5).ceil() as isize;
        if j0 < 0 {
            j0 = 0;
        }
        if j1 > rows as isize - 1 {
            j1 = rows as isize - 1;
        }
        for j in j0..=j1 {
            let jj = j as usize;
            let lat = origin_lat + (jj as f64 + 0.5) * cell;
            xs.clear();
            for ring in poly {
                let n = ring.len();
                if n < 3 {
                    continue;
                }
                let mut l = n - 1;
                for k in 0..n {
                    let ay = ring[l][1];
                    let by = ring[k][1];
                    if (ay <= lat && by > lat) || (by <= lat && ay > lat) {
                        let ax = ring[l][0];
                        let bx = ring[k][0];
                        xs.push(ax + (lat - ay) / (by - ay) * (bx - ax));
                    }
                    l = k;
                }
            }
            if xs.len() < 2 {
                continue;
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut k = 0;
            while k + 1 < xs.len() {
                let mut i0 = ((xs[k] - origin_lon) / cell - 0.5).ceil() as isize;
                let mut i1 = ((xs[k + 1] - origin_lon) / cell - 0.5).floor() as isize;
                if i0 < 0 {
                    i0 = 0;
                }
                if i1 > cols as isize - 1 {
                    i1 = cols as isize - 1;
                }
                if i1 >= i0 {
                    let base = jj * cols;
                    let mut i = i0;
                    while i <= i1 {
                        occ[base + i as usize] = 1;
                        i += 1;
                    }
                }
                k += 2;
            }
        }
    }
    let filled = |i: isize, j: isize| -> bool {
        i >= 0
            && j >= 0
            && (i as usize) < cols
            && (j as usize) < rows
            && occ[(j as usize) * cols + (i as usize)] == 1
    };

    // 3) 边界有向边：水域单元在左 → 外环 CCW、洞 CW。key = i*(rows+2)+j
    let rstride = rows + 2;
    let mut next: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for j in 0..rows {
        for i in 0..cols {
            if occ[j * cols + i] != 1 {
                continue;
            }
            let (ii, jj) = (i as isize, j as isize);
            if !filled(ii, jj - 1) {
                next.entry(i * rstride + j).or_default().push((i + 1) * rstride + j);
            }
            if !filled(ii + 1, jj) {
                next.entry((i + 1) * rstride + j).or_default().push((i + 1) * rstride + (j + 1));
            }
            if !filled(ii, jj + 1) {
                next.entry((i + 1) * rstride + (j + 1)).or_default().push(i * rstride + (j + 1));
            }
            if !filled(ii - 1, jj) {
                next.entry(i * rstride + (j + 1)).or_default().push(i * rstride + j);
            }
        }
    }

    // 4) 有向边串成闭环
    let corner_lon = |i: usize| origin_lon + (i as f64) * cell;
    let corner_lat = |j: usize| origin_lat + (j as f64) * cell;
    let guard_max = cols * rows * 4 + 8;
    let min_area = (4.0 * cell) * (4.0 * cell); // 丢掉小于约 4 格见方的噪点环（小水体 / 小岛）
    let start_keys: Vec<usize> = next.keys().cloned().collect();
    struct Outer {
        ring: OutlineRing,
        area: f64,
        bbox: OutlineBbox,
    }
    let mut outers: Vec<Outer> = Vec::new();
    let mut holes: Vec<OutlineRing> = Vec::new();
    for &start in &start_keys {
        loop {
            let has = next.get(&start).map(|v| !v.is_empty()).unwrap_or(false);
            if !has {
                break;
            }
            let mut ring: OutlineRing = Vec::new();
            let mut cur = start;
            let mut guard = guard_max;
            while guard > 0 {
                guard -= 1;
                let nk = match next.get_mut(&cur).and_then(|v| v.pop()) {
                    Some(k) => k,
                    None => break,
                };
                ring.push([corner_lon(cur / rstride), corner_lat(cur % rstride)]);
                cur = nk;
                if cur == start {
                    ring.push([corner_lon(cur / rstride), corner_lat(cur % rstride)]);
                    break;
                }
            }
            if ring.len() < 4 {
                continue;
            }
            let first = ring[0];
            let last = ring[ring.len() - 1];
            if (first[0] - last[0]).abs() > f64::EPSILON || (first[1] - last[1]).abs() > f64::EPSILON {
                ring.push(first);
            }
            let area = signed_ring_area(&ring);
            if area.abs() <= min_area {
                continue; // 太小的水体 / 小岛，丢掉
            }
            let simplified = simplify_closed_ring(&ring, cell * 0.7);
            if simplified.len() < 4 {
                continue;
            }
            if area > 0.0 {
                let bb = outline_ring_bbox(&simplified);
                outers.push(Outer {
                    ring: simplified,
                    area,
                    bbox: bb,
                });
            } else {
                holes.push(simplified); // CW 环 = 中间的陆地 / 岛，作为洞挖掉
            }
        }
    }

    // 把每个洞（岛）分配给包含它的最小外环 → 中间陆地被挖空
    outers.sort_by(|a, b| a.area.partial_cmp(&b.area).unwrap_or(std::cmp::Ordering::Equal));
    let mut hole_lists: Vec<Vec<OutlineRing>> = outers.iter().map(|_| Vec::new()).collect();
    for h in holes {
        if h.is_empty() {
            continue;
        }
        let px = h[0][0];
        let py = h[0][1];
        for (oi, o) in outers.iter().enumerate() {
            let b = &o.bbox;
            if px < b.min_lon || px > b.max_lon || py < b.min_lat || py > b.max_lat {
                continue;
            }
            if outline_point_in_ring(px, py, &o.ring) {
                hole_lists[oi].push(h);
                break;
            }
        }
    }

    // 5) 重建要素：保留所有非水域多边形要素，追加合并后的带洞围栏要素（每个水域一个）
    let mut out: Vec<ChartFeatureInfo> = Vec::new();
    for (idx, f) in features.into_iter().enumerate() {
        if !had_polygon.contains(&idx) {
            out.push(f);
        }
    }
    if let Some(tmpl) = template {
        for (k, o) in outers.iter().enumerate() {
            let mut rings_json: Vec<serde_json::Value> = Vec::new();
            rings_json.push(serde_json::Value::Array(
                o.ring.iter().map(|c| serde_json::json!([c[0], c[1]])).collect(),
            ));
            for hole in &hole_lists[k] {
                rings_json.push(serde_json::Value::Array(
                    hole.iter().map(|c| serde_json::json!([c[0], c[1]])).collect(),
                ));
            }
            let geom = serde_json::json!({ "type": "Polygon", "coordinates": rings_json });
            let bb = &o.bbox;
            let mut f = tmpl.clone();
            f.id = format!("hydro-outline-{}", k);
            f.source_feature_id = Some(format!("hydro-outline-{}", k));
            f.geometry_type = Some("Polygon".to_string());
            f.geometry_json = serde_json::to_string(&geom).unwrap_or_default();
            f.raw_json = f.geometry_json.clone();
            f.min_lon = Some(bb.min_lon);
            f.min_lat = Some(bb.min_lat);
            f.max_lon = Some(bb.max_lon);
            f.max_lat = Some(bb.max_lat);
            out.push(f);
        }
    }
    out
}

/// 递归把 GeoJSON coordinates 里每个 [lon,lat] 做坐标转换（就地修改）
fn transform_coords_in_place(v: &mut serde_json::Value, f: &dyn Fn(f64, f64) -> (f64, f64)) {
    if let Some(arr) = v.as_array_mut() {
        if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
            if let (Some(lon), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                let (nl, na) = f(lon, lat);
                arr[0] = serde_json::json!(nl);
                arr[1] = serde_json::json!(na);
            }
        } else {
            for item in arr.iter_mut() {
                transform_coords_in_place(item, f);
            }
        }
    }
}

/// 递归从 GeoJSON coordinates 收集 bbox
fn collect_bbox_from_coords(v: &serde_json::Value, bb: &mut OutlineBbox) {
    if let Some(arr) = v.as_array() {
        if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
            if let (Some(lon), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                if lon < bb.min_lon {
                    bb.min_lon = lon;
                }
                if lon > bb.max_lon {
                    bb.max_lon = lon;
                }
                if lat < bb.min_lat {
                    bb.min_lat = lat;
                }
                if lat > bb.max_lat {
                    bb.max_lat = lat;
                }
            }
        } else {
            for item in arr {
                collect_bbox_from_coords(item, bb);
            }
        }
    }
}

/// 把航道要素几何从 WGS-84 转到目标坐标系（gcj02 / bd09），并更新 bbox。
/// crs 为 wgs84 / 空时不动。
fn apply_crs_to_chart_features(features: &mut [ChartFeatureInfo], crs: &str) {
    if crs.is_empty() || crs == "wgs84" {
        return;
    }
    let conv = |lon: f64, lat: f64| crate::coords::wgs84_to_crs(crs, lon, lat);
    for feat in features.iter_mut() {
        if let Ok(mut geom) = serde_json::from_str::<serde_json::Value>(&feat.geometry_json) {
            if let Some(coords) = geom.get_mut("coordinates") {
                transform_coords_in_place(coords, &conv);
                let mut bb = OutlineBbox::empty();
                collect_bbox_from_coords(coords, &mut bb);
                if bb.min_lon.is_finite() && bb.max_lon.is_finite() {
                    feat.min_lon = Some(bb.min_lon);
                    feat.min_lat = Some(bb.min_lat);
                    feat.max_lon = Some(bb.max_lon);
                    feat.max_lat = Some(bb.max_lat);
                }
                feat.geometry_json =
                    serde_json::to_string(&geom).unwrap_or_else(|_| feat.geometry_json.clone());
            }
        }
        // raw_json 仅当本身是带 coordinates 的几何时才转换（如水域并集围栏要素）
        if let Ok(mut raw) = serde_json::from_str::<serde_json::Value>(&feat.raw_json) {
            if let Some(coords) = raw.get_mut("coordinates") {
                transform_coords_in_place(coords, &conv);
                feat.raw_json =
                    serde_json::to_string(&raw).unwrap_or_else(|_| feat.raw_json.clone());
            }
        }
    }
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
    output_crs: Option<String>,
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
        features = dissolve_water_outlines(features);
    }

    if features.is_empty() {
        return Err("没有可导出的航道要素数据".to_string());
    }

    // 数据为 WGS-84；按需转到导出坐标系（gcj02 / bd09）
    apply_crs_to_chart_features(&mut features, output_crs.as_deref().unwrap_or("wgs84"));

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

/// 按来源图层获取航道专题要素（供航道图叠加展示）。
/// 传 task_id 且该任务有归属记录时，只返回该任务采到的要素；否则（老任务/未传）
/// 回退到按图层返回全部，保持旧行为不破坏。
#[tauri::command]
pub fn chart_get_features_by_layer(
    source_layer: String,
    task_id: Option<i64>,
) -> Result<Vec<ChartFeatureInfo>, String> {
    if source_layer != "electronic_fence" && source_layer != "HYDRO_A" {
        return Err(format!("不支持的航道要素图层: {}", source_layer));
    }

    let db = ChartDatabase::new(&get_db_path())?;
    match task_id {
        Some(tid) if db.task_has_feature_associations(tid).unwrap_or(false) => {
            db.get_features_by_layer_and_task(&source_layer, tid)
        }
        _ => db.get_features_by_layer(&source_layer),
    }
}

/// 按来源图层和 bbox 获取航道专题要素（供视野内叠加展示）。
/// task_id 同上：有归属记录则按任务精确过滤，否则回退到纯 bbox。
#[tauri::command]
pub fn chart_get_features_by_layer_in_bounds(
    source_layer: String,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    task_id: Option<i64>,
) -> Result<Vec<ChartFeatureInfo>, String> {
    if source_layer != "electronic_fence" && source_layer != "HYDRO_A" {
        return Err(format!("不支持的航道要素图层: {}", source_layer));
    }

    let bounds = ChartBounds::new(west, south, east, north);
    if !bounds.is_valid() {
        return Err("无效的边界范围".to_string());
    }

    let db = ChartDatabase::new(&get_db_path())?;
    match task_id {
        Some(tid) if db.task_has_feature_associations(tid).unwrap_or(false) => {
            db.get_features_by_layer_and_task_in_bounds(&source_layer, tid, &bounds)
        }
        _ => db.get_features_by_layer_in_bounds(&source_layer, &bounds),
    }
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
