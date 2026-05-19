//! 航道图数据存储
//! 使用 SQLite 存储航标数据和采集任务

use super::types::*;
use rusqlite::{params, Connection};
use std::sync::Mutex;

/// 航道图数据库
pub struct ChartDatabase {
    conn: Mutex<Connection>,
}

impl ChartDatabase {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        db.cleanup_stale_tasks();
        Ok(db)
    }

    /// 应用启动时清理卡在"运行中"状态的任务
    fn cleanup_stale_tasks(&self) {
        if let Ok(conn) = self.conn.lock() {
            let count = conn.execute(
                "UPDATE chart_tasks SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP WHERE status = 'running'",
                [],
            ).unwrap_or(0);
            if count > 0 {
                log::info!("启动清理: {} 个航道图任务标记为 interrupted", count);
            }
        }
    }

    /// 初始化数据表
    fn init_tables(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS chart_buoys (
                id TEXT PRIMARY KEY,
                name TEXT,
                lon_84 REAL,
                lat_84 REAL,
                buoy_type TEXT,
                icon_url TEXT,
                organization_id TEXT,
                color TEXT,
                raw_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_chart_buoys_coords
                ON chart_buoys(lon_84, lat_84);

            CREATE TABLE IF NOT EXISTS chart_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'idle',
                bounds_west REAL,
                bounds_south REAL,
                bounds_east REAL,
                bounds_north REAL,
                zoom_levels TEXT,
                layers TEXT,
                grid_step REAL,
                total_items INTEGER DEFAULT 0,
                completed_items INTEGER DEFAULT 0,
                failed_items INTEGER DEFAULT 0,
                output_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME
            );

            -- 迁移: 用 raw_json 中的 hbxz (航标形状) 回填 buoy_type
            UPDATE chart_buoys
            SET buoy_type = json_extract(raw_json, '$.hbxz'),
                updated_at = CURRENT_TIMESTAMP
            WHERE buoy_type IS NULL
              AND json_extract(raw_json, '$.hbxz') IS NOT NULL
              AND json_extract(raw_json, '$.hbxz') != '';

            -- 迁移: 修复 total_items 为 0 但 completed_items 有值的任务
            UPDATE chart_tasks
            SET total_items = completed_items + failed_items
            WHERE total_items = 0 AND (completed_items > 0 OR failed_items > 0);
            ",
        )
        .map_err(|e| format!("初始化数据表失败: {}", e))?;

        Ok(())
    }

    /// 批量 upsert 航标数据
    pub fn upsert_buoys(&self, buoys: &[BuoyInfo]) -> Result<usize, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        let mut count = 0;

        // 使用事务批量插入
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO chart_buoys (id, name, lon_84, lat_84, buoy_type, icon_url, organization_id, color, raw_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        lon_84 = excluded.lon_84,
                        lat_84 = excluded.lat_84,
                        buoy_type = excluded.buoy_type,
                        icon_url = excluded.icon_url,
                        organization_id = excluded.organization_id,
                        color = excluded.color,
                        raw_json = excluded.raw_json,
                        updated_at = CURRENT_TIMESTAMP",
                )
                .map_err(|e| format!("准备插入语句失败: {}", e))?;

            for buoy in buoys {
                stmt.execute(params![
                    buoy.id,
                    buoy.name,
                    buoy.lon_84,
                    buoy.lat_84,
                    buoy.buoy_type,
                    buoy.icon_url,
                    buoy.organization_id,
                    buoy.color,
                    buoy.raw_json,
                ])
                .map_err(|e| format!("插入航标失败: {}", e))?;
                count += 1;
            }
        }

        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

        Ok(count)
    }

    /// 返回航标外接矩形（用于地图首次 fit）
    pub fn get_buoy_extent(&self) -> Result<Option<(f64, f64, f64, f64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        let row: (Option<f64>, Option<f64>, Option<f64>, Option<f64>) = conn
            .query_row(
                "SELECT MIN(lat_84), MAX(lat_84), MIN(lon_84), MAX(lon_84) FROM chart_buoys
                 WHERE lat_84 IS NOT NULL AND lon_84 IS NOT NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| format!("查询航标范围失败: {}", e))?;
        match row {
            (Some(s), Some(n), Some(w), Some(e)) => Ok(Some((s, w, n, e))),
            _ => Ok(None),
        }
    }

    /// 获取所有航标数据
    pub fn get_all_buoys(&self) -> Result<Vec<BuoyInfo>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, lon_84, lat_84, buoy_type, icon_url, organization_id, color, raw_json
                 FROM chart_buoys ORDER BY name",
            )
            .map_err(|e| format!("查询航标失败: {}", e))?;

        let buoys = stmt
            .query_map([], |row| {
                let raw_json: String = row.get(8)?;
                let id: String = row.get(0)?;
                let (waterway, shape, light_info, region) =
                    Self::parse_extra_fields(&raw_json, &id);
                Ok(BuoyInfo {
                    id,
                    name: row.get(1)?,
                    lon_84: row.get(2)?,
                    lat_84: row.get(3)?,
                    buoy_type: row.get(4)?,
                    icon_url: row.get(5)?,
                    organization_id: row.get(6)?,
                    color: row.get(7)?,
                    waterway,
                    shape,
                    light_info,
                    region,
                    raw_json,
                })
            })
            .map_err(|e| format!("映射航标数据失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(buoys)
    }

    /// 获取指定范围内的航标
    pub fn get_buoys_in_bounds(&self, bounds: &ChartBounds) -> Result<Vec<BuoyInfo>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, lon_84, lat_84, buoy_type, icon_url, organization_id, color, raw_json
                 FROM chart_buoys
                 WHERE lon_84 >= ?1 AND lon_84 <= ?2 AND lat_84 >= ?3 AND lat_84 <= ?4
                 ORDER BY name",
            )
            .map_err(|e| format!("查询航标失败: {}", e))?;

        let buoys = stmt
            .query_map(
                params![bounds.west, bounds.east, bounds.south, bounds.north],
                |row| {
                    let raw_json: String = row.get(8)?;
                    let id: String = row.get(0)?;
                    let (waterway, shape, light_info, region) =
                        Self::parse_extra_fields(&raw_json, &id);
                    Ok(BuoyInfo {
                        id,
                        name: row.get(1)?,
                        lon_84: row.get(2)?,
                        lat_84: row.get(3)?,
                        buoy_type: row.get(4)?,
                        icon_url: row.get(5)?,
                        organization_id: row.get(6)?,
                        color: row.get(7)?,
                        waterway,
                        shape,
                        light_info,
                        region,
                        raw_json,
                    })
                },
            )
            .map_err(|e| format!("映射航标数据失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(buoys)
    }

    /// 从 raw_json 中解析额外字段 + 从 ID 前缀推导地区
    fn parse_extra_fields(
        raw_json: &str,
        id: &str,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let waterway;
        let shape;
        let light_info;

        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(raw_json) {
            waterway = obj
                .get("sshd")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            shape = obj
                .get("hbxz")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            light_info = obj
                .get("dzxx")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        } else {
            waterway = None;
            shape = None;
            light_info = None;
        }

        // 从 ID 前缀推导所属地区
        let region = if let Some(prefix) = id.split('_').next() {
            match prefix {
                "WH" => Some("武汉".to_string()),
                "YC" => Some("宜昌".to_string()),
                "JZ" => Some("荆州".to_string()),
                "HXJ" => Some("湘鄂赣".to_string()),
                "XN" => Some("咸宁".to_string()),
                "HG" => Some("黄冈".to_string()),
                "EZ" => Some("鄂州".to_string()),
                "HS" => Some("黄石".to_string()),
                "JM" => Some("荆门".to_string()),
                "GJH" => Some("公安(荆江河段)".to_string()),
                "XJ" => Some("新建".to_string()),
                "CS" => Some("长沙".to_string()),
                "YY" => Some("岳阳".to_string()),
                "JJ" => Some("九江".to_string()),
                _ => Some(prefix.to_string()),
            }
        } else {
            None
        };

        (waterway, shape, light_info, region)
    }

    /// 获取航标总数
    pub fn get_buoy_count(&self) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chart_buoys", [], |row| row.get(0))
            .map_err(|e| format!("查询航标总数失败: {}", e))?;

        Ok(count as u64)
    }

    /// 清空所有航标数据
    pub fn clear_buoys(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        conn.execute("DELETE FROM chart_buoys", [])
            .map_err(|e| format!("清空航标数据失败: {}", e))?;
        Ok(())
    }

    /// 按类型分组统计航标
    pub fn get_buoy_stats(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(buoy_type, '未知'), COUNT(*) as cnt
                 FROM chart_buoys
                 GROUP BY buoy_type
                 ORDER BY cnt DESC",
            )
            .map_err(|e| format!("统计查询失败: {}", e))?;

        let stats = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| format!("映射统计数据失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(stats)
    }

    /// 创建航标采集任务
    pub fn create_chart_task(
        &self,
        task_type: &str,
        total: i64,
        bounds: Option<&super::types::ChartBounds>,
        grid_step: Option<f64>,
    ) -> Result<i64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        if let Some(b) = bounds {
            conn.execute(
                "INSERT INTO chart_tasks (task_type, status, total_items, bounds_west, bounds_south, bounds_east, bounds_north, grid_step) VALUES (?1, 'running', ?2, ?3, ?4, ?5, ?6, ?7)",
                params![task_type, total, b.west, b.south, b.east, b.north, grid_step],
            )
            .map_err(|e| format!("创建任务失败: {}", e))?;
        } else {
            conn.execute(
                "INSERT INTO chart_tasks (task_type, status, total_items) VALUES (?1, 'running', ?2)",
                params![task_type, total],
            )
            .map_err(|e| format!("创建任务失败: {}", e))?;
        }
        Ok(conn.last_insert_rowid())
    }

    /// 更新航标采集任务进度
    pub fn update_chart_task_progress(
        &self,
        task_id: i64,
        completed: i64,
        failed: i64,
        total: Option<i64>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        if let Some(t) = total {
            conn.execute(
                "UPDATE chart_tasks SET completed_items = ?1, failed_items = ?2, total_items = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4",
                params![completed, failed, t, task_id],
            ).map_err(|e| format!("更新任务进度失败: {}", e))?;
        } else {
            conn.execute(
                "UPDATE chart_tasks SET completed_items = ?1, failed_items = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
                params![completed, failed, task_id],
            ).map_err(|e| format!("更新任务进度失败: {}", e))?;
        }
        Ok(())
    }

    /// 完成航标采集任务
    pub fn complete_chart_task(
        &self,
        task_id: i64,
        status: &str,
        completed: i64,
        failed: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        conn.execute(
            "UPDATE chart_tasks SET status = ?1, completed_items = ?2, failed_items = ?3, total_items = ?2 + ?3, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![status, completed, failed, task_id],
        ).map_err(|e| format!("完成任务失败: {}", e))?;
        Ok(())
    }

    /// 获取所有航标采集任务
    pub fn get_chart_tasks(&self) -> Result<Vec<ChartTask>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT id, task_type, status, total_items, completed_items, failed_items, output_path, zoom_levels, layers, created_at, completed_at, bounds_west, bounds_south, bounds_east, bounds_north, grid_step FROM chart_tasks ORDER BY id DESC"
        ).map_err(|e| format!("准备查询失败: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(ChartTask {
                    id: row.get(0)?,
                    task_type: row.get(1)?,
                    status: row.get(2)?,
                    total_items: row.get(3)?,
                    completed_items: row.get(4)?,
                    failed_items: row.get(5)?,
                    output_path: row.get(6)?,
                    zoom_levels: row.get(7)?,
                    layers: row.get(8)?,
                    created_at: row.get(9)?,
                    completed_at: row.get(10)?,
                    bounds_west: row.get(11).ok(),
                    bounds_south: row.get(12).ok(),
                    bounds_east: row.get(13).ok(),
                    bounds_north: row.get(14).ok(),
                    grid_step: row.get(15).ok(),
                })
            })
            .map_err(|e| format!("查询失败: {}", e))?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(|e| format!("解析行失败: {}", e))?);
        }
        Ok(tasks)
    }
}

/// 航标采集任务记录
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChartTask {
    pub id: i64,
    pub task_type: String,
    pub status: String,
    pub total_items: i64,
    pub completed_items: i64,
    pub failed_items: i64,
    pub output_path: Option<String>,
    pub zoom_levels: Option<String>,
    pub layers: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
    pub bounds_west: Option<f64>,
    pub bounds_south: Option<f64>,
    pub bounds_east: Option<f64>,
    pub bounds_north: Option<f64>,
    pub grid_step: Option<f64>,
}
