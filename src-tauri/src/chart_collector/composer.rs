//! 图像合成器
//! 将瓦片拼接为大图并叠加航标标记

use super::tile_fetcher::lon_lat_to_tile;
use super::types::*;
use image::{DynamicImage, Rgba, RgbaImage};
use log::info;
use std::path::{Path, PathBuf};

const TILE_SIZE: u32 = 256;

/// 图像合成器
pub struct ChartComposer {
    tiles_dir: PathBuf,
}

impl ChartComposer {
    pub fn new(tiles_dir: &str) -> Self {
        Self {
            tiles_dir: PathBuf::from(tiles_dir),
        }
    }

    /// 获取瓦片文件路径
    fn tile_path(&self, layer: &ChartLayer, z: u32, y: u32, x: u32) -> PathBuf {
        self.tiles_dir
            .join(layer.id())
            .join(z.to_string())
            .join(format!("{}_{}.png", y, x))
    }

    /// 加载单个瓦片图片
    fn load_tile(&self, layer: &ChartLayer, z: u32, y: u32, x: u32) -> Option<DynamicImage> {
        let path = self.tile_path(layer, z, y, x);
        if path.exists() {
            image::open(&path).ok()
        } else {
            None
        }
    }

    /// 拼接指定范围和缩放级别的瓦片
    pub fn compose(
        &self,
        bounds: &ChartBounds,
        zoom: u32,
        layers: &[ChartLayer],
        buoys: &[BuoyInfo],
        output_path: &str,
    ) -> Result<String, String> {
        // 计算瓦片范围
        let (x_min, y_min) = lon_lat_to_tile(bounds.west, bounds.north, zoom);
        let (x_max, y_max) = lon_lat_to_tile(bounds.east, bounds.south, zoom);

        let width = (x_max - x_min + 1) * TILE_SIZE;
        let height = (y_max - y_min + 1) * TILE_SIZE;

        info!(
            "图像合成: {}x{} 像素 (瓦片范围: X[{}-{}], Y[{}-{}])",
            width, height, x_min, x_max, y_min, y_max
        );

        // 创建画布（白色透明背景）
        let mut canvas = RgbaImage::new(width, height);

        // 逐图层叠放瓦片（从底到上）
        for layer in layers {
            let mut loaded = 0u32;
            for ty in y_min..=y_max {
                for tx in x_min..=x_max {
                    if let Some(tile_img) = self.load_tile(layer, zoom, ty, tx) {
                        let px = (tx - x_min) * TILE_SIZE;
                        let py = (ty - y_min) * TILE_SIZE;

                        let tile_rgba = tile_img.to_rgba8();
                        // Alpha 合成叠放
                        for (dx, dy, pixel) in tile_rgba.enumerate_pixels() {
                            let target_x = px + dx;
                            let target_y = py + dy;
                            if target_x < width && target_y < height {
                                let bg = canvas.get_pixel(target_x, target_y);
                                let blended = alpha_blend(bg, pixel);
                                canvas.put_pixel(target_x, target_y, blended);
                            }
                        }
                        loaded += 1;
                    }
                }
            }
            info!("图层 {} 加载了 {} 个瓦片", layer.name(), loaded);
        }

        // 绘制航标标记
        let mut buoy_count = 0;
        for buoy in buoys {
            if let (Some(lon), Some(lat)) = (buoy.lon_84, buoy.lat_84) {
                // 检查是否在范围内
                if lon < bounds.west
                    || lon > bounds.east
                    || lat < bounds.south
                    || lat > bounds.north
                {
                    continue;
                }

                // 经纬度转像素坐标
                let (pixel_x, pixel_y) = lon_lat_to_pixel(lon, lat, zoom, x_min, y_min);

                if pixel_x < width && pixel_y < height {
                    // 绘制简单的标记点（红色圆点）
                    draw_marker(&mut canvas, pixel_x as i32, pixel_y as i32, 4);
                    buoy_count += 1;
                }
            }
        }
        info!("绘制了 {} 个航标标记", buoy_count);

        // 保存输出
        let output = Path::new(output_path);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
        }

        canvas
            .save(output)
            .map_err(|e| format!("保存合成图片失败: {}", e))?;

        info!("图像合成完成: {}", output_path);
        Ok(output_path.to_string())
    }
}

/// 经纬度转像素坐标
fn lon_lat_to_pixel(lon: f64, lat: f64, zoom: u32, x_min: u32, y_min: u32) -> (u32, u32) {
    let n = 2_f64.powi(zoom as i32);

    // 计算精确的瓦片位置（包含小数部分）
    let tile_x_exact = (lon + 180.0) / 360.0 * n;
    let lat_rad = lat.to_radians();
    let tile_y_exact =
        (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;

    // 像素坐标 = (精确瓦片位置 - 起始瓦片) * 256
    let pixel_x = ((tile_x_exact - x_min as f64) * TILE_SIZE as f64) as u32;
    let pixel_y = ((tile_y_exact - y_min as f64) * TILE_SIZE as f64) as u32;

    (pixel_x, pixel_y)
}

/// Alpha 混合
fn alpha_blend(bg: &Rgba<u8>, fg: &Rgba<u8>) -> Rgba<u8> {
    let fg_a = fg[3] as f32 / 255.0;
    let bg_a = bg[3] as f32 / 255.0;

    if fg_a == 0.0 {
        return *bg;
    }
    if fg_a == 1.0 {
        return *fg;
    }

    let out_a = fg_a + bg_a * (1.0 - fg_a);
    if out_a == 0.0 {
        return Rgba([0, 0, 0, 0]);
    }

    let r = (fg[0] as f32 * fg_a + bg[0] as f32 * bg_a * (1.0 - fg_a)) / out_a;
    let g = (fg[1] as f32 * fg_a + bg[1] as f32 * bg_a * (1.0 - fg_a)) / out_a;
    let b = (fg[2] as f32 * fg_a + bg[2] as f32 * bg_a * (1.0 - fg_a)) / out_a;

    Rgba([r as u8, g as u8, b as u8, (out_a * 255.0) as u8])
}

/// 在画布上绘制简单标记（红色实心圆）
fn draw_marker(canvas: &mut RgbaImage, cx: i32, cy: i32, radius: i32) {
    let red = Rgba([255, 50, 50, 220]);
    let border = Rgba([200, 30, 30, 255]);

    let (w, h) = canvas.dimensions();

    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let dist_sq = dx * dx + dy * dy;
            let px = cx + dx;
            let py = cy + dy;
            if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                if dist_sq <= (radius - 1) * (radius - 1) {
                    let bg = canvas.get_pixel(px as u32, py as u32);
                    let blended = alpha_blend(bg, &red);
                    canvas.put_pixel(px as u32, py as u32, blended);
                } else if dist_sq <= radius * radius {
                    let bg = canvas.get_pixel(px as u32, py as u32);
                    let blended = alpha_blend(bg, &border);
                    canvas.put_pixel(px as u32, py as u32, blended);
                }
            }
        }
    }
}
