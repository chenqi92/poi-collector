// Collectors module - placeholder for POI collection logic
// TODO: Implement actual collectors for TianDiTu, Amap, Baidu

pub mod tianditu;
pub mod amap;
pub mod baidu;

pub use tianditu::TianDiTuCollector;
pub use amap::AmapCollector;
pub use baidu::BaiduCollector;
