//! 航道图瓦片下载器
//! 支持 ArcGIS REST 瓦片格式 (z/y/x)

use super::types::*;
use log::{error, info, warn};
use rand::Rng;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// ArcGIS WGS84 (4326) 切片方案的 LOD 分辨率表
/// 来源: MapServer?f=json → tileInfo.lods
/// origin: {x: -400, y: 400}, tile_size: 256x256
const TILE_ORIGIN_X: f64 = -400.0;
const TILE_ORIGIN_Y: f64 = 400.0;
const TILE_SIZE: f64 = 256.0;

/// LOD 0-13 的分辨率（度/像素）
const LOD_RESOLUTIONS: [f64; 14] = [
    0.023794610058302804,  // level 0  - scale 10,000,000
    0.00951784402332112,   // level 1  - scale 4,000,000
    0.00475892201166056,   // level 2  - scale 2,000,000
    0.00237946100583028,   // level 3  - scale 1,000,000
    0.00118973050291514,   // level 4  - scale 500,000
    5.9486525145757E-4,    // level 5  - scale 250,000
    2.97432625728785E-4,   // level 6  - scale 125,000
    1.487163128643925E-4,  // level 7  - scale 62,500
    7.435815643219625E-5,  // level 8  - scale 31,250
    3.7179078216098126E-5, // level 9  - scale 15,625
    1.859072883855198E-5,  // level 10 - scale 7,813
    9.294174688773075E-6,  // level 11 - scale 3,906
    4.647087344386537E-6,  // level 12 - scale 1,953
    2.37946100583028E-6,   // level 13 - scale 1,000
];

/// 经纬度转 ArcGIS WGS84(4326) 瓦片坐标
/// 使用 ArcGIS 自定义切片方案: origin={-400,400}, 分辨率表来自服务端元数据
pub fn lon_lat_to_tile(lon: f64, lat: f64, z: u32) -> (u32, u32) {
    let z_idx = z as usize;
    if z_idx >= LOD_RESOLUTIONS.len() {
        // 超出支持的级别，回退到最大级别
        let res = LOD_RESOLUTIONS[LOD_RESOLUTIONS.len() - 1];
        let x = ((lon - TILE_ORIGIN_X) / (res * TILE_SIZE)).floor() as u32;
        let y = ((TILE_ORIGIN_Y - lat) / (res * TILE_SIZE)).floor() as u32;
        return (x, y);
    }
    let res = LOD_RESOLUTIONS[z_idx];
    let x = ((lon - TILE_ORIGIN_X) / (res * TILE_SIZE)).floor() as u32;
    let y = ((TILE_ORIGIN_Y - lat) / (res * TILE_SIZE)).floor() as u32;
    (x, y)
}

/// 计算指定范围和缩放级别的瓦片坐标列表
pub fn calculate_chart_tiles(bounds: &ChartBounds, zoom_levels: &[u32]) -> Vec<ChartTileCoord> {
    let mut tiles = Vec::new();

    for &z in zoom_levels {
        let (x_min, y_min) = lon_lat_to_tile(bounds.west, bounds.north, z);
        let (x_max, y_max) = lon_lat_to_tile(bounds.east, bounds.south, z);

        for y in y_min..=y_max {
            for x in x_min..=x_max {
                tiles.push(ChartTileCoord::new(z, y, x));
            }
        }
    }

    tiles
}

/// 估算瓦片数量
pub fn estimate_chart_tiles(
    bounds: &ChartBounds,
    zoom_levels: &[u32],
    layers: &[ChartLayer],
) -> ChartTileEstimate {
    let mut total_tiles: u64 = 0;
    let mut tiles_per_level = Vec::new();

    for &z in zoom_levels {
        let (x_min, y_min) = lon_lat_to_tile(bounds.west, bounds.north, z);
        let (x_max, y_max) = lon_lat_to_tile(bounds.east, bounds.south, z);

        let count = ((x_max - x_min + 1) as u64) * ((y_max - y_min + 1) as u64);
        tiles_per_level.push((z, count));
        total_tiles += count;
    }

    let layers_count = layers.len();
    let total_with_layers = total_tiles * layers_count as u64;

    ChartTileEstimate {
        total_tiles,
        tiles_per_level,
        layers_count,
        total_with_layers,
    }
}

