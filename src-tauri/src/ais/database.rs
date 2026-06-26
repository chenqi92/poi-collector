//! ES 连接配置持久化（ais_data.db）。只存连接 + 字段映射 + 默认轨迹参数，不存 AIS 数据。
//! 凭据明文存储——与现有 api_keys 表一致。

use super::types::{EsConnection, FieldMapping};
use parking_lot::Mutex;
use rusqlite::{params, Connection, Result, Row};
use serde_json::Value;
use std::path::Path;

pub struct AisDatabase {
    conn: Mutex<Connection>,
}

impl AisDatabase {
    pub fn new(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.lock().execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS es_connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                scheme TEXT NOT NULL DEFAULT 'http',
                host TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 9200,
                index_name TEXT NOT NULL DEFAULT '',
                auth_type TEXT NOT NULL DEFAULT 'none',
                username TEXT,
                password TEXT,
                api_key TEXT,
                accept_invalid_certs INTEGER NOT NULL DEFAULT 0,
                source_crs TEXT NOT NULL DEFAULT 'wgs84',
                field_mapping TEXT NOT NULL DEFAULT '{}',
                trajectory_params TEXT NOT NULL DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;
        // 迁移：旧库补 data_mode 列（已存在则忽略错误）
        let _ = self.conn.lock().execute(
            "ALTER TABLE es_connections ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'fields'",
            [],
        );
        Ok(())
    }

    const SELECT_COLS: &'static str = "id,name,scheme,host,port,index_name,auth_type,username,password,api_key,accept_invalid_certs,source_crs,field_mapping,trajectory_params,data_mode";

    pub fn list(&self) -> Result<Vec<EsConnection>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {} FROM es_connections ORDER BY updated_at DESC",
            Self::SELECT_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_conn)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<EsConnection>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {} FROM es_connections WHERE id = ?1",
            Self::SELECT_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query_map(params![id], row_to_conn)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn upsert(&self, c: &EsConnection) -> Result<()> {
        let fm = serde_json::to_string(&c.field_mapping).unwrap_or_else(|_| "{}".to_string());
        let tp = serde_json::to_string(&c.trajectory_params).unwrap_or_else(|_| "{}".to_string());
        self.conn.lock().execute(
            "INSERT INTO es_connections
                (id,name,scheme,host,port,index_name,auth_type,username,password,api_key,accept_invalid_certs,source_crs,field_mapping,trajectory_params,data_mode,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
                name=?2, scheme=?3, host=?4, port=?5, index_name=?6, auth_type=?7,
                username=?8, password=?9, api_key=?10, accept_invalid_certs=?11,
                source_crs=?12, field_mapping=?13, trajectory_params=?14, data_mode=?15, updated_at=CURRENT_TIMESTAMP",
            params![
                c.id,
                c.name,
                c.scheme,
                c.host,
                c.port as i64,
                c.index,
                c.auth_type,
                c.username,
                c.password,
                c.api_key,
                c.accept_invalid_certs as i64,
                c.source_crs,
                fm,
                tp,
                c.data_mode,
            ],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM es_connections WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn row_to_conn(row: &Row) -> Result<EsConnection> {
    let fm_str: String = row.get(12)?;
    let tp_str: String = row.get(13)?;
    let field_mapping: FieldMapping = serde_json::from_str(&fm_str).unwrap_or_default();
    let trajectory_params: Value = serde_json::from_str(&tp_str).unwrap_or(Value::Null);
    Ok(EsConnection {
        id: row.get(0)?,
        name: row.get(1)?,
        scheme: row.get(2)?,
        host: row.get(3)?,
        port: row.get::<_, i64>(4)? as u16,
        index: row.get(5)?,
        auth_type: row.get(6)?,
        username: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        password: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        api_key: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        accept_invalid_certs: row.get::<_, i64>(10)? != 0,
        source_crs: row.get(11)?,
        data_mode: row.get(14)?,
        field_mapping,
        trajectory_params,
    })
}
