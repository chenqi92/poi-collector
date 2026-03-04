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
        Ok(db)
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
}
