use super::database::TileDatabase;
use super::platforms::TilePlatform;
use super::storage::{create_storage, TileStorage};
use super::types::*;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// 计算经纬度边界内指定层级的所有瓦片坐标
pub fn calculate_tiles(bounds: &Bounds, zoom_levels: &[u32]) -> Vec<TileCoord> {
    let mut tiles = Vec::new();

    for &z in zoom_levels {
        let n = 2u32.pow(z);

        // 经度转瓦片X
        let x_min = ((bounds.west + 180.0) / 360.0 * n as f64).floor() as u32;
        let x_max = ((bounds.east + 180.0) / 360.0 * n as f64).floor() as u32;

        // 纬度转瓦片Y (Web Mercator)
        let lat_rad_north = bounds.north.to_radians();
        let lat_rad_south = bounds.south.to_radians();

        let y_min = ((1.0 - lat_rad_north.tan().asinh() / std::f64::consts::PI) / 2.0 * n as f64)
            .floor() as u32;
        let y_max = ((1.0 - lat_rad_south.tan().asinh() / std::f64::consts::PI) / 2.0 * n as f64)
            .floor() as u32;

        for x in x_min..=x_max.min(n - 1) {
            for y in y_min..=y_max.min(n - 1) {
                tiles.push(TileCoord::new(z, x, y));
            }
        }
    }

    tiles
}

/// 计算瓦片数量估算
pub fn estimate_tiles(bounds: &Bounds, zoom_levels: &[u32]) -> TileEstimate {
    let mut total_tiles = 0u64;
    let mut tiles_per_level = Vec::new();

    for &z in zoom_levels {
        let n = 2u32.pow(z);

        let x_min = ((bounds.west + 180.0) / 360.0 * n as f64).floor() as u32;
        let x_max = ((bounds.east + 180.0) / 360.0 * n as f64).floor() as u32;

        let lat_rad_north = bounds.north.to_radians();
        let lat_rad_south = bounds.south.to_radians();

        let y_min = ((1.0 - lat_rad_north.tan().asinh() / std::f64::consts::PI) / 2.0 * n as f64)
            .floor() as u32;
        let y_max = ((1.0 - lat_rad_south.tan().asinh() / std::f64::consts::PI) / 2.0 * n as f64)
            .floor() as u32;

        let x_count = (x_max.min(n - 1) - x_min + 1) as u64;
        let y_count = (y_max.min(n - 1) - y_min + 1) as u64;
        let count = x_count * y_count;

        tiles_per_level.push((z, count));
        total_tiles += count;
    }

    // 估算大小：假设每个瓦片平均 20KB
    let estimated_size_mb = (total_tiles as f64 * 20.0) / 1024.0;

    TileEstimate {
        total_tiles,
        tiles_per_level,
        estimated_size_mb,
    }
}

/// 下载器状态
pub struct DownloaderState {
    pub is_running: AtomicBool,
    pub is_paused: AtomicBool,
    pub completed: AtomicU64,
    pub failed: AtomicU64,
    pub thread_count: AtomicU32,
    pub current_zoom: AtomicU32,
    pub start_time: RwLock<Option<Instant>>,
}

impl DownloaderState {
    pub fn new(thread_count: u32) -> Self {
        Self {
            is_running: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            completed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            thread_count: AtomicU32::new(thread_count),
            current_zoom: AtomicU32::new(0),
            start_time: RwLock::new(None),
        }
    }

    pub fn calculate_speed(&self) -> f64 {
        if let Some(start) = *self.start_time.read() {
            let elapsed = start.elapsed().as_secs_f64();
            if elapsed > 0.0 {
                return self.completed.load(Ordering::Relaxed) as f64 / elapsed;
            }
        }
        0.0
    }
}

/// 瓦片下载器
pub struct TileDownloader {
    states: RwLock<HashMap<String, Arc<DownloaderState>>>,
}

impl TileDownloader {
    pub fn new() -> Self {
        Self {
            states: RwLock::new(HashMap::new()),
        }
    }

    /// 获取任务状态
    pub fn get_state(&self, task_id: &str) -> Option<Arc<DownloaderState>> {
        self.states.read().get(task_id).cloned()
    }

