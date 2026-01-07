use super::TileStorage;
use crate::tile_downloader::types::{Bounds, TileCoord};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

pub struct MbtilesStorage {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
    bounds: Option<Bounds>,
    zoom_levels: Vec<u32>,
}

impl MbtilesStorage {
    pub fn new() -> Self {
        Self {
            db_path: PathBuf::new(),
            conn: Mutex::new(None),
            bounds: None,
            zoom_levels: Vec::new(),
        }
    }

    /// TMS 的 Y 坐标翻转
    fn flip_y(&self, z: u32, y: u32) -> u32 {
        (1u32 << z) - 1 - y
    }
}

impl TileStorage for MbtilesStorage {
    fn init(&mut self, output_path: &Path, bounds: &Bounds, zoom_levels: &[u32]) -> Result<(), String> {
        // 确保父目录存在
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }

        self.db_path = output_path.to_path_buf();
        self.bounds = Some(bounds.clone());
        self.zoom_levels = zoom_levels.to_vec();

        // 创建 MBTiles 数据库
        let conn = Connection::open(&self.db_path)
            .map_err(|e| format!("创建 MBTiles 数据库失败: {}", e))?;

        // 创建表结构
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS metadata (
                name TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS tiles (
                zoom_level INTEGER,
                tile_column INTEGER,
                tile_row INTEGER,
                tile_data BLOB,
                PRIMARY KEY (zoom_level, tile_column, tile_row)
            );

            CREATE INDEX IF NOT EXISTS idx_tiles ON tiles (zoom_level, tile_column, tile_row);
            "#,
        )
        .map_err(|e| format!("创建表结构失败: {}", e))?;

        // 插入元数据
        let min_zoom = zoom_levels.iter().min().copied().unwrap_or(0);
        let max_zoom = zoom_levels.iter().max().copied().unwrap_or(18);
        let bounds_str = format!("{},{},{},{}", bounds.west, bounds.south, bounds.east, bounds.north);
        let center_lon = (bounds.west + bounds.east) / 2.0;
        let center_lat = (bounds.south + bounds.north) / 2.0;
        let center = format!("{},{},{}", center_lon, center_lat, min_zoom);

        let metadata = [
            ("name", "Tile Download"),
            ("type", "baselayer"),
            ("version", "1.0"),
            ("description", "Downloaded tiles"),
            ("format", "png"),
        ];

        for (name, value) in metadata {
            conn.execute(
                "INSERT OR REPLACE INTO metadata (name, value) VALUES (?1, ?2)",
                params![name, value],
            )
            .map_err(|e| format!("插入元数据失败: {}", e))?;
        }

        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('bounds', ?1)",
            params![bounds_str],
        ).ok();

        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('center', ?1)",
            params![center],
        ).ok();

        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('minzoom', ?1)",
            params![min_zoom.to_string()],
        ).ok();

        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('maxzoom', ?1)",
            params![max_zoom.to_string()],
        ).ok();

        *self.conn.lock() = Some(conn);
        Ok(())
    }

    fn save_tile(&mut self, coord: &TileCoord, data: &[u8]) -> Result<(), String> {
        let conn_guard = self.conn.lock();
        let conn = conn_guard.as_ref().ok_or("数据库未初始化")?;

        // MBTiles 使用 TMS 坐标系，需要翻转 Y
        let tms_y = self.flip_y(coord.z, coord.y);

        conn.execute(
            "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?1, ?2, ?3, ?4)",
            params![coord.z, coord.x, tms_y, data],
        )
        .map_err(|e| format!("保存瓦片失败: {}", e))?;

        Ok(())
    }

    fn finalize(&mut self) -> Result<(), String> {
        if let Some(conn) = self.conn.lock().take() {
            // 优化数据库
            conn.execute("VACUUM", [])
                .map_err(|e| format!("优化数据库失败: {}", e))?;
        }
        Ok(())
    }

    fn storage_type(&self) -> &str {
        "mbtiles"
    }
}
