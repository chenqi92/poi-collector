//! AIS 模块的 tauri 命令。命名空间 ais_*；错误一律 Result<T, String>。

use super::database::AisDatabase;
use super::decoder;
use super::es_client::{total_from_hits, EsClient};
use super::mapping::{collect_field_paths, extract_point, get_path, parse_timestamp};
use super::types::*;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

static AIS_DB: Lazy<RwLock<Option<Arc<AisDatabase>>>> = Lazy::new(|| RwLock::new(None));

fn get_ais_db(app: &AppHandle) -> Result<Arc<AisDatabase>, String> {
    let mut g = AIS_DB.write();
    if g.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("获取应用目录失败: {}", e))?;
        std::fs::create_dir_all(&dir).ok();
        let db = AisDatabase::new(&dir.join("ais_data.db"))
            .map_err(|e| format!("初始化数据库失败: {}", e))?;
        *g = Some(Arc::new(db));
    }
    Ok(g.as_ref().unwrap().clone())
}

/// 聚合 / 精确过滤用的标识字段：优先 aggField，回退 mmsi。
fn id_field(m: &FieldMapping) -> String {
    let agg = m.agg_field.trim();
    if !agg.is_empty() {
        agg.to_string()
    } else {
        m.mmsi.trim().to_string()
    }
}

/// 把聚合返回的时间 value（f64）按格式归一化为 epoch 毫秒。
/// date 字段的 min/max agg 返回的已是毫秒；epoch_s 数值字段需 ×1000。
fn norm_ts(value: f64, fmt: &str) -> i64 {
    match fmt {
        "epoch_s" => (value * 1000.0) as i64,
        _ => value as i64,
    }
}

/// 构造时间范围 filter（入参是 epoch 毫秒，按字段格式换算）。
fn time_filter(ts_field: &str, fmt: &str, from: Option<i64>, to: Option<i64>) -> Option<Value> {
    if from.is_none() && to.is_none() {
        return None;
    }
    let conv = |ms: i64| -> Value {
        match fmt {
            "epoch_s" => json!(ms / 1000),
            _ => json!(ms),
        }
    };
    let mut range = serde_json::Map::new();
    if let Some(f) = from {
        range.insert("gte".into(), conv(f));
    }
    if let Some(t) = to {
        range.insert("lte".into(), conv(t));
    }
    if fmt == "iso" {
        // date 字段：用毫秒 + epoch_millis 格式
        range.insert("format".into(), json!("epoch_millis"));
    }
    Some(json!({ "range": { ts_field: Value::Object(range) } }))
}

fn val_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 把多个索引拼成 ES 接受的逗号分隔模式；去空去重保序。支持通配（如 ais-*）。
fn join_indices(indices: &[String]) -> String {
    let mut seen = HashSet::new();
    let mut parts: Vec<&str> = Vec::new();
    for s in indices {
        let t = s.trim();
        if !t.is_empty() && seen.insert(t) {
            parts.push(t);
        }
    }
    parts.join(",")
}

// ===== 连接配置 CRUD =====

