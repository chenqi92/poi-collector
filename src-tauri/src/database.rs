use crate::commands::{ApiKey, Stats, POI};
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::tune_pragmas(&conn)?;

        let db = Self { conn };
        db.migrate()?;
        db.init_tables()?;
        db.ensure_fts()?;
        db.ensure_rtree()?;
        db.cleanup_stale_tasks();
        Ok(db)
    }

    /// 暴露底层连接给独立读连接池使用。
    pub fn raw_conn(&self) -> &Connection {
        &self.conn
    }

    /// 一次性把连接配置成读密集 + 写不丢的折中策略。
    ///   - WAL 让读写并发不互相阻塞
    ///   - synchronous=NORMAL：write 时不每次 fsync，掉电最多丢最近事务（对 POI 缓存数据可接受）
    ///   - temp_store=MEMORY：ORDER BY / GROUP BY 的临时表走内存
    ///   - mmap_size=256MB：让 SQLite 通过内存映射读 DB 文件，减少 syscall
    ///   - cache_size=-65536：64 MB 页缓存
    ///   - busy_timeout：避免 SQLITE_BUSY 直接报错，等 5s 再说
    fn tune_pragmas(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=MEMORY;
             PRAGMA mmap_size=268435456;
             PRAGMA cache_size=-65536;
             PRAGMA wal_autocheckpoint=1000;
             PRAGMA journal_size_limit=67108864;
             PRAGMA busy_timeout=5000;",
        )?;
        Ok(())
    }

    /// 应用启动时清理卡在"运行中"状态的任务
    /// 进程退出时未正常完成的任务会永远卡在 running/downloading 状态
    fn cleanup_stale_tasks(&self) {
        // POI 采集任务
        let count1 = self.conn.execute(
            "UPDATE poi_collection_tasks SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP WHERE status = 'running'",
            [],
        ).unwrap_or(0);
        if count1 > 0 {
            log::info!("启动清理: {} 个 POI 采集任务标记为 interrupted", count1);
        }

        // 航道图采集任务（chart_tasks 在另一个数据库，这里尝试更新，表不存在则忽略）
        let count2 = self.conn.execute(
            "UPDATE chart_tasks SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP WHERE status = 'running'",
            [],
        ).unwrap_or(0);
        if count2 > 0 {
            log::info!("启动清理: {} 个航道图任务标记为 interrupted", count2);
        }
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

    /// 建立 / 校准 FTS5 三字组索引。Trigram tokenizer 让 LIKE %xxx% 风格的子串匹配
    /// 走索引而非全表扫，对中文同样有效（每 3 个 Unicode 字符为一个 token）。
    fn ensure_fts(&self) -> Result<()> {
        // 已经存在则不重建，避免每次启动都重新 INDEX 23k+ 条。
        let exists: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'poi_fts'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            log::info!("建立 poi_fts (FTS5 trigram) 索引");
            self.conn.execute_batch(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS poi_fts USING fts5(
                    name, address, category,
                    content='poi_data',
                    content_rowid='id',
                    tokenize='trigram'
                );

                CREATE TRIGGER IF NOT EXISTS poi_fts_ai AFTER INSERT ON poi_data BEGIN
                    INSERT INTO poi_fts(rowid, name, address, category)
                    VALUES (new.id, new.name, COALESCE(new.address,''), COALESCE(new.category,''));
                END;
                CREATE TRIGGER IF NOT EXISTS poi_fts_ad AFTER DELETE ON poi_data BEGIN
                    INSERT INTO poi_fts(poi_fts, rowid, name, address, category)
                    VALUES ('delete', old.id, old.name, COALESCE(old.address,''), COALESCE(old.category,''));
                END;
                CREATE TRIGGER IF NOT EXISTS poi_fts_au AFTER UPDATE ON poi_data BEGIN
                    INSERT INTO poi_fts(poi_fts, rowid, name, address, category)
                    VALUES ('delete', old.id, old.name, COALESCE(old.address,''), COALESCE(old.category,''));
                    INSERT INTO poi_fts(rowid, name, address, category)
                    VALUES (new.id, new.name, COALESCE(new.address,''), COALESCE(new.category,''));
                END;
                "#,
            )?;

            // 回填存量
            let backfilled = self.conn.execute(
                "INSERT INTO poi_fts(rowid, name, address, category)
                 SELECT id, name, COALESCE(address,''), COALESCE(category,'') FROM poi_data",
                [],
            )?;
            log::info!("FTS5 回填 {} 行", backfilled);
        }
        Ok(())
    }

    /// R-Tree 空间索引：bounds 查询从 O(n) 索引扫描变 O(log n)。
    /// 即便 10w+ POI 在视野查询时也能 <5ms。
    fn ensure_rtree(&self) -> Result<()> {
        let exists: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'poi_rtree'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            log::info!("建立 poi_rtree 空间索引");
            self.conn.execute_batch(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS poi_rtree USING rtree(
                    id,
                    min_lat, max_lat,
                    min_lon, max_lon
                );

                CREATE TRIGGER IF NOT EXISTS poi_rtree_ai AFTER INSERT ON poi_data BEGIN
                    INSERT INTO poi_rtree(id, min_lat, max_lat, min_lon, max_lon)
                    VALUES (new.id, new.lat, new.lat, new.lon, new.lon);
                END;
                CREATE TRIGGER IF NOT EXISTS poi_rtree_ad AFTER DELETE ON poi_data BEGIN
                    DELETE FROM poi_rtree WHERE id = old.id;
                END;
                CREATE TRIGGER IF NOT EXISTS poi_rtree_au AFTER UPDATE OF lat, lon ON poi_data BEGIN
                    UPDATE poi_rtree SET min_lat=new.lat, max_lat=new.lat, min_lon=new.lon, max_lon=new.lon
                    WHERE id = old.id;
                END;
                "#,
            )?;

            let backfilled = self.conn.execute(
                "INSERT INTO poi_rtree(id, min_lat, max_lat, min_lon, max_lon)
                 SELECT id, lat, lat, lon, lon FROM poi_data",
                [],
            )?;
            log::info!("R-Tree 回填 {} 行", backfilled);
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
            CREATE INDEX IF NOT EXISTS idx_poi_coords ON poi_data(lat, lon);

            CREATE TABLE IF NOT EXISTS poi_collection_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                region_name TEXT,
                region_code TEXT,
                categories TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                total_categories INTEGER DEFAULT 0,
                completed_categories INTEGER DEFAULT 0,
                total_collected INTEGER DEFAULT 0,
                error_message TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );
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
                "SELECT id, name, lon, lat, address, phone, category, platform, region_code FROM poi_data WHERE (name LIKE ?1 OR address LIKE ?1) AND platform = ?2 LIMIT ?3"
            )?;
            let rows = stmt.query_map(params![pattern, p, limit], |row| {
                Ok(POI {
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
                "SELECT id, name, lon, lat, address, phone, category, platform, region_code FROM poi_data WHERE (name LIKE ?1 OR address LIKE ?1) LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![pattern, limit], |row| {
                Ok(POI {
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

    /// 构造 search_pois / export_pois 共用的 FROM + WHERE + 参数列表。
    /// bounds 走 poi_rtree（O(log n)），text 走 poi_fts（trigram）。
    pub fn build_poi_filter(
        query: Option<&str>,
        platforms: &[String],
        bounds: Option<(f64, f64, f64, f64)>,
        region_codes: &[String],
    ) -> (String, String, Vec<Box<dyn rusqlite::ToSql>>) {
        let q_trim = query.unwrap_or("").trim();
        let use_fts = !q_trim.is_empty();
        let use_rtree = bounds.is_some();

        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut where_clauses: Vec<String> = Vec::new();

        let mut from = String::from("FROM poi_data p");
        if use_fts {
            from.push_str(" JOIN poi_fts f ON f.rowid = p.id");
        }
        if use_rtree {
            from.push_str(" JOIN poi_rtree r ON r.id = p.id");
        }

        if use_fts {
            let escaped = q_trim.replace('"', "\"\"");
            where_clauses.push("poi_fts MATCH ?".to_string());
            params.push(Box::new(format!("\"{}\"", escaped)));
        }

        if let Some((s, w, n, e)) = bounds {
            // R-Tree 的约束写法：MBR 必须完全包含。这里我们要点 in box，所以
            // min_lat >= south AND max_lat <= north（点的 min/max 相同所以这样就够）
            where_clauses.push("r.min_lat >= ? AND r.max_lat <= ?".to_string());
            where_clauses.push("r.min_lon >= ? AND r.max_lon <= ?".to_string());
            params.push(Box::new(s));
            params.push(Box::new(n));
            params.push(Box::new(w));
            params.push(Box::new(e));
        }

        if !platforms.is_empty() {
            let ph = vec!["?"; platforms.len()].join(",");
            where_clauses.push(format!("p.platform IN ({})", ph));
            for p in platforms {
                params.push(Box::new(p.clone()));
            }
        }

        if !region_codes.is_empty() {
            // 区划码是 6 位 GB/T 2260：省 xx0000、市 xxyy00、县 xxyykk。
            // 选省 "320000" 时希望覆盖所有 32xxxx；选市 "320900" 覆盖所有 3209xx。
            // 把每个 code 转成 LIKE 前缀，多个用 OR。
            let mut parts: Vec<String> = Vec::with_capacity(region_codes.len());
            for c in region_codes {
                let prefix = if c.ends_with("0000") && c.len() == 6 {
                    format!("{}%", &c[..2])
                } else if c.ends_with("00") && c.len() == 6 {
                    format!("{}%", &c[..4])
                } else {
                    c.clone()
                };
                parts.push("p.region_code LIKE ?".to_string());
                params.push(Box::new(prefix));
            }
            where_clauses.push(format!("({})", parts.join(" OR ")));
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_clauses.join(" AND "))
        };

        (from, where_sql, params)
    }

    /// 综合过滤 + 分页查询。支持任意组合的：
    ///   - 全文 query（走 FTS5 trigram 索引）
    ///   - platforms IN (...)
    ///   - bounds（lat/lon BETWEEN）
    ///   - region_codes IN (...)
    #[allow(dead_code)]
    pub fn search_pois_filtered(
        &self,
        query: Option<&str>,
        platforms: &[String],
        bounds: Option<(f64, f64, f64, f64)>,
        region_codes: &[String],
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<POI>, i64)> {
        Self::search_pois_filtered_conn(&self.conn, query, platforms, bounds, region_codes, limit, offset)
    }

    /// 同上但接受任意 &Connection，用于读连接池。
    pub fn search_pois_filtered_conn(
        conn: &Connection,
        query: Option<&str>,
        platforms: &[String],
        bounds: Option<(f64, f64, f64, f64)>,
        region_codes: &[String],
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<POI>, i64)> {
        let (from_clause, where_sql, mut params) =
            Self::build_poi_filter(query, platforms, bounds, region_codes);

        let count_sql = format!("SELECT COUNT(*) {}{}", from_clause, where_sql);
        let total: i64 = {
            let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
            conn.query_row(&count_sql, rusqlite::params_from_iter(refs), |r| r.get(0))?
        };

        let page_sql = format!(
            "SELECT p.id, p.name, p.lon, p.lat, p.address, p.phone, p.category, p.platform, p.region_code \
             {}{}  ORDER BY p.id LIMIT ? OFFSET ?",
            from_clause, where_sql
        );
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let mut stmt = conn.prepare(&page_sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(refs), |row| {
            Ok(POI {
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
        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok((items, total))
    }

    pub fn search_export_pois_filtered(
        &self,
        query: Option<&str>,
        platforms: &[String],
        bounds: Option<(f64, f64, f64, f64)>,
        region_codes: &[String],
    ) -> Result<Vec<ExportPOI>> {
        Self::search_export_pois_filtered_conn(&self.conn, query, platforms, bounds, region_codes)
    }

    pub fn search_export_pois_filtered_conn(
        conn: &Connection,
        query: Option<&str>,
        platforms: &[String],
        bounds: Option<(f64, f64, f64, f64)>,
        region_codes: &[String],
    ) -> Result<Vec<ExportPOI>> {
        let (from_clause, where_sql, params) =
            Self::build_poi_filter(query, platforms, bounds, region_codes);

        let sql = format!(
            "SELECT p.id, p.name, p.lon, p.lat, p.address, p.phone, p.category, p.platform, p.region_code \
             {}{}  ORDER BY p.id",
            from_clause, where_sql
        );

        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(refs), |row| {
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
        let mut items = Vec::new();
        for r in rows {
            items.push(r?);
        }
        Ok(items)
    }

    #[allow(dead_code)]
    pub fn get_poi_extent(
        &self,
        platforms: &[String],
    ) -> Result<Option<(f64, f64, f64, f64)>> {
        Self::get_poi_extent_conn(&self.conn, platforms)
    }

    pub fn get_poi_extent_conn(
        conn: &Connection,
        platforms: &[String],
    ) -> Result<Option<(f64, f64, f64, f64)>> {
        let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if platforms.is_empty() {
            (
                "SELECT MIN(lat), MAX(lat), MIN(lon), MAX(lon) FROM poi_data".to_string(),
                Vec::new(),
            )
        } else {
            let ph = vec!["?"; platforms.len()].join(",");
            (
                format!(
                    "SELECT MIN(lat), MAX(lat), MIN(lon), MAX(lon) FROM poi_data WHERE platform IN ({})",
                    ph
                ),
                platforms.iter().map(|p| Box::new(p.clone()) as Box<dyn rusqlite::ToSql>).collect(),
            )
        };
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let row: (Option<f64>, Option<f64>, Option<f64>, Option<f64>) =
            conn.query_row(&sql, rusqlite::params_from_iter(refs), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
        match row {
            (Some(s), Some(n), Some(w), Some(e)) => Ok(Some((s, w, n, e))),
            _ => Ok(None),
        }
    }

    /// 按视窗范围查询 POI（支持可选关键词和平台过滤）
    pub fn get_poi_in_bounds(
        &self,
        south: f64,
        west: f64,
        north: f64,
        east: f64,
        query: Option<&str>,
        platform: Option<&str>,
        limit: i64,
    ) -> Result<Vec<POI>> {
        let mut sql = String::from(
            "SELECT id, name, lon, lat, address, phone, category, platform, region_code FROM poi_data WHERE lat >= ?1 AND lat <= ?2 AND lon >= ?3 AND lon <= ?4"
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(south),
            Box::new(north),
            Box::new(west),
            Box::new(east),
        ];

        if let Some(q) = query {
            if !q.is_empty() {
                let pattern = format!("%{}%", q);
                sql.push_str(" AND (name LIKE ?5 OR address LIKE ?5)");
                params_vec.push(Box::new(pattern));
            }
        }

        if let Some(p) = platform {
            let idx = params_vec.len() + 1;
            sql.push_str(&format!(" AND platform = ?{}", idx));
            params_vec.push(Box::new(p.to_string()));
        }

        sql.push_str(&format!(" LIMIT ?{}", params_vec.len() + 1));
        params_vec.push(Box::new(limit));

        let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(POI {
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

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
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

    #[allow(dead_code)]
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

    // === POI 采集任务记录 ===

    /// 创建 POI 采集任务
    pub fn create_poi_task(
        &self,
        platform: &str,
        region_name: Option<&str>,
        region_code: Option<&str>,
        categories: &str,
        total_categories: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO poi_collection_tasks (platform, region_name, region_code, categories, total_categories) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![platform, region_name, region_code, categories, total_categories],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// 更新 POI 采集任务进度
    pub fn update_poi_task_progress(
        &self,
        task_id: i64,
        completed_categories: i64,
        total_collected: i64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE poi_collection_tasks SET completed_categories = ?1, total_collected = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
            params![completed_categories, total_collected, task_id],
        )?;
        Ok(())
    }

    /// 完成 POI 采集任务
    pub fn complete_poi_task(
        &self,
        task_id: i64,
        status: &str,
        total_collected: i64,
        error_message: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE poi_collection_tasks SET status = ?1, total_collected = ?2, error_message = ?3, completed_at = CURRENT_TIMESTAMP WHERE id = ?4",
            params![status, total_collected, error_message, task_id],
        )?;
        Ok(())
    }

    /// 获取 POI 采集任务列表
    pub fn get_poi_tasks(&self) -> Result<Vec<PoiTask>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, platform, region_name, region_code, categories, status, total_categories, completed_categories, total_collected, error_message, created_at, completed_at FROM poi_collection_tasks ORDER BY id DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PoiTask {
                id: row.get(0)?,
                platform: row.get(1)?,
                region_name: row.get(2)?,
                region_code: row.get(3)?,
                categories: row.get(4)?,
                status: row.get(5)?,
                total_categories: row.get(6)?,
                completed_categories: row.get(7)?,
                total_collected: row.get(8)?,
                error_message: row.get(9)?,
                created_at: row.get(10)?,
                completed_at: row.get(11)?,
            })
        })?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row?);
        }
        Ok(tasks)
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

/// POI 采集任务记录
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PoiTask {
    pub id: i64,
    pub platform: String,
    pub region_name: Option<String>,
    pub region_code: Option<String>,
    pub categories: Option<String>,
    pub status: String,
    pub total_categories: i64,
    pub completed_categories: i64,
    pub total_collected: i64,
    pub error_message: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
}