    /// 创建任务状态
    pub fn create_state(&self, task_id: &str, thread_count: u32) -> Arc<DownloaderState> {
        let state = Arc::new(DownloaderState::new(thread_count));
        self.states.write().insert(task_id.to_string(), state.clone());
        state
    }

    /// 移除任务状态
    pub fn remove_state(&self, task_id: &str) {
        self.states.write().remove(task_id);
    }

    /// 开始下载任务
    pub async fn start_download(
        &self,
        db: Arc<TileDatabase>,
        task_id: String,
        platform: Box<dyn TilePlatform>,
        map_type: MapType,
        bounds: Bounds,
        zoom_levels: Vec<u32>,
        output_path: String,
        output_format: String,
        thread_count: u32,
        retry_count: u32,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Result<(), String> {
        let state = self.create_state(&task_id, thread_count);

        // 计算所有瓦片
        let tiles = calculate_tiles(&bounds, &zoom_levels);
        let total_tiles = tiles.len() as u64;

        log::info!(
            "任务 {} 开始下载，共 {} 个瓦片，线程数 {}",
            task_id,
            total_tiles,
            thread_count
        );

        // 初始化进度到数据库
        db.init_tile_progress(&task_id, &tiles)
            .map_err(|e| format!("初始化进度失败: {}", e))?;

        // 更新任务状态
        db.update_task_status(&task_id, "downloading").ok();

        // 创建存储
        let storage = Arc::new(parking_lot::Mutex::new(create_storage(&output_format)));
        {
            let mut s = storage.lock();
            s.init(Path::new(&output_path), &bounds, &zoom_levels)?;
        }

        // 设置运行状态
        state.is_running.store(true, Ordering::SeqCst);
        *state.start_time.write() = Some(Instant::now());

        // 创建 HTTP 客户端
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let platform = Arc::new(platform);
        let db = db.clone();
        let task_id_clone = task_id.clone();

        // 下载循环
        loop {
            // 检查是否暂停
            if state.is_paused.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }

            // 检查是否停止
            if !state.is_running.load(Ordering::Relaxed) {
                break;
            }

            // 获取待下载瓦片
            let current_thread_count = state.thread_count.load(Ordering::Relaxed) as usize;
            let pending = db
                .get_pending_tiles(&task_id_clone, current_thread_count * 2)
                .map_err(|e| format!("获取待下载瓦片失败: {}", e))?;

            if pending.is_empty() {
                // 没有待下载的瓦片，检查是否有失败的需要重试
                let (_, completed, failed) = db
                    .get_tile_stats(&task_id_clone)
                    .map_err(|e| format!("获取统计失败: {}", e))?;

                if completed + failed >= total_tiles {
                    // 所有瓦片都已处理完成
                    break;
                }
            }

            // 更新当前层级
            if let Some(first) = pending.first() {
                state.current_zoom.store(first.z, Ordering::Relaxed);
            }

            // 并发下载
            let mut handles = Vec::new();
            for tile in pending.into_iter().take(current_thread_count) {
                let client = client.clone();
                let db = db.clone();
                let storage = storage.clone();
                let task_id = task_id_clone.clone();
                let state = state.clone();
                let retry_count = retry_count;
                let url = platform.get_tile_url(tile.z, tile.x, tile.y, &map_type);
                let headers = platform.get_headers();

                let handle = tokio::spawn(async move {
                    download_tile_with_url(
                        &client,
                        url,
                        headers,
                        &tile,
                        &db,
                        &storage,
                        &task_id,
                        &state,
                        retry_count,
                    )
                    .await
                });
                handles.push(handle);
            }

            // 等待所有下载完成
            for handle in handles {
                let _ = handle.await;
            }

            // 发送进度事件
            let completed = state.completed.load(Ordering::Relaxed);
            let failed = state.failed.load(Ordering::Relaxed);
            let speed = state.calculate_speed();

            let _ = progress_tx
                .send(ProgressEvent {
                    task_id: task_id_clone.clone(),
                    completed,
                    failed,
                    total: total_tiles,
                    speed,
                    current_zoom: state.current_zoom.load(Ordering::Relaxed),
                    status: "downloading".to_string(),
                    message: None,
                })
                .await;

            // 更新数据库进度
            db.update_task_progress(&task_id_clone, completed, failed).ok();

            // 短暂休息
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // 完成存储
        {
            let mut s = storage.lock();
            s.finalize()?;
        }

        // 更新最终状态
        let completed = state.completed.load(Ordering::Relaxed);
        let failed = state.failed.load(Ordering::Relaxed);

        if failed == 0 {
            db.set_task_completed(&task_id_clone).ok();
        } else {
            db.update_task_status(&task_id_clone, "completed").ok();
        }

        db.update_task_progress(&task_id_clone, completed, failed).ok();

        // 发送完成事件
        let _ = progress_tx
            .send(ProgressEvent {
                task_id: task_id_clone.clone(),
                completed,
                failed,
                total: total_tiles,
                speed: 0.0,
                current_zoom: 0,
                status: "completed".to_string(),
                message: Some(format!(
                    "下载完成，成功 {} 个，失败 {} 个",
                    completed, failed
                )),
            })
            .await;

        // 清理状态
        self.remove_state(&task_id);

        log::info!(
            "任务 {} 下载完成，成功 {}，失败 {}",
            task_id,
            completed,
            failed
        );

        Ok(())
    }

    /// 暂停任务
    pub fn pause(&self, task_id: &str) -> bool {
        if let Some(state) = self.get_state(task_id) {
            state.is_paused.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// 恢复任务
    pub fn resume(&self, task_id: &str) -> bool {
        if let Some(state) = self.get_state(task_id) {
            state.is_paused.store(false, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// 停止任务
    pub fn stop(&self, task_id: &str) -> bool {
        if let Some(state) = self.get_state(task_id) {
            state.is_running.store(false, Ordering::SeqCst);
            state.is_paused.store(false, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// 设置线程数
    pub fn set_thread_count(&self, task_id: &str, count: u32) -> bool {
        if let Some(state) = self.get_state(task_id) {
            state.thread_count.store(count.max(1).min(32), Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}

/// 下载单个瓦片（使用预先生成的URL）
async fn download_tile_with_url(
    client: &reqwest::Client,
    url: Option<String>,
    headers: std::collections::HashMap<String, String>,
    tile: &TileCoord,
    db: &TileDatabase,
    storage: &parking_lot::Mutex<Box<dyn TileStorage>>,
    task_id: &str,
    state: &DownloaderState,
    max_retries: u32,
) {
    let url = match url {
        Some(url) => url,
        None => {
            db.mark_tile_failed(task_id, tile, "不支持的地图类型").ok();
            state.failed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    let mut retries = 0;

    loop {
        let mut request = client.get(&url);
        for (key, value) in &headers {
            request = request.header(key, value);
        }

        match request.send().await {
            Ok(response) => {
                if response.status().is_success() {
                    match response.bytes().await {
                        Ok(data) => {
                            // 保存瓦片
                            let mut s = storage.lock();
                            if let Err(e) = s.save_tile(tile, &data) {
                                log::warn!("保存瓦片失败 {}/{}/{}: {}", tile.z, tile.x, tile.y, e);
                                db.mark_tile_failed(task_id, tile, &e).ok();
                                state.failed.fetch_add(1, Ordering::Relaxed);
                            } else {
                                db.mark_tile_completed(task_id, tile).ok();
                                state.completed.fetch_add(1, Ordering::Relaxed);
                            }
                            return;
                        }
                        Err(e) => {
                            if retries >= max_retries {
                                db.mark_tile_failed(task_id, tile, &e.to_string()).ok();
                                state.failed.fetch_add(1, Ordering::Relaxed);
                                return;
                            }
                        }
                    }
                } else if response.status().is_client_error() {
                    // 4xx 错误不重试
                    let error = format!("HTTP {}", response.status());
                    db.mark_tile_failed(task_id, tile, &error).ok();
                    state.failed.fetch_add(1, Ordering::Relaxed);
                    return;
                } else {
                    // 5xx 错误重试
                    if retries >= max_retries {
                        let error = format!("HTTP {}", response.status());
                        db.mark_tile_failed(task_id, tile, &error).ok();
                        state.failed.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                }
            }
            Err(e) => {
                if retries >= max_retries {
                    db.mark_tile_failed(task_id, tile, &e.to_string()).ok();
                    state.failed.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
        }

        retries += 1;
        // 指数退避
        let delay = Duration::from_millis(1000 * 2u64.pow(retries.min(4)));
        tokio::time::sleep(delay).await;
    }
}