#[tauri::command]
pub fn ais_list_connections(app: AppHandle) -> Result<Vec<EsConnection>, String> {
    let db = get_ais_db(&app)?;
    db.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ais_save_connection(
    app: AppHandle,
    mut conn: EsConnection,
) -> Result<EsConnection, String> {
    let db = get_ais_db(&app)?;
    if conn.id.trim().is_empty() {
        conn.id = Uuid::new_v4().to_string();
    }
    if conn.name.trim().is_empty() {
        conn.name = format!("{}:{}", conn.host, conn.port);
    }
    db.upsert(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn ais_delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let db = get_ais_db(&app)?;
    db.delete(&id).map_err(|e| e.to_string())
}

// ===== 列出索引 =====

#[tauri::command]
pub async fn ais_list_indices(conn: EsConnection) -> Result<Vec<IndexInfo>, String> {
    let client = EsClient::new(&conn)?;
    // _cat/indices 返回每个索引的 index 名与文档数；按名称排序。
    let v = client
        .get("/_cat/indices?format=json&h=index,docs.count&s=index")
        .await?;
    let arr = v.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(arr.len());
    for item in &arr {
        let name = item
            .get("index")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let docs_count = item
            .get("docs.count")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse::<u64>().ok());
        out.push(IndexInfo { name, docs_count });
    }
    // 业务索引排前面，系统索引（. 开头）排后面
    out.sort_by(|a, b| {
        let sa = a.name.starts_with('.');
        let sb = b.name.starts_with('.');
        sa.cmp(&sb).then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

// ===== 测试连接 + 采样字段 =====

#[tauri::command]
pub async fn ais_test_connection(
    conn: EsConnection,
    index: Option<String>,
) -> Result<EsTestResult, String> {
    let client = EsClient::new(&conn)?;
    let root = client.get_root().await?;
    let version = root
        .get("version")
        .and_then(|v| v.get("number"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let cluster_name = root
        .get("cluster_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 采样若干文档，收集字段路径用于驱动映射 UI
    let idx = index.unwrap_or_default();
    let idx = idx.trim();
    if idx.is_empty() {
        return Ok(EsTestResult {
            ok: true,
            version: version.clone(),
            cluster_name,
            doc_count: None,
            field_paths: vec![],
            sample: Value::Null,
            message: format!("已连接 ES {}（未指定索引，无法采样字段）", version),
        });
    }

    let body = json!({ "size": 5, "query": { "match_all": {} } });
    match client.search(idx, &body).await {
        Ok(resp) => {
            let (total, _gte) = total_from_hits(&resp);
            let mut field_paths = Vec::new();
            let mut sample = Value::Null;
            if let Some(hits) = resp["hits"]["hits"].as_array() {
                if let Some(first) = hits.iter().find_map(|h| h.get("_source")) {
                    sample = first.clone();
                    collect_field_paths(&sample, "", &mut field_paths);
                    field_paths.sort();
                    field_paths.dedup();
                }
            }
            Ok(EsTestResult {
                ok: true,
                version: version.clone(),
                cluster_name,
                doc_count: Some(total),
                field_paths,
                sample,
                message: format!("连接成功 · ES {} · 索引约 {} 条", version, total),
            })
        }
        Err(e) => Ok(EsTestResult {
            ok: true,
            version: version.clone(),
            cluster_name,
            doc_count: None,
            field_paths: vec![],
            sample: Value::Null,
            message: format!("已连接 ES {}，但采样索引失败：{}", version, e),
        }),
    }
}

// ===== 船只列表（terms 聚合）=====

#[tauri::command]
pub async fn ais_list_ships(
    app: AppHandle,
    conn_id: String,
    indices: Vec<String>,
    mapping: FieldMapping,
    time_from: Option<i64>,
    time_to: Option<i64>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ShipSummary>, String> {
    let db = get_ais_db(&app)?;
    let conn = db
        .get(&conn_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    let idx = join_indices(&indices);
    if idx.is_empty() {
        return Err("请先选择至少一个索引".to_string());
    }
    let m = mapping;
    let id_f = id_field(&m);
    if id_f.is_empty() {
        return Err("请先在字段映射里设置 MMSI（或可聚合的 aggField）".to_string());
    }
    if m.timestamp.trim().is_empty() {
        return Err("请先在字段映射里设置时间字段".to_string());
    }
    let ts_field = m.timestamp.trim().to_string();

    let mut filters: Vec<Value> = Vec::new();
    if let Some(tf) = time_filter(&ts_field, &m.timestamp_format, time_from, time_to) {
        filters.push(tf);
    }
    if let Some(s) = search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let mut should = vec![json!({ "wildcard": { id_f.clone(): { "value": format!("*{}*", s) } } })];
        if !m.name.trim().is_empty() {
            should.push(json!({ "wildcard": { m.name.trim(): { "value": format!("*{}*", s) } } }));
        }
        filters.push(json!({ "bool": { "should": should, "minimum_should_match": 1 } }));
    }

    let mut ship_aggs = serde_json::Map::new();
    ship_aggs.insert("first".into(), json!({ "min": { "field": ts_field } }));
    ship_aggs.insert("last".into(), json!({ "max": { "field": ts_field } }));
    if !m.name.trim().is_empty() {
        ship_aggs.insert(
            "nm".into(),
            json!({ "top_hits": { "size": 1, "_source": { "includes": [m.name.trim()] } } }),
        );
    }

    let body = json!({
        "size": 0,
        "query": { "bool": { "filter": filters } },
        "aggs": {
            "ships": {
                "terms": { "field": id_f, "size": limit.unwrap_or(500) },
                "aggs": Value::Object(ship_aggs)
            }
        }
    });

    let client = EsClient::new(&conn)?;
    let resp = client.search(&idx, &body).await?;
    let buckets = resp["aggregations"]["ships"]["buckets"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(buckets.len());
    for b in &buckets {
        let mmsi = match val_to_string(&b["key"]) {
            Some(s) => s,
            None => continue,
        };
        let count = b["doc_count"].as_u64().unwrap_or(0);
        let first_ts = b["first"]["value"]
            .as_f64()
            .map(|v| norm_ts(v, &m.timestamp_format));
        let last_ts = b["last"]["value"]
            .as_f64()
            .map(|v| norm_ts(v, &m.timestamp_format));
        let name = if m.name.trim().is_empty() {
            None
        } else {
            b["nm"]["hits"]["hits"]
                .as_array()
                .and_then(|h| h.first())
                .and_then(|h| h.get("_source"))
                .and_then(|src| get_path(src, m.name.trim()))
                .and_then(val_to_string)
        };
        out.push(ShipSummary {
            mmsi,
            name,
            count,
            first_ts,
            last_ts,
        });
    }
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(out)
}

// ===== 单船航迹（from/size 分页，跨版本兼容）=====

#[tauri::command]
pub async fn ais_get_ship_route(
    app: AppHandle,
    conn_id: String,
    indices: Vec<String>,
    mapping: FieldMapping,
    mmsi: String,
    time_from: Option<i64>,
    time_to: Option<i64>,
    max_points: Option<u32>,
) -> Result<RouteResponse, String> {
    let db = get_ais_db(&app)?;
    let conn = db
        .get(&conn_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    let idx = join_indices(&indices);
    if idx.is_empty() {
        return Err("请先选择至少一个索引".to_string());
    }
    let m = mapping;
    let id_f = id_field(&m);
    if id_f.is_empty() {
        return Err("请先在字段映射里设置 MMSI（或可聚合的 aggField）".to_string());
    }
    if m.timestamp.trim().is_empty() {
        return Err("请先在字段映射里设置时间字段".to_string());
    }
    let ts_field = m.timestamp.trim().to_string();

    let mut filters: Vec<Value> = vec![json!({ "term": { id_f.clone(): mmsi } })];
    if let Some(tf) = time_filter(&ts_field, &m.timestamp_format, time_from, time_to) {
        filters.push(tf);
    }

    // from/size 受 index.max_result_window 限制（默认 1万），完全无视版本差异且不漏点。
    let cap = max_points.unwrap_or(10000).min(10000) as usize;
    let page = 1000usize;

    let client = EsClient::new(&conn)?;
    let mut points: Vec<AisPoint> = Vec::new();
    let mut from = 0usize;
    let mut total = 0u64;
    let mut gte = false;

    loop {
        let size = page.min(cap.saturating_sub(from));
        if size == 0 {
            break;
        }
        let body = json!({
            "from": from,
            "size": size,
            "query": { "bool": { "filter": filters.clone() } },
            "sort": [ { ts_field.clone(): { "order": "asc" } } ]
        });
        let resp = client.search(&idx, &body).await?;
        let (t, g) = total_from_hits(&resp);
        total = t;
        gte = g;
        let hits = resp["hits"]["hits"].as_array().cloned().unwrap_or_default();
        let got = hits.len();
        for h in &hits {
            if let Some(src) = h.get("_source") {
                if let Some(p) = extract_point(src, &m, &mmsi) {
                    points.push(p);
                }
            }
        }
        from += got;
        if got < size || from >= cap {
            break;
        }
    }

    let truncated = gte || total > points.len() as u64 || (from >= cap && total > from as u64);
    let name = points.iter().find_map(|p| p.name.clone());
    Ok(RouteResponse {
        mmsi,
        name,
        points,
        total,
        truncated,
    })
}

// ===== 渐进式单船航迹（scroll 分页，无 max_result_window 上限）=====

#[tauri::command]
pub async fn ais_route_page(
    app: AppHandle,
    conn_id: String,
    indices: Vec<String>,
    mapping: FieldMapping,
    mmsi: String,
    time_from: Option<i64>,
    time_to: Option<i64>,
    size: Option<u32>,
    scroll_id: Option<String>,
) -> Result<RoutePage, String> {
    let db = get_ais_db(&app)?;
    let conn = db
        .get(&conn_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    let client = EsClient::new(&conn)?;
    let m = mapping;

    // 续页：直接 scroll_next
    if let Some(sid) = scroll_id.filter(|s| !s.trim().is_empty()) {
        let resp = client.scroll_next(&sid, "2m").await?;
        let hits = resp["hits"]["hits"].as_array().cloned().unwrap_or_default();
        let mut points = Vec::with_capacity(hits.len());
        for h in &hits {
            if let Some(src) = h.get("_source") {
                if let Some(p) = extract_point(src, &m, &mmsi) {
                    points.push(p);
                }
            }
        }
        let done = hits.is_empty();
        let new_sid = resp["_scroll_id"]
            .as_str()
            .map(|s| s.to_string())
            .or(Some(sid.clone()));
        if done {
            client.scroll_clear(&sid).await;
        }
        return Ok(RoutePage {
            points,
            scroll_id: new_sid,
            total: 0,
            done,
        });
    }

    // 首页：起 scroll（按时间升序）
    let idx = join_indices(&indices);
    if idx.is_empty() {
        return Err("请先选择至少一个索引".to_string());
    }
    let id_f = id_field(&m);
    if id_f.is_empty() {
        return Err("请先在字段映射里设置 MMSI（或可聚合的 aggField）".to_string());
    }
    if m.timestamp.trim().is_empty() {
        return Err("请先在字段映射里设置时间字段".to_string());
    }
    let ts_field = m.timestamp.trim().to_string();
    let page = size.unwrap_or(5000).clamp(500, 10000) as usize;

    let mut filters: Vec<Value> = vec![json!({ "term": { id_f.clone(): mmsi.clone() } })];
    if let Some(tf) = time_filter(&ts_field, &m.timestamp_format, time_from, time_to) {
        filters.push(tf);
    }
    // 只取用到的字段，减小每条文档的传输体积，加快加载
    let mut src: Vec<String> = Vec::new();
    for c in [
        m.mmsi.as_str(),
        m.name.as_str(),
        m.lat.as_str(),
        m.lon.as_str(),
        m.geo_point.as_str(),
        ts_field.as_str(),
        m.sog.as_str(),
        m.cog.as_str(),
        m.heading.as_str(),
        m.nav_status.as_str(),
    ] {
        let c = c.trim();
        if !c.is_empty() && !src.iter().any(|x| x == c) {
            src.push(c.to_string());
        }
    }
    let body = json!({
        "size": page,
        "_source": src,
        "query": { "bool": { "filter": filters } },
        "sort": [ { ts_field.clone(): { "order": "asc" } } ]
    });
    let (sid, resp) = client.scroll_start(&idx, &body, "2m").await?;
    let (total, _gte) = total_from_hits(&resp);
    let hits = resp["hits"]["hits"].as_array().cloned().unwrap_or_default();
    let mut points = Vec::with_capacity(hits.len());
    for h in &hits {
        if let Some(src) = h.get("_source") {
            if let Some(p) = extract_point(src, &m, &mmsi) {
                points.push(p);
            }
        }
    }
    let done = hits.is_empty();
    let new_sid = resp["_scroll_id"]
        .as_str()
        .map(|s| s.to_string())
        .or(Some(sid));
    Ok(RoutePage {
        points,
        scroll_id: new_sid,
        total,
        done,
    })
}

// ===== raw 模式：scroll 拉取一个时间窗并解码 AIVDM =====

#[tauri::command]
pub async fn ais_pull_window(
    app: AppHandle,
    conn_id: String,
    indices: Vec<String>,
    mapping: FieldMapping,
    time_from: Option<i64>,
    time_to: Option<i64>,
    max_points: Option<u32>,
    mmsi: Option<String>,
) -> Result<PullResult, String> {
    let db = get_ais_db(&app)?;
    let conn = db
        .get(&conn_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    let idx = join_indices(&indices);
    if idx.is_empty() {
        return Err("请先选择至少一个索引".to_string());
    }
    let m = mapping;
    let msg_field = if m.message.trim().is_empty() {
        "message".to_string()
    } else {
        m.message.trim().to_string()
    };
    let ts_field = if m.timestamp.trim().is_empty() {
        "createDateTime".to_string()
    } else {
        m.timestamp.trim().to_string()
    };

    let cap = max_points.unwrap_or(50000).min(300000) as usize;
    let batch = 2000usize;
    // 指定 MMSI 时：扫描全部所选索引、只保留这艘船的点（cap 作用于该船），
    // 用来跨多索引拉一艘船的完整航迹。
    let mmsi_filter: Option<String> = mmsi
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut filters: Vec<Value> = Vec::new();
    if let Some(tf) = time_filter(&ts_field, &m.timestamp_format, time_from, time_to) {
        filters.push(tf);
    }

    // 不排序，按 _doc 顺序 scroll（单日索引≈写入时间序），避免对千万级文档做排序。
    let body = json!({
        "size": batch,
        "_source": [msg_field.clone(), ts_field.clone()],
        "query": { "bool": { "filter": filters } }
    });

    let client = EsClient::new(&conn)?;
    let mut points: Vec<AisPoint> = Vec::new();
    let mut names: HashMap<u32, String> = HashMap::new();
    let mut scanned: u64 = 0;
    let mut reached_cap = false;

    let (mut scroll_id, mut resp) = client.scroll_start(&idx, &body, "2m").await?;
    loop {
        let hits = resp["hits"]["hits"].as_array().cloned().unwrap_or_default();
        if hits.is_empty() {
            break;
        }
        for h in &hits {
            scanned += 1;
            let src = match h.get("_source") {
                Some(s) => s,
                None => continue,
            };
            let msg = match get_path(src, &msg_field).and_then(|v| v.as_str()) {
                Some(s) => s,
                None => continue,
            };
            let ts = get_path(src, &ts_field)
                .and_then(|v| parse_timestamp(v, &m.timestamp_format))
                .unwrap_or(0);
            match decoder::decode(msg) {
                decoder::Decoded::Position {
                    mmsi,
                    lat,
                    lon,
                    sog,
                    cog,
                    heading,
                    nav_status,
                    name,
                } => {
                    if let Some(n) = name {
                        names.entry(mmsi).or_insert(n);
                    }
                    // 指定了 MMSI 就只收这艘船的点（不计入上限、继续扫描）
                    if let Some(ref want) = mmsi_filter {
                        if mmsi.to_string() != *want {
                            continue;
                        }
                    }
                    points.push(AisPoint {
                        mmsi: mmsi.to_string(),
                        name: None,
                        lat,
                        lon,
                        ts,
                        sog,
                        cog,
                        heading,
                        nav_status: nav_status.map(|n| n.to_string()),
                    });
                    if points.len() >= cap {
                        reached_cap = true;
                        break;
                    }
                }
                decoder::Decoded::Name { mmsi, name } => {
                    names.entry(mmsi).or_insert(name);
                }
                decoder::Decoded::Other => {}
            }
        }
        if reached_cap {
            break;
        }
        match client.scroll_next(&scroll_id, "2m").await {
            Ok(r) => {
                if let Some(sid) = r["_scroll_id"].as_str() {
                    scroll_id = sid.to_string();
                }
                resp = r;
            }
            Err(_) => break,
        }
    }
    client.scroll_clear(&scroll_id).await;

    // 回填船名（来自 type 24A / type 19）
    if !names.is_empty() {
        for p in &mut points {
            if p.name.is_none() {
                if let Ok(id) = p.mmsi.parse::<u32>() {
                    if let Some(n) = names.get(&id) {
                        p.name = Some(n.clone());
                    }
                }
            }
        }
    }

    let ships = points
        .iter()
        .map(|p| p.mmsi.as_str())
        .collect::<HashSet<&str>>()
        .len() as u64;
    let decoded = points.len() as u64;
    Ok(PullResult {
        ships,
        scanned,
        decoded,
        truncated: reached_cap,
        points,
    })
}
