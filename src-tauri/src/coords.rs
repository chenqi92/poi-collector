//! 坐标转换工具
//! 支持 GCJ02 (高德) 和 BD09 (百度) 转 WGS84

use std::f64::consts::PI;

const X_PI: f64 = PI * 3000.0 / 180.0;
const A: f64 = 6378245.0;
const EE: f64 = 0.006_693_421_622_965_943;

/// BD09 坐标转 GCJ02
pub fn bd09_to_gcj02(bd_lon: f64, bd_lat: f64) -> (f64, f64) {
    let x = bd_lon - 0.0065;
    let y = bd_lat - 0.006;
    let z = (x * x + y * y).sqrt() - 0.00002 * (y * X_PI).sin();
    let theta = y.atan2(x) - 0.000003 * (x * X_PI).cos();
    let gcj_lon = z * theta.cos();
    let gcj_lat = z * theta.sin();
    (gcj_lon, gcj_lat)
}

/// GCJ02 坐标转 WGS84
pub fn gcj02_to_wgs84(gcj_lon: f64, gcj_lat: f64) -> (f64, f64) {
    if out_of_china(gcj_lon, gcj_lat) {
        return (gcj_lon, gcj_lat);
    }

    let dlat = transform_lat(gcj_lon - 105.0, gcj_lat - 35.0);
    let dlon = transform_lon(gcj_lon - 105.0, gcj_lat - 35.0);
    let radlat = gcj_lat / 180.0 * PI;
    let magic = radlat.sin();
    let magic = 1.0 - EE * magic * magic;
    let sqrtmagic = magic.sqrt();
    let dlat = (dlat * 180.0) / ((A * (1.0 - EE)) / (magic * sqrtmagic) * PI);
    let dlon = (dlon * 180.0) / (A / sqrtmagic * radlat.cos() * PI);
    (gcj_lon - dlon, gcj_lat - dlat)
}

/// BD09 坐标转 WGS84
pub fn bd09_to_wgs84(bd_lon: f64, bd_lat: f64) -> (f64, f64) {
    let (gcj_lon, gcj_lat) = bd09_to_gcj02(bd_lon, bd_lat);
    gcj02_to_wgs84(gcj_lon, gcj_lat)
}

/// 高德 GCJ02 坐标转 WGS84 (与 gcj02_to_wgs84 相同)
pub fn amap_to_wgs84(gcj_lon: f64, gcj_lat: f64) -> (f64, f64) {
    gcj02_to_wgs84(gcj_lon, gcj_lat)
}

fn out_of_china(lon: f64, lat: f64) -> bool {
    !(72.004..=137.8347).contains(&lon) || !(0.8293..=55.8271).contains(&lat)
}

fn transform_lat(x: f64, y: f64) -> f64 {
    let mut ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * x.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (y * PI).sin() + 40.0 * (y / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (160.0 * (y / 12.0 * PI).sin() + 320.0 * (y * PI / 30.0).sin()) * 2.0 / 3.0;
    ret
}

fn transform_lon(x: f64, y: f64) -> f64 {
    let mut ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * x.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (x * PI).sin() + 40.0 * (x / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (150.0 * (x / 12.0 * PI).sin() + 300.0 * (x / 30.0 * PI).sin()) * 2.0 / 3.0;
    ret
}
