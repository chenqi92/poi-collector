use once_cell::sync::Lazy;
use parking_lot::RwLock;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
});

// 边界缓存
static BOUNDARY_CACHE: Lazy<RwLock<HashMap<String, Value>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionBounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryResult {
    pub geojson: Value,
    pub bounds: RegionBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryRegionInput {
    pub code: String,
    pub name: String,
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundarySummary {
    pub code: String,
    pub name: String,
    pub level: String,
    pub bounds: RegionBounds,
    pub feature_count: usize,
    pub polygon_count: usize,
    pub ring_count: usize,
    pub point_count: usize,
}

#[derive(Debug, Default, Clone)]
struct GeometryStats {
    feature_count: usize,
    polygon_count: usize,
    ring_count: usize,
    point_count: usize,
}

/// 从阿里云 DataV.GeoAtlas 获取行政区边界
/// API: https://geo.datav.aliyun.com/areas_v3/bound/{code}_full.json
#[tauri::command]
pub async fn get_region_boundary(region_code: String) -> Result<BoundaryResult, String> {
    fetch_region_boundary(region_code, true).await
}

async fn fetch_region_boundary(
    region_code: String,
    include_children: bool,
) -> Result<BoundaryResult, String> {
    let (padded_code, can_use_full) = normalize_region_code(&region_code);
    let use_full = include_children && can_use_full;
    let cache_key = format!(
        "{}:{}",
        padded_code,
        if use_full { "full" } else { "outline" }
    );

    // 检查缓存
    {
        let cache = BOUNDARY_CACHE.read();
        if let Some(geojson) = cache.get(&cache_key) {
            let bounds = extract_bounds(geojson);
            return Ok(BoundaryResult {
                geojson: geojson.clone(),
                bounds,
            });
        }
    }

    let url = if use_full {
        format!(
            "https://geo.datav.aliyun.com/areas_v3/bound/{}_full.json",
            padded_code
        )
    } else {
        format!(
            "https://geo.datav.aliyun.com/areas_v3/bound/{}.json",
            padded_code
        )
    };

    log::info!("获取行政区边界: {} -> {}", region_code, url);

    let response = HTTP_CLIENT
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("请求边界数据失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("获取边界失败: HTTP {}", response.status()));
    }

    let geojson: Value = response
        .json()
        .await
        .map_err(|e| format!("解析边界数据失败: {}", e))?;

    // 计算边界框
    let bounds = extract_bounds(&geojson);

    // 存入缓存
    {
        let mut cache = BOUNDARY_CACHE.write();
        cache.insert(cache_key, geojson.clone());
    }

    Ok(BoundaryResult { geojson, bounds })
}

fn normalize_region_code(region_code: &str) -> (String, bool) {
    match region_code.len() {
        2 => (format!("{}0000", region_code), true), // 省级: 11 -> 110000
        4 => (format!("{}00", region_code), true),   // 市级: 1101 -> 110100
        _ => (region_code.to_string(), false),       // 区县级: 110101
    }
}

#[tauri::command]
pub async fn collect_region_boundaries(
    regions: Vec<BoundaryRegionInput>,
    include_children: bool,
) -> Result<Vec<BoundarySummary>, String> {
    if regions.is_empty() {
        return Err("请先选择行政区".to_string());
    }
    if regions.len() > 100 {
        return Err("一次最多预览 100 个行政区边界".to_string());
    }

    let mut summaries = Vec::with_capacity(regions.len());
    for region in regions {
        let boundary = fetch_region_boundary(region.code.clone(), include_children).await?;
        let stats = collect_geojson_stats(&boundary.geojson);
        summaries.push(BoundarySummary {
            code: region.code,
            name: region.name,
            level: region.level,
            bounds: boundary.bounds,
            feature_count: stats.feature_count,
            polygon_count: stats.polygon_count,
            ring_count: stats.ring_count,
            point_count: stats.point_count,
        });
    }

    Ok(summaries)
}

#[tauri::command]
pub async fn export_region_boundaries_to_file(
    path: String,
    format: String,
    regions: Vec<BoundaryRegionInput>,
    include_children: bool,
) -> Result<usize, String> {
    if regions.is_empty() {
        return Err("请先选择行政区".to_string());
    }
    if regions.len() > 100 {
        return Err("一次最多导出 100 个行政区边界".to_string());
    }

    let mut rows = Vec::with_capacity(regions.len());
    for region in regions {
        let boundary = fetch_region_boundary(region.code.clone(), include_children).await?;
        let stats = collect_geojson_stats(&boundary.geojson);
        rows.push((region, boundary, stats));
    }

    match format.as_str() {
        "geojson" => write_geojson_export(&path, &rows, include_children)?,
        "json" => write_json_export(&path, &rows, include_children)?,
        "csv" => write_csv_export(&path, &rows)?,
        _ => return Err("不支持的边界导出格式".to_string()),
    }

    Ok(rows.len())
}

/// 从 GeoJSON 提取边界框
fn extract_bounds(geojson: &Value) -> RegionBounds {
    let mut min_lon = 180.0_f64;
    let mut max_lon = -180.0_f64;
    let mut min_lat = 90.0_f64;
    let mut max_lat = -90.0_f64;

    // 递归提取所有坐标
    fn extract_coords(value: &Value, coords: &mut Vec<(f64, f64)>) {
        match value {
            Value::Array(arr) => {
                // 检查是否是坐标对 [lon, lat]
                if arr.len() == 2 {
                    if let (Some(lon), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                        // 看起来像坐标对
                        if lon >= -180.0 && lon <= 180.0 && lat >= -90.0 && lat <= 90.0 {
                            coords.push((lon, lat));
                            return;
                        }
                    }
                }
                // 递归处理数组元素
                for item in arr {
                    extract_coords(item, coords);
                }
            }
            Value::Object(obj) => {
                // 处理 GeoJSON 结构
                if let Some(features) = obj.get("features") {
                    extract_coords(features, coords);
                }
                if let Some(geometry) = obj.get("geometry") {
                    extract_coords(geometry, coords);
                }
                if let Some(coordinates) = obj.get("coordinates") {
                    extract_coords(coordinates, coords);
                }
            }
            _ => {}
        }
    }

    let mut coords = Vec::new();
    extract_coords(geojson, &mut coords);

    for (lon, lat) in coords {
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
    }

    RegionBounds {
        north: max_lat,
        south: min_lat,
        east: max_lon,
        west: min_lon,
    }
}

fn collect_geojson_stats(geojson: &Value) -> GeometryStats {
    let mut stats = GeometryStats::default();
    collect_stats_from_value(geojson, &mut stats, true);
    stats
}

fn collect_stats_from_value(value: &Value, stats: &mut GeometryStats, count_feature: bool) {
    let Some(obj) = value.as_object() else {
        return;
    };

    match obj.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => {
            if let Some(features) = obj.get("features").and_then(Value::as_array) {
                for feature in features {
                    collect_stats_from_value(feature, stats, true);
                }
            }
        }
        Some("Feature") => {
            if count_feature {
                stats.feature_count += 1;
            }
            if let Some(geometry) = obj.get("geometry") {
                collect_stats_from_value(geometry, stats, false);
            }
        }
        Some("GeometryCollection") => {
            if count_feature {
                stats.feature_count += 1;
            }
            if let Some(geometries) = obj.get("geometries").and_then(Value::as_array) {
                for geometry in geometries {
                    collect_stats_from_value(geometry, stats, false);
                }
            }
        }
        Some(geometry_type) => {
            if count_feature {
                stats.feature_count += 1;
            }
            if let Some(coords) = obj.get("coordinates") {
                match geometry_type {
                    "Polygon" => count_polygon(coords, stats),
                    "MultiPolygon" => count_multi_polygon(coords, stats),
                    _ => {
                        stats.point_count += count_coordinate_pairs(coords);
                    }
                }
            }
        }
        None => {}
    }
}

fn count_polygon(coords: &Value, stats: &mut GeometryStats) {
    let Some(rings) = coords.as_array() else {
        return;
    };
    stats.polygon_count += 1;
    stats.ring_count += rings.len();
    for ring in rings {
        stats.point_count += count_coordinate_pairs(ring);
    }
}

fn count_multi_polygon(coords: &Value, stats: &mut GeometryStats) {
    let Some(polygons) = coords.as_array() else {
        return;
    };
    stats.polygon_count += polygons.len();
    for polygon in polygons {
        if let Some(rings) = polygon.as_array() {
            stats.ring_count += rings.len();
            for ring in rings {
                stats.point_count += count_coordinate_pairs(ring);
            }
        }
    }
}

fn count_coordinate_pairs(value: &Value) -> usize {
    match value {
        Value::Array(arr) => {
            if coord_pair(value).is_some() {
                1
            } else {
                arr.iter().map(count_coordinate_pairs).sum()
            }
        }
        _ => 0,
    }
}

fn coord_pair(value: &Value) -> Option<(f64, f64)> {
    let arr = value.as_array()?;
    if arr.len() < 2 {
        return None;
    }
    let lon = arr[0].as_f64()?;
    let lat = arr[1].as_f64()?;
    if (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat) {
        Some((lon, lat))
    } else {
        None
    }
}

fn write_geojson_export(
    path: &str,
    rows: &[(BoundaryRegionInput, BoundaryResult, GeometryStats)],
    include_children: bool,
) -> Result<(), String> {
    let mut features = Vec::new();

    for (region, boundary, _) in rows {
        append_geojson_features(&boundary.geojson, region, &mut features);
    }

    let output = serde_json::json!({
        "type": "FeatureCollection",
        "source": "DataV.GeoAtlas",
        "include_children": include_children,
        "generated_at": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "regions": rows.iter().map(|(region, boundary, stats)| {
            serde_json::json!({
                "code": region.code,
                "name": region.name,
                "level": region.level,
                "bounds": boundary.bounds,
                "feature_count": stats.feature_count,
                "polygon_count": stats.polygon_count,
                "ring_count": stats.ring_count,
                "point_count": stats.point_count,
            })
        }).collect::<Vec<_>>(),
        "features": features,
    });

    write_json_file(path, &output)
}

fn write_json_export(
    path: &str,
    rows: &[(BoundaryRegionInput, BoundaryResult, GeometryStats)],
    include_children: bool,
) -> Result<(), String> {
    let output = serde_json::json!({
        "source": "DataV.GeoAtlas",
        "include_children": include_children,
        "generated_at": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "items": rows.iter().map(|(region, boundary, stats)| {
            serde_json::json!({
                "code": region.code,
                "name": region.name,
                "level": region.level,
                "bounds": boundary.bounds,
                "feature_count": stats.feature_count,
                "polygon_count": stats.polygon_count,
                "ring_count": stats.ring_count,
                "point_count": stats.point_count,
                "geojson": boundary.geojson,
            })
        }).collect::<Vec<_>>(),
    });

    write_json_file(path, &output)
}

fn write_json_file(path: &str, value: &Value) -> Result<(), String> {
    let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    bytes.extend_from_slice(json.as_bytes());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

fn append_geojson_features(
    geojson: &Value,
    region: &BoundaryRegionInput,
    features: &mut Vec<Value>,
) {
    let Some(obj) = geojson.as_object() else {
        return;
    };

    match obj.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => {
            if let Some(items) = obj.get("features").and_then(Value::as_array) {
                for feature in items {
                    append_geojson_features(feature, region, features);
                }
            }
        }
        Some("Feature") => {
            let mut feature = geojson.clone();
            enrich_feature_properties(&mut feature, region);
            features.push(feature);
        }
        Some(_) => {
            features.push(serde_json::json!({
                "type": "Feature",
                "properties": {
                    "selected_region_code": region.code,
                    "selected_region_name": region.name,
                    "selected_region_level": region.level,
                },
                "geometry": geojson,
            }));
        }
        None => {}
    }
}

fn enrich_feature_properties(feature: &mut Value, region: &BoundaryRegionInput) {
    let Some(obj) = feature.as_object_mut() else {
        return;
    };
    if !obj.get("properties").is_some_and(Value::is_object) {
        obj.insert("properties".to_string(), serde_json::json!({}));
    }
    if let Some(props) = obj.get_mut("properties").and_then(Value::as_object_mut) {
        props.insert(
            "selected_region_code".to_string(),
            Value::String(region.code.clone()),
        );
        props.insert(
            "selected_region_name".to_string(),
            Value::String(region.name.clone()),
        );
        props.insert(
            "selected_region_level".to_string(),
            Value::String(region.level.clone()),
        );
    }
}

fn write_csv_export(
    path: &str,
    rows: &[(BoundaryRegionInput, BoundaryResult, GeometryStats)],
) -> Result<(), String> {
    let mut csv = String::from(
        "selected_region_code,selected_region_name,selected_region_level,feature_index,feature_adcode,feature_name,geometry_type,polygon_index,ring_index,point_index,lon,lat\n",
    );

    for (region, boundary, _) in rows {
        append_csv_rows(&boundary.geojson, region, &mut csv);
    }

    let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(csv.as_bytes());
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

fn append_csv_rows(geojson: &Value, region: &BoundaryRegionInput, csv: &mut String) {
    let Some(obj) = geojson.as_object() else {
        return;
    };

    match obj.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => {
            if let Some(features) = obj.get("features").and_then(Value::as_array) {
                for (idx, feature) in features.iter().enumerate() {
                    append_feature_csv_rows(feature, region, idx, csv);
                }
            }
        }
        Some("Feature") => append_feature_csv_rows(geojson, region, 0, csv),
        Some(_) => append_geometry_csv_rows(geojson, region, 0, "", "", csv),
        None => {}
    }
}

fn append_feature_csv_rows(
    feature: &Value,
    region: &BoundaryRegionInput,
    feature_index: usize,
    csv: &mut String,
) {
    let properties = feature.get("properties");
    let feature_adcode = property_string(properties, &["adcode", "code"]);
    let feature_name = property_string(properties, &["name", "fullname"]);
    if let Some(geometry) = feature.get("geometry") {
        append_geometry_csv_rows(
            geometry,
            region,
            feature_index,
            &feature_adcode,
            &feature_name,
            csv,
        );
    }
}

fn property_string(properties: Option<&Value>, keys: &[&str]) -> String {
    let Some(obj) = properties.and_then(Value::as_object) else {
        return String::new();
    };
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(s) = value.as_str() {
                return s.to_string();
            }
            if value.is_number() {
                return value.to_string();
            }
        }
    }
    String::new()
}

