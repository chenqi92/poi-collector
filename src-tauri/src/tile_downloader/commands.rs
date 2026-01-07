use super::database::TileDatabase;
use super::downloader::{calculate_tiles, estimate_tiles, TileDownloader};
use super::platforms::{create_platform, get_all_platforms};
use super::storage::create_storage;
use super::types::*;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use uuid::Uuid;

// 全局下载器实例
static TILE_DOWNLOADER: Lazy<TileDownloader> = Lazy::new(TileDownloader::new);

// 全局数据库实例
static TILE_DB: Lazy<RwLock<Option<Arc<TileDatabase>>>> = Lazy::new(|| RwLock::new(None));

/// 初始化瓦片数据库
fn get_tile_db(app: &AppHandle) -> Result<Arc<TileDatabase>, String> {
    let mut db_guard = TILE_DB.write();
    if db_guard.is_none() {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("获取应用目录失败: {}", e))?;
        std::fs::create_dir_all(&app_dir).ok();
        let db_path = app_dir.join("tile_data.db");
        let db = TileDatabase::new(&db_path).map_err(|e| format!("初始化数据库失败: {}", e))?;
        *db_guard = Some(Arc::new(db));
    }
    Ok(db_guard.as_ref().unwrap().clone())
}

/// 获取所有支持的平台
#[tauri::command]
pub fn get_tile_platforms() -> Vec<PlatformInfo> {
    get_all_platforms()
}

/// 计算瓦片数量
#[tauri::command]
pub fn calculate_tiles_count(bounds: Bounds, zoom_levels: Vec<u32>) -> TileEstimate {
    estimate_tiles(&bounds, &zoom_levels)
}

/// 创建下载任务
#[tauri::command]
pub async fn create_tile_task(app: AppHandle, config: TaskConfig) -> Result<String, String> {
    let db = get_tile_db(&app)?;

    // 验证参数
    if !config.bounds.is_valid() {
        return Err("无效的区域边界".to_string());
    }

    if config.zoom_levels.is_empty() {
        return Err("请至少选择一个层级".to_string());
    }

    if config.name.trim().is_empty() {
        return Err("请输入任务名称".to_string());
    }

    // 计算瓦片总数
    let tiles = calculate_tiles(&config.bounds, &config.zoom_levels);
    let total_tiles = tiles.len() as u64;

    // 生成任务ID
    let task_id = Uuid::new_v4().to_string();

    // 创建任务记录
    db.create_task(
        &task_id,
        &config.name,
        &config.platform,
        &config.map_type,
        &config.bounds,
        &config.zoom_levels,
        total_tiles,
        &config.output_path,
        &config.output_format,
        config.thread_count,
        config.retry_count,
        config.api_key.as_deref(),
    )
    .map_err(|e| format!("创建任务失败: {}", e))?;

    log::info!("创建下载任务: {} ({}), 共 {} 个瓦片", config.name, task_id, total_tiles);

    Ok(task_id)
}

/// 获取所有任务
#[tauri::command]
pub async fn get_tile_tasks(app: AppHandle) -> Result<Vec<TaskInfo>, String> {
    let db = get_tile_db(&app)?;

    let mut tasks = db
        .get_all_tasks()
        .map_err(|e| format!("获取任务列表失败: {}", e))?;

    // 更新运行中任务的实时状态
    for task in &mut tasks {
        if let Some(state) = TILE_DOWNLOADER.get_state(&task.id) {
            task.completed_tiles = state.completed.load(std::sync::atomic::Ordering::Relaxed);
            task.failed_tiles = state.failed.load(std::sync::atomic::Ordering::Relaxed);
            task.download_speed = state.calculate_speed();

            if state.is_paused.load(std::sync::atomic::Ordering::Relaxed) {
                task.status = "paused".to_string();
            } else if state.is_running.load(std::sync::atomic::Ordering::Relaxed) {
                task.status = "downloading".to_string();
            }
        }
    }

    Ok(tasks)
}

