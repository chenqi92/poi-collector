use super::TileStorage;
use crate::tile_downloader::types::{Bounds, TileCoord};
use std::fs;
use std::path::{Path, PathBuf};

pub struct FolderStorage {
    base_path: PathBuf,
}

impl FolderStorage {
    pub fn new() -> Self {
        Self {
            base_path: PathBuf::new(),
        }
    }
}

impl TileStorage for FolderStorage {
    fn init(&mut self, output_path: &Path, _bounds: &Bounds, _zoom_levels: &[u32]) -> Result<(), String> {
        self.base_path = output_path.to_path_buf();

        // 创建基础目录
        fs::create_dir_all(&self.base_path)
            .map_err(|e| format!("创建目录失败: {}", e))?;

        Ok(())
    }

    fn save_tile(&mut self, coord: &TileCoord, data: &[u8]) -> Result<(), String> {
        // 创建层级目录 z/x/
        let tile_dir = self.base_path.join(coord.z.to_string()).join(coord.x.to_string());
        fs::create_dir_all(&tile_dir)
            .map_err(|e| format!("创建瓦片目录失败: {}", e))?;

        // 保存瓦片文件 y.png
        let tile_path = tile_dir.join(format!("{}.png", coord.y));
        fs::write(&tile_path, data)
            .map_err(|e| format!("保存瓦片失败: {}", e))?;

        Ok(())
    }

    fn finalize(&mut self) -> Result<(), String> {
        // 文件夹存储不需要额外处理
        Ok(())
    }

    fn storage_type(&self) -> &str {
        "folder"
    }
}
