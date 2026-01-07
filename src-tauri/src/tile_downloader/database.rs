use parking_lot::Mutex;
use rusqlite::{params, Connection, Result};
use std::path::Path;

use super::types::{Bounds, TaskInfo, TileCoord};

pub struct TileDatabase {
    conn: Mutex<Connection>,
}

impl TileDatabase {
    pub fn new(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let db = Self { conn: Mutex::new(conn) };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.lock().execute_batch(
            r#"
            -- 下载任务表
            CREATE TABLE IF NOT EXISTS tile_download_tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                platform TEXT NOT NULL,
                map_type TEXT NOT NULL,
                bounds_north REAL NOT NULL,
                bounds_south REAL NOT NULL,
                bounds_east REAL NOT NULL,
                bounds_west REAL NOT NULL,
                zoom_levels TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                total_tiles INTEGER NOT NULL DEFAULT 0,
                completed_tiles INTEGER NOT NULL DEFAULT 0,
                failed_tiles INTEGER NOT NULL DEFAULT 0,
                output_path TEXT NOT NULL,
                output_format TEXT NOT NULL,
                thread_count INTEGER NOT NULL DEFAULT 8,
                retry_count INTEGER NOT NULL DEFAULT 3,
                api_key TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT,
                error_message TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_tile_task_status ON tile_download_tasks(status);

            -- 瓦片进度表
            CREATE TABLE IF NOT EXISTS tile_progress (
                task_id TEXT NOT NULL,
                z INTEGER NOT NULL,
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                downloaded_at TEXT,
                PRIMARY KEY (task_id, z, x, y)
            );

            CREATE INDEX IF NOT EXISTS idx_tile_progress_task ON tile_progress(task_id);
            CREATE INDEX IF NOT EXISTS idx_tile_progress_status ON tile_progress(task_id, status);
            "#,
        )?;
        Ok(())
    }

    /// 创建新任务
    pub fn create_task(
        &self,
        id: &str,
        name: &str,
        platform: &str,
        map_type: &str,
        bounds: &Bounds,
        zoom_levels: &[u32],
        total_tiles: u64,
        output_path: &str,
        output_format: &str,
        thread_count: u32,
        retry_count: u32,
        api_key: Option<&str>,
    ) -> Result<()> {
        let zoom_str = zoom_levels
            .iter()
            .map(|z| z.to_string())
            .collect::<Vec<_>>()
            .join(",");

        self.conn.lock().execute(
            r#"INSERT INTO tile_download_tasks
               (id, name, platform, map_type, bounds_north, bounds_south, bounds_east, bounds_west,
                zoom_levels, total_tiles, output_path, output_format, thread_count, retry_count, api_key)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
            params![
                id,
                name,
                platform,
                map_type,
                bounds.north,
                bounds.south,
                bounds.east,
                bounds.west,
                zoom_str,
                total_tiles as i64,
                output_path,
                output_format,
                thread_count,
                retry_count,
                api_key,
            ],
        )?;
        Ok(())
    }

