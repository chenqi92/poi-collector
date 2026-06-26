//! AIS 模块的数据类型。前端经 tauri 用 camelCase 访问，这里统一 rename_all = "camelCase"。

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_scheme() -> String {
    "http".to_string()
}
fn default_port() -> u16 {
    9200
}
fn default_auth() -> String {
    "none".to_string()
}
fn default_crs() -> String {
    "wgs84".to_string()
}
fn default_ts_format() -> String {
    "epoch_ms".to_string()
}
fn default_data_mode() -> String {
    "fields".to_string()
}

/// ES 字段 → 统一 AIS 字段的映射。所有字段值都支持点路径（如 `position.lat`）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    /// 船舶标识字段（MMSI / 船号）
    #[serde(default)]
    pub mmsi: String,
    /// 用于聚合 / 精确过滤的可聚合字段（如 `mmsi.keyword`）。为空时回退到 mmsi。
    #[serde(default)]
    pub agg_field: String,
    /// raw 模式：原始 AIVDM 报文字段（后端解码出 MMSI/经纬度/航速等）
    #[serde(default)]
    pub message: String,
    /// 船名字段（可选）
    #[serde(default)]
    pub name: String,
    /// 纬度字段（与 lon 配对使用）
    #[serde(default)]
    pub lat: String,
    /// 经度字段
    #[serde(default)]
    pub lon: String,
    /// 单个 geo_point 字段（可选，优先于 lat/lon）。支持 {lat,lon} / [lon,lat] / "lat,lon"。
    #[serde(default)]
    pub geo_point: String,
    /// 时间戳字段
    #[serde(default)]
    pub timestamp: String,
    /// 时间戳格式：epoch_ms | epoch_s | iso
    #[serde(default = "default_ts_format")]
    pub timestamp_format: String,
    /// 对地速度 SOG（节，可选）
    #[serde(default)]
    pub sog: String,
    /// 对地航向 COG（度，可选）
    #[serde(default)]
    pub cog: String,
    /// 船首向（度，可选）
    #[serde(default)]
    pub heading: String,
    /// 导航状态字段（可选）
    #[serde(default)]
    pub nav_status: String,
    /// 视为"停泊/锚泊"的导航状态取值集合（如 ["1","5"]）
    #[serde(default)]
    pub nav_status_anchored: Vec<String>,
}

/// 一个 ES 连接配置（含字段映射与默认轨迹参数）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsConnection {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_scheme")]
    pub scheme: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub index: String,
    /// none | basic | apikey
    #[serde(default = "default_auth")]
    pub auth_type: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub accept_invalid_certs: bool,
    /// 源坐标系：wgs84 | gcj02 | bd09（用于把入库点归一化到 WGS-84）
    #[serde(default = "default_crs")]
    pub source_crs: String,
    /// 数据模式：fields（结构化字段映射）| raw（原始 AIVDM 报文，需解码）
    #[serde(default = "default_data_mode")]
    pub data_mode: String,
    #[serde(default)]
    pub field_mapping: FieldMapping,
    /// 轨迹参数透传（前端解释），后端不使用
    #[serde(default)]
    pub trajectory_params: Value,
}

/// 一条统一后的 AIS 点（坐标为 WGS-84，时间为 epoch 毫秒）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AisPoint {
    pub mmsi: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sog: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cog: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav_status: Option<String>,
}

/// 船只列表项（聚合结果）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipSummary {
    pub mmsi: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_ts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ts: Option<i64>,
}

/// 测试连接结果（含探测到的版本与采样字段路径，用于驱动映射 UI）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsTestResult {
    pub ok: bool,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_count: Option<u64>,
    pub field_paths: Vec<String>,
    pub sample: Value,
    pub message: String,
}

/// ES 索引列表项（来自 _cat/indices）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_count: Option<u64>,
}

/// 单船航迹查询结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResponse {
    pub mmsi: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub points: Vec<AisPoint>,
    pub total: u64,
    /// 命中数超过返回上限时为 true（提示前端缩小时间范围）
    pub truncated: bool,
}

/// raw 模式拉取并解码一个时间窗的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub points: Vec<AisPoint>,
    /// 扫描的报文条数
    pub scanned: u64,
    /// 成功解码出的船位点数
    pub decoded: u64,
    /// 不同船只数（distinct MMSI）
    pub ships: u64,
    /// 是否达到上限被截断
    pub truncated: bool,
}
