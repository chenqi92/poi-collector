use rusqlite::{Connection, Result, params};
use std::collections::HashMap;
use crate::commands::{ApiKey, POI, Stats};

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.execute_batch(r#"
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
                address TEXT,
                category TEXT,
                raw_data TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, name, lon, lat)
            );

            CREATE INDEX IF NOT EXISTS idx_poi_name ON poi_data(name);
            CREATE INDEX IF NOT EXISTS idx_poi_platform ON poi_data(platform);
            CREATE INDEX IF NOT EXISTS idx_poi_category ON poi_data(category);
        "#)?;
        Ok(())
    }

    pub fn get_stats(&self) -> Result<Stats> {
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM poi_data", [], |row| row.get(0)
        ).unwrap_or(0);

        let mut by_platform = HashMap::new();
        let mut stmt = self.conn.prepare("SELECT platform, COUNT(*) FROM poi_data GROUP BY platform")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (platform, count) = row?;
            by_platform.insert(platform, count);
        }

        let mut by_category = HashMap::new();
        let mut stmt = self.conn.prepare("SELECT category, COUNT(*) FROM poi_data WHERE category IS NOT NULL GROUP BY category")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (category, count) = row?;
            by_category.insert(category, count);
        }

        Ok(Stats { total, by_platform, by_category })
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
                    api_key: mask_key(&row.get::<_, String>(2)?),
                    is_active: row.get::<_, i64>(4)? == 1,
                    quota_exhausted: row.get::<_, i64>(5)? == 1,
                }
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
            params![platform, api_key, name]
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn delete_api_key(&self, key_id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM api_keys WHERE id = ?1", params![key_id])?;
        Ok(())
    }

    pub fn search_poi(&self, query: &str, platform: Option<&str>, mode: &str, limit: i64) -> Result<Vec<POI>> {
        let pattern = match mode {
            "exact" => query.to_string(),
            "prefix" => format!("{}%", query),
            "contains" => format!("%{}%", query),
            _ => format!("%{}%", query), // smart/fuzzy
        };

        let mut results = Vec::new();

        if let Some(p) = platform {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, lon, lat, address, category, platform FROM poi_data WHERE name LIKE ?1 AND platform = ?2 LIMIT ?3"
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
                "SELECT id, name, lon, lat, address, category, platform FROM poi_data WHERE name LIKE ?1 LIMIT ?2"
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

    pub fn insert_poi(&self, platform: &str, name: &str, lon: f64, lat: f64, address: Option<&str>, category: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO poi_data (platform, name, lon, lat, address, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![platform, name, lon, lat, address, category]
        )?;
        Ok(())
    }
}

fn mask_key(key: &str) -> String {
    if key.len() > 8 {
        format!("{}****{}", &key[..4], &key[key.len()-4..])
    } else {
        key.to_string()
    }
}
