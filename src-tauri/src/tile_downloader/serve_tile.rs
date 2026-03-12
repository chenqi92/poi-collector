use super::commands::get_tile_db;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct CjhyTaskInfo {
    pub id: String,
    pub name: String,
    pub output_path: String,
    pub total_tiles: u64,
    pub completed_tiles: u64,
    pub failed_tiles: u64,
    pub bounds_north: f64,
    pub bounds_south: f64,
    pub bounds_east: f64,
    pub bounds_west: f64,
    pub zoom_levels: Vec<u32>,
}

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// 从本地磁盘读取瓦片图片，返回 base64 编码
/// 路径格式: {base_path}/{z}/{x}/{y}.png
#[tauri::command]
pub fn serve_local_tile(base_path: String, z: u32, x: u32, y: u32) -> Result<String, String> {
    let path = std::path::Path::new(&base_path)
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{}.png", y));

    match std::fs::read(&path) {
        Ok(data) => {
            // 跳过空白瓦片 (872字节 = cjhy标准透明PNG)
            if data.len() == 872 {
                return Ok(String::new());
            }
            Ok(BASE64.encode(&data))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 航道图空白区域：文件不存在是正常现象
            Ok(String::new())
        }
        Err(e) => Err(format!("读取瓦片失败: {}", e)),
    }
}

/// 获取所有 cjhy 平台已完成的(folder格式)下载任务
#[tauri::command]
pub async fn get_cjhy_tile_tasks(app: AppHandle) -> Result<Vec<CjhyTaskInfo>, String> {
    let db = get_tile_db(&app)?;
    let all_tasks = db
        .get_all_tasks()
        .map_err(|e| format!("获取任务列表失败: {}", e))?;

    let tasks: Vec<CjhyTaskInfo> = all_tasks
        .into_iter()
        .filter(|t| t.platform == "cjhy" && t.output_format == "folder")
        .map(|t| CjhyTaskInfo {
            id: t.id,
            name: t.name,
            output_path: t.output_path,
            total_tiles: t.total_tiles,
            completed_tiles: t.completed_tiles,
            failed_tiles: t.failed_tiles,
            bounds_north: t.bounds.north,
            bounds_south: t.bounds.south,
            bounds_east: t.bounds.east,
            bounds_west: t.bounds.west,
            zoom_levels: t.zoom_levels,
        })
        .collect();

    Ok(tasks)
}
