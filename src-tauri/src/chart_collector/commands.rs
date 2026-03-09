//! Tauri 命令入口
//! 为前端暴露航道图采集相关的命令

use super::buoy_collector::BuoyCollector;
use super::composer::ChartComposer;
use super::database::ChartDatabase;
use super::tile_fetcher::{estimate_chart_tiles, ChartTileFetcher};
use super::types::*;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// 全局停止标志
static STOP_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// 全局任务状态
static TASK_STATUS: Lazy<RwLock<ChartTaskStatus>> =
    Lazy::new(|| RwLock::new(ChartTaskStatus::Idle));

/// 获取数据库路径
pub fn get_db_path() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("chart_data.db").to_string_lossy().to_string()
}

/// 获取默认输出路径
fn get_default_output_dir() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("chart_tiles").to_string_lossy().to_string()
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
) -> Result<String, String> {
    // 检查是否已有任务在运行
    {
        let status = TASK_STATUS.read();
        match *status {
            ChartTaskStatus::CollectingBuoys | ChartTaskStatus::DownloadingTiles => {
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

    // 转发进度事件到前端
    let app_progress = app.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_progress.emit("chart-progress", &event);
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
    let db_path = get_db_path();
    tokio::spawn(async move {
        // 创建任务记录
        let task_id = match ChartDatabase::new(&db_path) {
            Ok(db) => db.create_chart_task("buoy", 0).unwrap_or(0),
            Err(_) => 0,
        };

        let collector = BuoyCollector::new(step);
        let result = collector
            .collect(&bounds, stop_flag, progress_tx, log_tx.clone())
            .await;

        match result {
            Ok(buoys) => {
                let _ = log_tx
                    .send(format!("💾 正在保存 {} 个航标到数据库...", buoys.len()))
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
                                .send(format!("✅ 航标采集完成，入库 {} 条", count))
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
                            let _ = log_tx.send(format!("❌ 保存数据库失败: {}", e)).await;
                        }
                    },
                    Err(e) => {
                        *TASK_STATUS.write() = ChartTaskStatus::Failed;
                        let _ = log_tx.send(format!("❌ 打开数据库失败: {}", e)).await;
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
                let _ = log_tx.send(format!("❌ 航标采集失败: {}", e)).await;
            }
        }
    });

    // 立即返回，不阻塞
    Ok("航标采集已启动（后台运行）".to_string())
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
            ChartTaskStatus::CollectingBuoys | ChartTaskStatus::DownloadingTiles => {
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
                "🗺️ 开始瓦片下载: {} 个图层, 级别 {:?}, 输出: {}",
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
                    .send(format!("✅ 瓦片下载完成，共 {} 个", count))
                    .await;
            }
            Err(e) => {
                *TASK_STATUS.write() = ChartTaskStatus::Failed;
                let _ = log_tx.send(format!("❌ 瓦片下载失败: {}", e)).await;
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

/// 清空航标数据
#[tauri::command]
pub fn chart_clear_buoys() -> Result<String, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.clear_buoys()?;
    Ok("航标数据已清空".to_string())
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

/// 获取航标按类型分组统计
#[tauri::command]
pub fn chart_get_buoy_stats() -> Result<Vec<(String, i64)>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_buoy_stats()
}

/// 获取所有航标数据（供前端表格展示）
#[tauri::command]
pub fn chart_get_all_buoys() -> Result<Vec<BuoyInfo>, String> {
    let db = ChartDatabase::new(&get_db_path())?;
    db.get_all_buoys()
}
