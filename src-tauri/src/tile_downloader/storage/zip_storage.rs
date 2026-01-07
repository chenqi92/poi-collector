use super::TileStorage;
use crate::tile_downloader::types::{Bounds, TileCoord};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::{FileOptions, ZipWriter};
use zip::CompressionMethod;

pub struct ZipStorage {
    zip_path: PathBuf,
    writer: Option<ZipWriter<File>>,
}

impl ZipStorage {
    pub fn new() -> Self {
        Self {
            zip_path: PathBuf::new(),
            writer: None,
        }
    }
}

impl TileStorage for ZipStorage {
    fn init(&mut self, output_path: &Path, _bounds: &Bounds, _zoom_levels: &[u32]) -> Result<(), String> {
        // 确保父目录存在
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }

        self.zip_path = output_path.to_path_buf();

        // 创建 ZIP 文件
        let file = File::create(&self.zip_path)
            .map_err(|e| format!("创建 ZIP 文件失败: {}", e))?;

        self.writer = Some(ZipWriter::new(file));
        Ok(())
    }

    fn save_tile(&mut self, coord: &TileCoord, data: &[u8]) -> Result<(), String> {
        let writer = self.writer.as_mut().ok_or("ZIP writer 未初始化")?;

        // 瓦片路径 z/x/y.png
        let tile_path = format!("{}/{}/{}.png", coord.z, coord.x, coord.y);

        let options = FileOptions::<()>::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6));

        writer
            .start_file(&tile_path, options)
            .map_err(|e| format!("创建 ZIP 条目失败: {}", e))?;

        writer
            .write_all(data)
            .map_err(|e| format!("写入瓦片数据失败: {}", e))?;

        Ok(())
    }

    fn finalize(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.take() {
            writer
                .finish()
                .map_err(|e| format!("完成 ZIP 文件失败: {}", e))?;
        }
        Ok(())
    }

    fn storage_type(&self) -> &str {
        "zip"
    }
}