/// 获取单个任务
#[tauri::command]
pub async fn get_tile_task(app: AppHandle, task_id: String) -> Result<Option<TaskInfo>, String> {
    let db = get_tile_db(&app)?;

    let mut task = db
        .get_task(&task_id)
        .map_err(|e| format!("获取任务失败: {}", e))?;

    // 更新运行中任务的实时状态
    if let Some(ref mut t) = task {
        if let Some(state) = TILE_DOWNLOADER.get_state(&t.id) {
            t.completed_tiles = state.completed.load(std::sync::atomic::Ordering::Relaxed);
            t.failed_tiles = state.failed.load(std::sync::atomic::Ordering::Relaxed);
            t.download_speed = state.calculate_speed();

            if state.is_paused.load(std::sync::atomic::Ordering::Relaxed) {
                t.status = "paused".to_string();
            } else if state.is_running.load(std::sync::atomic::Ordering::Relaxed) {
                t.status = "downloading".to_string();
            }
        }
    }

    Ok(task)
}

/// 开始/恢复下载任务
#[tauri::command]
pub async fn start_tile_download(app: AppHandle, task_id: String) -> Result<(), String> {
    let db = get_tile_db(&app)?;

    // 获取任务信息
    let task = db
        .get_task(&task_id)
        .map_err(|e| format!("获取任务失败: {}", e))?
        .ok_or("任务不存在")?;

    // 检查是否已在运行
    if let Some(state) = TILE_DOWNLOADER.get_state(&task_id) {
        if state.is_running.load(std::sync::atomic::Ordering::Relaxed) {
            if state.is_paused.load(std::sync::atomic::Ordering::Relaxed) {
                // 恢复暂停的任务
                TILE_DOWNLOADER.resume(&task_id);
                return Ok(());
            }
            return Err("任务已在运行中".to_string());
        }
    }

    // 创建平台
    let platform = create_platform(&task.platform, task.api_key.as_deref());
    let map_type = MapType::from(task.map_type.as_str());

    // 创建进度通道
    let (progress_tx, mut progress_rx) = mpsc::channel::<ProgressEvent>(100);

    // 启动进度事件转发
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_handle.emit("tile-download-progress", &event);
        }
    });

    // 启动下载任务
    let db_clone = db.clone();
    let task_id_clone = task_id.clone();

    tokio::spawn(async move {
        if let Err(e) = TILE_DOWNLOADER
            .start_download(
                db_clone,
                task_id_clone.clone(),
                platform,
                map_type,
                task.bounds,
                task.zoom_levels,
                task.output_path,
                task.output_format,
                task.thread_count,
                task.retry_count,
                progress_tx,
            )
            .await
        {
            log::error!("下载任务 {} 失败: {}", task_id_clone, e);
        }
    });

    Ok(())
}

/// 暂停下载任务
#[tauri::command]
pub async fn pause_tile_download(app: AppHandle, task_id: String) -> Result<(), String> {
    let db = get_tile_db(&app)?;

    if TILE_DOWNLOADER.pause(&task_id) {
        db.update_task_status(&task_id, "paused").ok();
        Ok(())
    } else {
        Err("任务不存在或未运行".to_string())
    }
}

/// 停止/取消下载任务
#[tauri::command]
pub async fn cancel_tile_download(app: AppHandle, task_id: String) -> Result<(), String> {
    let db = get_tile_db(&app)?;

    TILE_DOWNLOADER.stop(&task_id);
    db.update_task_status(&task_id, "cancelled").ok();

    Ok(())
}

/// 删除任务
#[tauri::command]
pub async fn delete_tile_task(
    app: AppHandle,
    task_id: String,
    delete_files: bool,
) -> Result<(), String> {
    let db = get_tile_db(&app)?;

    // 先停止任务
    TILE_DOWNLOADER.stop(&task_id);

    // 获取任务信息
    if delete_files {
        if let Ok(Some(task)) = db.get_task(&task_id) {
            let path = Path::new(&task.output_path);
            if path.exists() {
                if path.is_dir() {
                    std::fs::remove_dir_all(path).ok();
                } else {
                    std::fs::remove_file(path).ok();
                }
            }
        }
    }

    // 删除数据库记录
    db.delete_task(&task_id)
        .map_err(|e| format!("删除任务失败: {}", e))?;

    Ok(())
}

/// 设置线程数
#[tauri::command]
pub async fn set_tile_thread_count(
    app: AppHandle,
    task_id: String,
    count: u32,
) -> Result<(), String> {
    let db = get_tile_db(&app)?;

    let count = count.max(1).min(32);
    TILE_DOWNLOADER.set_thread_count(&task_id, count);
    db.update_thread_count(&task_id, count).ok();

    Ok(())
}