fn append_geometry_csv_rows(
    geometry: &Value,
    region: &BoundaryRegionInput,
    feature_index: usize,
    feature_adcode: &str,
    feature_name: &str,
    csv: &mut String,
) {
    let Some(obj) = geometry.as_object() else {
        return;
    };
    let geometry_type = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(coords) = obj.get("coordinates") else {
        if geometry_type == "GeometryCollection" {
            if let Some(geometries) = obj.get("geometries").and_then(Value::as_array) {
                for item in geometries {
                    append_geometry_csv_rows(
                        item,
                        region,
                        feature_index,
                        feature_adcode,
                        feature_name,
                        csv,
                    );
                }
            }
        }
        return;
    };

    match geometry_type {
        "Polygon" => append_polygon_csv_rows(
            coords,
            region,
            feature_index,
            feature_adcode,
            feature_name,
            geometry_type,
            0,
            csv,
        ),
        "MultiPolygon" => {
            if let Some(polygons) = coords.as_array() {
                for (polygon_index, polygon) in polygons.iter().enumerate() {
                    append_polygon_csv_rows(
                        polygon,
                        region,
                        feature_index,
                        feature_adcode,
                        feature_name,
                        geometry_type,
                        polygon_index,
                        csv,
                    );
                }
            }
        }
        _ => append_coordinate_tree_csv_rows(
            coords,
            region,
            feature_index,
            feature_adcode,
            feature_name,
            geometry_type,
            0,
            0,
            csv,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn append_polygon_csv_rows(
    polygon: &Value,
    region: &BoundaryRegionInput,
    feature_index: usize,
    feature_adcode: &str,
    feature_name: &str,
    geometry_type: &str,
    polygon_index: usize,
    csv: &mut String,
) {
    let Some(rings) = polygon.as_array() else {
        return;
    };
    for (ring_index, ring) in rings.iter().enumerate() {
        if let Some(points) = ring.as_array() {
            for (point_index, point) in points.iter().enumerate() {
                if let Some((lon, lat)) = coord_pair(point) {
                    push_csv_coord_row(
                        csv,
                        region,
                        feature_index,
                        feature_adcode,
                        feature_name,
                        geometry_type,
                        polygon_index,
                        ring_index,
                        point_index,
                        lon,
                        lat,
                    );
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn append_coordinate_tree_csv_rows(
    value: &Value,
    region: &BoundaryRegionInput,
    feature_index: usize,
    feature_adcode: &str,
    feature_name: &str,
    geometry_type: &str,
    polygon_index: usize,
    ring_index: usize,
    csv: &mut String,
) {
    if let Some(points) = value.as_array() {
        if coord_pair(value).is_some() {
            return;
        }
        for (point_index, point) in points.iter().enumerate() {
            if let Some((lon, lat)) = coord_pair(point) {
                push_csv_coord_row(
                    csv,
                    region,
                    feature_index,
                    feature_adcode,
                    feature_name,
                    geometry_type,
                    polygon_index,
                    ring_index,
                    point_index,
                    lon,
                    lat,
                );
            } else {
                append_coordinate_tree_csv_rows(
                    point,
                    region,
                    feature_index,
                    feature_adcode,
                    feature_name,
                    geometry_type,
                    point_index,
                    ring_index,
                    csv,
                );
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_csv_coord_row(
    csv: &mut String,
    region: &BoundaryRegionInput,
    feature_index: usize,
    feature_adcode: &str,
    feature_name: &str,
    geometry_type: &str,
    polygon_index: usize,
    ring_index: usize,
    point_index: usize,
    lon: f64,
    lat: f64,
) {
    csv.push_str(&format!(
        "{},{},{},{},{},{},{},{},{},{},{:.8},{:.8}\n",
        csv_escape(&region.code),
        csv_escape(&region.name),
        csv_escape(&region.level),
        feature_index,
        csv_escape(feature_adcode),
        csv_escape(feature_name),
        csv_escape(geometry_type),
        polygon_index,
        ring_index,
        point_index,
        lon,
        lat,
    ));
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 清除边界缓存
#[tauri::command]
pub fn clear_boundary_cache() {
    let mut cache = BOUNDARY_CACHE.write();
    cache.clear();
    log::info!("边界缓存已清除");
}
