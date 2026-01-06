use crate::commands::{ApiKey, Stats, POI};
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;

        // 启用 WAL 模式，避免 journal 文件频繁出现/消失
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

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

        // 检查是否有 region_code 字段，没有则添加
        let has_region_code: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('poi_data') WHERE name = 'region_code'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_region_code {
            log::info!("迁移数据库：添加 region_code 字段");
            // SQLite 允许添加可空列
            let _ = self
                .conn
                .execute("ALTER TABLE poi_data ADD COLUMN region_code TEXT", []);
            let _ = self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_poi_region ON poi_data(region_code)",
                [],
            );

            // 根据地址内容回填 region_code
            // 射阳县 320924, 阜宁县 320923
            log::info!("回填 region_code 数据...");
            let _ = self.conn.execute(
                "UPDATE poi_data SET region_code = '320924' WHERE region_code IS NULL AND address LIKE '%射阳%'",
                []
            );
            let _ = self.conn.execute(
                "UPDATE poi_data SET region_code = '320923' WHERE region_code IS NULL AND address LIKE '%阜宁%'",
                []
            );
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
                region_code TEXT,
                raw_data TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, name, lon, lat)
            );

            CREATE INDEX IF NOT EXISTS idx_poi_name ON poi_data(name);
            CREATE INDEX IF NOT EXISTS idx_poi_platform ON poi_data(platform);
            CREATE INDEX IF NOT EXISTS idx_poi_category ON poi_data(category);
            CREATE INDEX IF NOT EXISTS idx_poi_region ON poi_data(region_code);
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
        region_code: &str,
        raw_data: &str,
    ) -> Result<bool> {
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO poi_data (name, lon, lat, original_lon, original_lat, category, category_id, address, phone, platform, region_code, raw_data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![name, lon, lat, original_lon, original_lat, category, category_id, address, phone, platform, region_code, raw_data]
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
                "SELECT id, name, lon, lat, address, phone, category, platform, region_code FROM poi_data WHERE platform = ?1 ORDER BY id"
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
                    region_code: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, phone, category, platform, region_code FROM poi_data ORDER BY id"
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
                    region_code: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })?;
            for row in rows {
                results.push(row?);
            }
        }

        Ok(results)
    }

    /// 修复缺失的 region_code：根据地址内容更新
    pub fn fix_region_codes(&self) -> Result<(i64, i64)> {
        // 获取修复前的空 region_code 数量
        let null_count_before: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM poi_data WHERE region_code IS NULL OR region_code = ''",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 根据地址内容更新 region_code
        // 射阳县 320924
        self.conn.execute(
            "UPDATE poi_data SET region_code = '320924' WHERE (region_code IS NULL OR region_code = '') AND address LIKE '%射阳%'",
            []
        )?;

        // 阜宁县 320923
        self.conn.execute(
            "UPDATE poi_data SET region_code = '320923' WHERE (region_code IS NULL OR region_code = '') AND address LIKE '%阜宁%'",
            []
        )?;

        // 盐城市 320900（如果地址包含盐城但不包含具体区县）
        self.conn.execute(
            "UPDATE poi_data SET region_code = '320900' WHERE (region_code IS NULL OR region_code = '') AND address LIKE '%盐城%'",
            []
        )?;

        // 获取修复后的空 region_code 数量
        let null_count_after: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM poi_data WHERE region_code IS NULL OR region_code = ''",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let fixed = null_count_before - null_count_after;
        log::info!(
            "修复 region_code: {} 条记录已更新，剩余 {} 条为空",
            fixed,
            null_count_after
        );

        Ok((fixed, null_count_after))
    }

    /// 获取按 region_code 分组的 POI 统计
    pub fn get_poi_stats_by_region(&self) -> Result<Vec<(String, i64)>> {
        let mut results = Vec::new();
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(region_code, 'unknown'), COUNT(*) FROM poi_data GROUP BY region_code ORDER BY COUNT(*) DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// 根据 region_code 列表删除 POI 数据
    pub fn delete_poi_by_region_codes(&self, codes: &[String]) -> Result<usize> {
        if codes.is_empty() {
            return Ok(0);
        }
        let placeholders: Vec<String> = codes.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "DELETE FROM poi_data WHERE region_code IN ({})",
            placeholders.join(",")
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            codes.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let count = self.conn.execute(&sql, params.as_slice())?;
        Ok(count)
    }

    /// 清空所有 POI 数据
    pub fn clear_all_poi(&self) -> Result<usize> {
        let count = self.conn.execute("DELETE FROM poi_data", [])?;
        Ok(count)
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
    pub region_code: String,
}
