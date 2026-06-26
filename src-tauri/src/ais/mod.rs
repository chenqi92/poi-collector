//! 船舶 AIS 航迹模块
//! 连接 Elasticsearch（兼容老版本 5/6/7 与新版本 8），把任意 ES schema 经字段映射
//! 转成统一 AIS 模型，按船返回按时间排序的轨迹点。连接配置存于 ais_data.db。

pub mod commands;
pub mod database;
pub mod decoder;
pub mod es_client;
pub mod mapping;
pub mod types;
