mod folder;
mod mbtiles;
mod zip_storage;

pub use folder::FolderStorage;
pub use mbtiles::MbtilesStorage;
pub use zip_storage::ZipStorage;

use super::types::{Bounds, TileCoord};
use std::path::Path;

/// 瓦片存储 trait
pub trait TileStorage: Send + Sync {
    /// 初始化存储
    fn init(&mut self, output_path: &Path, bounds: &Bounds, zoom_levels: &[u32]) -> Result<(), String>;

    /// 保存瓦片
    fn save_tile(&mut self, coord: &TileCoord, data: &[u8]) -> Result<(), String>;

    /// 完成存储（清理、压缩等）
    fn finalize(&mut self) -> Result<(), String>;

    /// 获取存储类型
    fn storage_type(&self) -> &str;
}

/// 创建存储实例
pub fn create_storage(format: &str) -> Box<dyn TileStorage> {
    match format.to_lowercase().as_str() {
        "mbtiles" => Box::new(MbtilesStorage::new()),
        "zip" => Box::new(ZipStorage::new()),
        _ => Box::new(FolderStorage::new()),
    }
}
