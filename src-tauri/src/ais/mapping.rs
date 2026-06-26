//! 把任意 ES `_source` 文档按 FieldMapping 转成统一 AisPoint。
//! 支持点路径取值、geo_point 多种形态、时间戳多格式、数值容错强转。

use super::types::{AisPoint, FieldMapping};
use chrono::{DateTime, NaiveDateTime};
use serde_json::Value;

/// 按点路径（`a.b.c`）取值。
pub fn get_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let mut cur = v;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    Some(cur)
}

/// 递归收集所有叶子字段路径（对象继续下钻，数组/标量视为叶子），供映射 UI 下拉。
pub fn collect_field_paths(source: &Value, prefix: &str, out: &mut Vec<String>) {
    if let Value::Object(map) = source {
        for (k, v) in map {
            let p = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{}.{}", prefix, k)
            };
            match v {
                Value::Object(_) => collect_field_paths(v, &p, out),
                _ => out.push(p),
            }
        }
    }
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 把一个 JSON 值按格式解析为 epoch 毫秒（供解码流程复用）。
pub fn parse_timestamp(v: &Value, fmt: &str) -> Option<i64> {
    parse_ts(v, fmt)
}

fn parse_ts(v: &Value, fmt: &str) -> Option<i64> {
    match fmt {
        "epoch_s" => as_f64(v).map(|x| (x * 1000.0) as i64),
        "iso" => {
            let s = v.as_str()?;
            if let Ok(d) = DateTime::parse_from_rfc3339(s) {
                return Some(d.timestamp_millis());
            }
            // 容错：无时区的 ISO，按 UTC 处理
            for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
                if let Ok(nd) = NaiveDateTime::parse_from_str(s, f) {
                    return Some(nd.and_utc().timestamp_millis());
                }
            }
            // 再容错：数字字符串当作 epoch_ms
            as_f64(v).map(|x| x as i64)
        }
        // epoch_ms 及未知格式
        _ => as_f64(v).map(|x| x as i64),
    }
}

/// 从文档抽取经纬度（WGS-84，原始坐标系下；坐标系归一化在前端做）。
fn extract_latlon(source: &Value, m: &FieldMapping) -> Option<(f64, f64)> {
    if !m.geo_point.trim().is_empty() {
        if let Some(g) = get_path(source, &m.geo_point) {
            match g {
                Value::Object(_) => {
                    let lat = g.get("lat").and_then(as_f64);
                    let lon = g
                        .get("lon")
                        .or_else(|| g.get("lng"))
                        .or_else(|| g.get("longitude"))
                        .and_then(as_f64);
                    if let (Some(la), Some(lo)) = (lat, lon) {
                        return Some((la, lo));
                    }
                }
                Value::Array(arr) if arr.len() >= 2 => {
                    // GeoJSON 约定 [lon, lat]
                    let lon = as_f64(&arr[0]);
                    let lat = as_f64(&arr[1]);
                    if let (Some(la), Some(lo)) = (lat, lon) {
                        return Some((la, lo));
                    }
                }
                Value::String(s) => {
                    // "lat,lon"
                    let parts: Vec<&str> = s.split(',').collect();
                    if parts.len() == 2 {
                        let la = parts[0].trim().parse::<f64>().ok();
                        let lo = parts[1].trim().parse::<f64>().ok();
                        if let (Some(la), Some(lo)) = (la, lo) {
                            return Some((la, lo));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let lat = get_path(source, &m.lat).and_then(as_f64);
    let lon = get_path(source, &m.lon).and_then(as_f64);
    if let (Some(la), Some(lo)) = (lat, lon) {
        return Some((la, lo));
    }
    None
}

/// 把单条文档映射成 AisPoint；缺经纬度则返回 None（跳过该点）。
pub fn extract_point(source: &Value, m: &FieldMapping, fallback_mmsi: &str) -> Option<AisPoint> {
    let (lat, lon) = extract_latlon(source, m)?;
    if !(lat.is_finite() && lon.is_finite()) || (lat == 0.0 && lon == 0.0) {
        return None;
    }
    let ts = get_path(source, &m.timestamp)
        .and_then(|v| parse_ts(v, &m.timestamp_format))
        .unwrap_or(0);
    let mmsi = get_path(source, &m.mmsi)
        .and_then(as_string)
        .unwrap_or_else(|| fallback_mmsi.to_string());
    let opt = |field: &str| -> Option<String> {
        if field.trim().is_empty() {
            None
        } else {
            get_path(source, field).and_then(as_string)
        }
    };
    let opt_f = |field: &str| -> Option<f64> {
        if field.trim().is_empty() {
            None
        } else {
            get_path(source, field).and_then(as_f64)
        }
    };
    Some(AisPoint {
        mmsi,
        name: opt(&m.name),
        lat,
        lon,
        ts,
        sog: opt_f(&m.sog),
        cog: opt_f(&m.cog),
        heading: opt_f(&m.heading),
        nav_status: opt(&m.nav_status),
    })
}