/// 重试失败的瓦片
#[tauri::command]
pub async fn retry_failed_tiles(app: AppHandle, task_id: String) -> Result<u64, String> {
    let db = get_tile_db(&app)?;

    let count = db
        .reset_failed_tiles(&task_id)
        .map_err(|e| format!("重置失败瓦片失败: {}", e))?;

    // 更新任务状态
    db.update_task_status(&task_id, "pending").ok();

    Ok(count)
}

/// 解压/转换瓦片文件
#[tauri::command]
pub async fn convert_tile_file(
    input_path: String,
    output_path: String,
    output_format: String,
) -> Result<(), String> {
    let input = Path::new(&input_path);
    let output = Path::new(&output_path);

    if !input.exists() {
        return Err("输入文件不存在".to_string());
    }

    // 检测输入格式
    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match input_ext.as_str() {
        "zip" => {
            // ZIP 解压
            let file = std::fs::File::open(input)
                .map_err(|e| format!("打开文件失败: {}", e))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| format!("读取 ZIP 文件失败: {}", e))?;

            if output_format == "folder" {
                // 解压到文件夹
                std::fs::create_dir_all(output).ok();
                archive
                    .extract(output)
                    .map_err(|e| format!("解压失败: {}", e))?;
            } else if output_format == "mbtiles" {
                // 转换为 MBTiles
                let bounds = Bounds::new(85.0, -85.0, 180.0, -180.0); // 临时边界
                let mut storage = create_storage("mbtiles");
                storage.init(output, &bounds, &[])?;

                for i in 0..archive.len() {
                    let mut file = archive
                        .by_index(i)
                        .map_err(|e| format!("读取文件失败: {}", e))?;

                    if file.is_file() {
                        let name = file.name().to_string();
                        // 解析 z/x/y.png
                        let parts: Vec<&str> = name.trim_end_matches(".png").split('/').collect();
                        if parts.len() >= 3 {
                            if let (Ok(z), Ok(x), Ok(y)) = (
                                parts[parts.len() - 3].parse::<u32>(),
                                parts[parts.len() - 2].parse::<u32>(),
                                parts[parts.len() - 1].parse::<u32>(),
                            ) {
                                let mut data = Vec::new();
                                std::io::Read::read_to_end(&mut file, &mut data).ok();
                                storage.save_tile(&TileCoord::new(z, x, y), &data)?;
                            }
                        }
                    }
                }

                storage.finalize()?;
            }
        }
        "mbtiles" => {
            // MBTiles 转换
            let conn = rusqlite::Connection::open(input)
                .map_err(|e| format!("打开 MBTiles 失败: {}", e))?;

            if output_format == "folder" {
                // 导出到文件夹
                std::fs::create_dir_all(output).ok();

                let mut stmt = conn
                    .prepare("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles")
                    .map_err(|e| format!("查询失败: {}", e))?;

                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, u32>(0)?,
                            row.get::<_, u32>(1)?,
                            row.get::<_, u32>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                        ))
                    })
                    .map_err(|e| format!("读取瓦片失败: {}", e))?;

                for row in rows {
                    let (z, x, tms_y, data) = row.map_err(|e| format!("读取行失败: {}", e))?;
                    // TMS Y 翻转
                    let y = (1u32 << z) - 1 - tms_y;

                    let tile_dir = output.join(z.to_string()).join(x.to_string());
                    std::fs::create_dir_all(&tile_dir).ok();
                    let tile_path = tile_dir.join(format!("{}.png", y));
                    std::fs::write(&tile_path, &data).ok();
                }
            } else if output_format == "zip" {
                // 转换为 ZIP
                let bounds = Bounds::new(85.0, -85.0, 180.0, -180.0);
                let mut storage = create_storage("zip");
                storage.init(output, &bounds, &[])?;

                let mut stmt = conn
                    .prepare("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles")
                    .map_err(|e| format!("查询失败: {}", e))?;

                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, u32>(0)?,
                            row.get::<_, u32>(1)?,
                            row.get::<_, u32>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                        ))
                    })
                    .map_err(|e| format!("读取瓦片失败: {}", e))?;

                for row in rows {
                    let (z, x, tms_y, data) = row.map_err(|e| format!("读取行失败: {}", e))?;
                    let y = (1u32 << z) - 1 - tms_y;
                    storage.save_tile(&TileCoord::new(z, x, y), &data)?;
                }

                storage.finalize()?;
            }
        }
        _ => {
            return Err(format!("不支持的输入格式: {}", input_ext));
        }
    }

    Ok(())
}