    /// 获取所有任务
    pub fn get_all_tasks(&self) -> Result<Vec<TaskInfo>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT id, name, platform, map_type, bounds_north, bounds_south, bounds_east, bounds_west,
                      zoom_levels, status, total_tiles, completed_tiles, failed_tiles, output_path,
                      output_format, thread_count, retry_count, api_key, created_at, updated_at, completed_at, error_message
               FROM tile_download_tasks ORDER BY created_at DESC"#,
        )?;

        let rows = stmt.query_map([], |row| {
            let zoom_str: String = row.get(8)?;
            let zoom_levels: Vec<u32> = zoom_str
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();

            Ok(TaskInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                platform: row.get(2)?,
                map_type: row.get(3)?,
                bounds: Bounds {
                    north: row.get(4)?,
                    south: row.get(5)?,
                    east: row.get(6)?,
                    west: row.get(7)?,
                },
                zoom_levels,
                status: row.get(9)?,
                total_tiles: row.get::<_, i64>(10)? as u64,
                completed_tiles: row.get::<_, i64>(11)? as u64,
                failed_tiles: row.get::<_, i64>(12)? as u64,
                output_path: row.get(13)?,
                output_format: row.get(14)?,
                thread_count: row.get(15)?,
                retry_count: row.get(16)?,
                api_key: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
                completed_at: row.get(20)?,
                error_message: row.get(21)?,
                download_speed: 0.0,
            })
        })?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row?);
        }
        Ok(tasks)
    }

    /// 获取单个任务
    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"SELECT id, name, platform, map_type, bounds_north, bounds_south, bounds_east, bounds_west,
                      zoom_levels, status, total_tiles, completed_tiles, failed_tiles, output_path,
                      output_format, thread_count, retry_count, api_key, created_at, updated_at, completed_at, error_message
               FROM tile_download_tasks WHERE id = ?1"#,
        )?;

        let result = stmt.query_row(params![task_id], |row| {
            let zoom_str: String = row.get(8)?;
            let zoom_levels: Vec<u32> = zoom_str
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();

            Ok(TaskInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                platform: row.get(2)?,
                map_type: row.get(3)?,
                bounds: Bounds {
                    north: row.get(4)?,
                    south: row.get(5)?,
                    east: row.get(6)?,
                    west: row.get(7)?,
                },
                zoom_levels,
                status: row.get(9)?,
                total_tiles: row.get::<_, i64>(10)? as u64,
                completed_tiles: row.get::<_, i64>(11)? as u64,
                failed_tiles: row.get::<_, i64>(12)? as u64,
                output_path: row.get(13)?,
                output_format: row.get(14)?,
                thread_count: row.get(15)?,
                retry_count: row.get(16)?,
                api_key: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
                completed_at: row.get(20)?,
                error_message: row.get(21)?,
                download_speed: 0.0,
            })
        });

        match result {
            Ok(task) => Ok(Some(task)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 更新任务状态
    pub fn update_task_status(&self, task_id: &str, status: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "UPDATE tile_download_tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, task_id],
        )?;
        Ok(())
    }

    /// 更新任务进度
    pub fn update_task_progress(
        &self,
        task_id: &str,
        completed: u64,
        failed: u64,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "UPDATE tile_download_tasks SET completed_tiles = ?1, failed_tiles = ?2, updated_at = ?3 WHERE id = ?4",
            params![completed as i64, failed as i64, now, task_id],
        )?;
        Ok(())
    }

    /// 设置任务完成
    pub fn set_task_completed(&self, task_id: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "UPDATE tile_download_tasks SET status = 'completed', updated_at = ?1, completed_at = ?1 WHERE id = ?2",
            params![now, task_id],
        )?;
        Ok(())
    }

    /// 设置任务失败
    pub fn set_task_failed(&self, task_id: &str, error: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "UPDATE tile_download_tasks SET status = 'failed', error_message = ?1, updated_at = ?2 WHERE id = ?3",
            params![error, now, task_id],
        )?;
        Ok(())
    }

    /// 更新线程数
    pub fn update_thread_count(&self, task_id: &str, count: u32) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE tile_download_tasks SET thread_count = ?1 WHERE id = ?2",
            params![count, task_id],
        )?;
        Ok(())
    }

    /// 删除任务
    pub fn delete_task(&self, task_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM tile_progress WHERE task_id = ?1",
            params![task_id],
        )?;
        conn.execute(
            "DELETE FROM tile_download_tasks WHERE id = ?1",
            params![task_id],
        )?;
        Ok(())
    }

    /// 初始化任务的瓦片列表
    pub fn init_tile_progress(&self, task_id: &str, tiles: &[TileCoord]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // 先删除旧的进度记录
        tx.execute("DELETE FROM tile_progress WHERE task_id = ?1", params![task_id])?;

        // 批量插入
        let mut stmt = tx.prepare(
            "INSERT INTO tile_progress (task_id, z, x, y, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
        )?;

        for tile in tiles {
            stmt.execute(params![task_id, tile.z, tile.x, tile.y])?;
        }

        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    /// 获取待下载的瓦片
    pub fn get_pending_tiles(&self, task_id: &str, limit: usize) -> Result<Vec<TileCoord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT z, x, y FROM tile_progress WHERE task_id = ?1 AND status = 'pending' LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![task_id, limit as i64], |row| {
            Ok(TileCoord {
                z: row.get(0)?,
                x: row.get(1)?,
                y: row.get(2)?,
            })
        })?;

        let mut tiles = Vec::new();
        for row in rows {
            tiles.push(row?);
        }
        Ok(tiles)
    }

    /// 获取失败的瓦片
    pub fn get_failed_tiles(&self, task_id: &str) -> Result<Vec<TileCoord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT z, x, y FROM tile_progress WHERE task_id = ?1 AND status = 'failed'",
        )?;

        let rows = stmt.query_map(params![task_id], |row| {
            Ok(TileCoord {
                z: row.get(0)?,
                x: row.get(1)?,
                y: row.get(2)?,
            })
        })?;

        let mut tiles = Vec::new();
        for row in rows {
            tiles.push(row?);
        }
        Ok(tiles)
    }

    /// 标记瓦片完成
    pub fn mark_tile_completed(&self, task_id: &str, tile: &TileCoord) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "UPDATE tile_progress SET status = 'completed', downloaded_at = ?1 WHERE task_id = ?2 AND z = ?3 AND x = ?4 AND y = ?5",
            params![now, task_id, tile.z, tile.x, tile.y],
        )?;
        Ok(())
    }

    /// 标记瓦片失败
    pub fn mark_tile_failed(&self, task_id: &str, tile: &TileCoord, error: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE tile_progress SET status = 'failed', error_message = ?1, retry_count = retry_count + 1 WHERE task_id = ?2 AND z = ?3 AND x = ?4 AND y = ?5",
            params![error, task_id, tile.z, tile.x, tile.y],
        )?;
        Ok(())
    }

    /// 重置失败瓦片为待下载
    pub fn reset_failed_tiles(&self, task_id: &str) -> Result<u64> {
        let count = self.conn.lock().execute(
            "UPDATE tile_progress SET status = 'pending', error_message = NULL WHERE task_id = ?1 AND status = 'failed'",
            params![task_id],
        )?;
        Ok(count as u64)
    }

    /// 获取任务统计
    pub fn get_tile_stats(&self, task_id: &str) -> Result<(u64, u64, u64)> {
        let conn = self.conn.lock();
        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tile_progress WHERE task_id = ?1 AND status = 'pending'",
            params![task_id],
            |row| row.get(0),
        )?;

        let completed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tile_progress WHERE task_id = ?1 AND status = 'completed'",
            params![task_id],
            |row| row.get(0),
        )?;

        let failed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tile_progress WHERE task_id = ?1 AND status = 'failed'",
            params![task_id],
            |row| row.get(0),
        )?;

        Ok((pending as u64, completed as u64, failed as u64))
    }
}