/// 航道图瓦片下载器
pub struct ChartTileFetcher {
    client: reqwest::Client,
    output_dir: PathBuf,
}

impl ChartTileFetcher {
    pub fn new(output_dir: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            output_dir: PathBuf::from(output_dir),
        }
    }

    /// 获取瓦片本地文件路径
    fn tile_path(&self, layer: &ChartLayer, tile: &ChartTileCoord) -> PathBuf {
        self.output_dir
            .join(layer.id())
            .join(tile.z.to_string())
            .join(format!("{}_{}.png", tile.y, tile.x))
    }

    /// 检查瓦片是否已存在（断点续传）
    fn tile_exists(&self, layer: &ChartLayer, tile: &ChartTileCoord) -> bool {
        let path = self.tile_path(layer, tile);
        path.exists()
            && std::fs::metadata(&path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
    }

    /// 构建请求头
    fn build_headers(&self, layer: &ChartLayer) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        for (key, value) in layer.get_headers() {
            if let (Ok(name), Ok(val)) = (
                key.parse::<reqwest::header::HeaderName>(),
                value.parse::<reqwest::header::HeaderValue>(),
            ) {
                headers.insert(name, val);
            }
        }
        headers
    }

    /// 下载单个瓦片
    async fn download_tile(&self, layer: &ChartLayer, tile: &ChartTileCoord) -> Result<(), String> {
        let url = layer.tile_url(tile.z, tile.y, tile.x);
        let file_path = self.tile_path(layer, tile);

        // 确保目录存在
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }

        let headers = self.build_headers(layer);

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("下载瓦片失败 {}: {}", url, e))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {} for {}", status, url));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("读取瓦片数据失败: {}", e))?;

        // 检查是否为有效图片（简单判断大小）
        if bytes.len() < 100 {
            return Err(format!("瓦片数据太小 ({}B), 可能无效", bytes.len()));
        }

        std::fs::write(&file_path, &bytes).map_err(|e| format!("保存瓦片失败: {}", e))?;

        Ok(())
    }

    /// 下载指定范围的所有瓦片
    pub async fn download(
        &self,
        bounds: &ChartBounds,
        zoom_levels: &[u32],
        layers: &[ChartLayer],
        stop_flag: Arc<AtomicBool>,
        progress_tx: mpsc::Sender<ChartProgressEvent>,
    ) -> Result<u64, String> {
        let tiles = calculate_chart_tiles(bounds, zoom_levels);
        let total = (tiles.len() * layers.len()) as u64;
        let completed = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicU64::new(0));
        let skipped = Arc::new(AtomicU64::new(0));

        info!(
            "瓦片下载: {} 个坐标 × {} 个图层 = {} 个瓦片",
            tiles.len(),
            layers.len(),
            total
        );

        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "tile".to_string(),
                status: "downloading".to_string(),
                current: 0,
                total,
                message: Some(format!("开始下载，共 {} 个瓦片", total)),
            })
            .await;

        for layer in layers {
            for tile in &tiles {
                if stop_flag.load(Ordering::Relaxed) {
                    info!("瓦片下载已停止");
                    return Ok(completed.load(Ordering::Relaxed));
                }

                // 断点续传：跳过已存在的瓦片
                if self.tile_exists(layer, tile) {
                    skipped.fetch_add(1, Ordering::Relaxed);
                    completed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }

                let max_retries = 3;

                for retry in 0..max_retries {
                    match self.download_tile(layer, tile).await {
                        Ok(_) => {
                            completed.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        Err(e) => {
                            if retry < max_retries - 1 {
                                warn!(
                                    "瓦片 {}/{}/{}/{} 下载失败 (重试 {}/{}): {}",
                                    layer.id(),
                                    tile.z,
                                    tile.y,
                                    tile.x,
                                    retry + 1,
                                    max_retries,
                                    e
                                );
                                tokio::time::sleep(Duration::from_millis(1000)).await;
                            } else {
                                error!(
                                    "瓦片 {}/{}/{}/{} 下载最终失败: {}",
                                    layer.id(),
                                    tile.z,
                                    tile.y,
                                    tile.x,
                                    e
                                );
                                failed.fetch_add(1, Ordering::Relaxed);
                                completed.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }

                let current = completed.load(Ordering::Relaxed);
                // 每 10 个瓦片发一次进度
                if current % 10 == 0 || current == total {
                    let _ = progress_tx
                        .send(ChartProgressEvent {
                            task_type: "tile".to_string(),
                            status: "downloading".to_string(),
                            current,
                            total,
                            message: Some(format!(
                                "图层 {} | Z={} | 进度 {}/{} (跳过: {}, 失败: {})",
                                layer.name(),
                                tile.z,
                                current,
                                total,
                                skipped.load(Ordering::Relaxed),
                                failed.load(Ordering::Relaxed),
                            )),
                        })
                        .await;
                }

                // 随机延迟 500-1500ms
                let delay = {
                    let mut rng = rand::thread_rng();
                    rng.gen_range(500..1500u64)
                };
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        }

        let final_completed = completed.load(Ordering::Relaxed);
        let final_failed = failed.load(Ordering::Relaxed);
        let final_skipped = skipped.load(Ordering::Relaxed);

        info!(
            "瓦片下载完成: 总计 {}, 成功 {}, 跳过 {}, 失败 {}",
            total,
            final_completed - final_failed - final_skipped,
            final_skipped,
            final_failed
        );

        let _ = progress_tx
            .send(ChartProgressEvent {
                task_type: "tile".to_string(),
                status: "completed".to_string(),
                current: total,
                total,
                message: Some(format!(
                    "下载完成！成功 {}, 跳过 {}, 失败 {}",
                    final_completed - final_failed - final_skipped,
                    final_skipped,
                    final_failed
                )),
            })
            .await;

        Ok(final_completed - final_failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lon_lat_to_tile() {
        // Z=8, 荆州附近 (112.24, 30.33)
        let (x, y) = lon_lat_to_tile(112.24, 30.33, 8);
        println!("Z=8, (112.24, 30.33) -> x={}, y={}", x, y);
        // 应该在合理范围内
        assert!(x > 200 && x < 220);
        assert!(y > 100 && y < 140);
    }

    #[test]
    fn test_calculate_tiles() {
        let bounds = ChartBounds::default_jingzhou_yueyang();
        let tiles = calculate_chart_tiles(&bounds, &[8]);
        println!("Z=8 tiles count: {}", tiles.len());
        assert!(tiles.len() > 0);

        // 验证瓦片坐标在合理范围
        for tile in &tiles {
            assert_eq!(tile.z, 8);
            assert!(tile.x > 200);
            assert!(tile.y > 100);
        }
    }

    #[test]
    fn test_estimate_tiles() {
        let bounds = ChartBounds::default_jingzhou_yueyang();
        let layers = vec![
            ChartLayer::Yizhangtu,
            ChartLayer::Cjshoudong,
            ChartLayer::Soundg,
        ];
        let estimate = estimate_chart_tiles(&bounds, &[4, 8], &layers);

        println!("Estimate: {:?}", estimate);
        assert!(estimate.total_tiles > 0);
        assert_eq!(estimate.layers_count, 3);
        assert_eq!(estimate.total_with_layers, estimate.total_tiles * 3);
    }
}
