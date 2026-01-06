use crate::commands::{ApiKey, Stats, POI};
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.migrate()?;
        db.init_tables()?;
        Ok(db)
    }

    /// 数据库迁移：检查表结构版本并升级
    fn migrate(&self) -> Result<()> {
        // 检查是否有旧版本的 poi_data 表（没有新字段）
        let has_category_id: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('poi_data') WHERE name = 'category_id'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        // 如果表存在但没有 category_id 字段，重建表
        if !has_category_id {
            log::info!("迁移数据库：重建 poi_data 表");
            let _ = self.conn.execute("DROP TABLE IF EXISTS poi_data", []);
        }

        Ok(())
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                api_key TEXT NOT NULL,
                name TEXT,
                is_active INTEGER DEFAULT 1,
                quota_exhausted INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS poi_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                name TEXT NOT NULL,
                lon REAL NOT NULL,
                lat REAL NOT NULL,
                original_lon REAL,
                original_lat REAL,
                address TEXT,
                phone TEXT,
                category TEXT,
                category_id TEXT,
                raw_data TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, name, lon, lat)
            );

            CREATE INDEX IF NOT EXISTS idx_poi_name ON poi_data(name);
            CREATE INDEX IF NOT EXISTS idx_poi_platform ON poi_data(platform);
            CREATE INDEX IF NOT EXISTS idx_poi_category ON poi_data(category);
        "#,
        )?;
        Ok(())
    }

    pub fn get_stats(&self) -> Result<Stats> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM poi_data", [], |row| row.get(0))
            .unwrap_or(0);

        let mut by_platform = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT platform, COUNT(*) FROM poi_data GROUP BY platform")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (platform, count) = row?;
            by_platform.insert(platform, count);
        }

        let mut by_category = HashMap::new();
        let mut stmt = self.conn.prepare(
            "SELECT category, COUNT(*) FROM poi_data WHERE category IS NOT NULL GROUP BY category",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (category, count) = row?;
            by_category.insert(category, count);
        }

        Ok(Stats {
            total,
            by_platform,
            by_category,
        })
    }

    pub fn get_all_api_keys(&self) -> Result<HashMap<String, Vec<ApiKey>>> {
        let mut result: HashMap<String, Vec<ApiKey>> = HashMap::new();

        let mut stmt = self.conn.prepare(
            "SELECT id, platform, api_key, name, is_active, quota_exhausted FROM api_keys ORDER BY platform, id"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?, // platform
                ApiKey {
                    id: row.get(0)?,
                    name: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    api_key: row.get::<_, String>(2)?, // 返回完整的 key 给后端使用
                    is_active: row.get::<_, i64>(4)? == 1,
                    quota_exhausted: row.get::<_, i64>(5)? == 1,
                },
            ))
        })?;

        for row in rows {
            let (platform, key) = row?;
            result.entry(platform).or_default().push(key);
        }

        Ok(result)
    }

    pub fn add_api_key(&self, platform: &str, api_key: &str, name: Option<&str>) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO api_keys (platform, api_key, name) VALUES (?1, ?2, ?3)",
            params![platform, api_key, name],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn delete_api_key(&self, key_id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM api_keys WHERE id = ?1", params![key_id])?;
        Ok(())
    }

    pub fn search_poi(
        &self,
        query: &str,
        platform: Option<&str>,
        mode: &str,
        limit: i64,
    ) -> Result<Vec<POI>> {
        let pattern = match mode {
            "exact" => query.to_string(),
            "prefix" => format!("{}%", query),
            "contains" => format!("%{}%", query),
            _ => format!("%{}%", query), // smart/fuzzy
        };

        let mut results = Vec::new();

        if let Some(p) = platform {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, category, platform FROM poi_data WHERE (name LIKE ?1 OR address LIKE ?1) AND platform = ?2 LIMIT ?3"
            )?;
            let rows = stmt.query_map(params![pattern, p, limit], |row| {
                Ok(POI {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    lon: row.get(2)?,
                    lat: row.get(3)?,
                    address: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    category: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    platform: row.get(6)?,
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, category, platform FROM poi_data WHERE (name LIKE ?1 OR address LIKE ?1) LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![pattern, limit], |row| {
                Ok(POI {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    lon: row.get(2)?,
                    lat: row.get(3)?,
                    address: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    category: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    platform: row.get(6)?,
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        }

        Ok(results)
    }

    pub fn insert_poi(
        &self,
        name: &str,
        lon: f64,
        lat: f64,
        original_lon: f64,
        original_lat: f64,
        category: &str,
        category_id: &str,
        address: &str,
        phone: &str,
        platform: &str,
        raw_data: &str,
    ) -> Result<bool> {
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO poi_data (name, lon, lat, original_lon, original_lat, category, category_id, address, phone, platform, raw_data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![name, lon, lat, original_lon, original_lat, category, category_id, address, phone, platform, raw_data]
        )?;
        Ok(rows > 0) // 返回是否实际插入了行
    }

    pub fn mark_key_exhausted(&self, key_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE api_keys SET quota_exhausted = 1 WHERE id = ?1",
            params![key_id],
        )?;
        Ok(())
    }

    /// 获取所有 POI 数据，支持平台过滤
    pub fn get_all_poi(&self, platform: Option<&str>) -> Result<Vec<ExportPOI>> {
        let mut results = Vec::new();

        if let Some(p) = platform {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, phone, category, platform FROM poi_data WHERE platform = ?1 ORDER BY id"
            )?;
            let rows = stmt.query_map(params![p], |row| {
                Ok(ExportPOI {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    lon: row.get(2)?,
                    lat: row.get(3)?,
                    address: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    phone: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    category: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    platform: row.get(7)?,
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, phone, category, platform FROM poi_data ORDER BY id"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ExportPOI {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    lon: row.get(2)?,
                    lat: row.get(3)?,
                    address: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    phone: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    category: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    platform: row.get(7)?,
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        }

        Ok(results)
    }
}

/// 导出用的 POI 结构体（包含更多字段）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExportPOI {
    pub id: i64,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub address: String,
    pub phone: String,
    pub category: String,
    pub platform: String,
}
