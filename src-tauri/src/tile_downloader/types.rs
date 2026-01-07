use serde::{Deserialize, Serialize};

/// 下载任务状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl ToString for TaskStatus {
    fn to_string(&self) -> String {
        match self {
            TaskStatus::Pending => "pending".to_string(),
            TaskStatus::Downloading => "downloading".to_string(),
            TaskStatus::Paused => "paused".to_string(),
            TaskStatus::Completed => "completed".to_string(),
            TaskStatus::Failed => "failed".to_string(),
            TaskStatus::Cancelled => "cancelled".to_string(),
        }
    }
}

impl From<&str> for TaskStatus {
    fn from(s: &str) -> Self {
        match s {
            "pending" => TaskStatus::Pending,
            "downloading" => TaskStatus::Downloading,
            "paused" => TaskStatus::Paused,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => TaskStatus::Pending,
        }
    }
}

/// 地图平台
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapPlatform {
    Google,
    Baidu,
    Amap,
    Tencent,
    Tianditu,
    Osm,
    ArcGis,
    Bing,
}

impl ToString for MapPlatform {
    fn to_string(&self) -> String {
        match self {
            MapPlatform::Google => "google".to_string(),
            MapPlatform::Baidu => "baidu".to_string(),
            MapPlatform::Amap => "amap".to_string(),
            MapPlatform::Tencent => "tencent".to_string(),
            MapPlatform::Tianditu => "tianditu".to_string(),
            MapPlatform::Osm => "osm".to_string(),
            MapPlatform::ArcGis => "arcgis".to_string(),
            MapPlatform::Bing => "bing".to_string(),
        }
    }
}

impl From<&str> for MapPlatform {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "google" => MapPlatform::Google,
            "baidu" => MapPlatform::Baidu,
            "amap" => MapPlatform::Amap,
            "tencent" => MapPlatform::Tencent,
            "tianditu" => MapPlatform::Tianditu,
            "osm" => MapPlatform::Osm,
            "arcgis" => MapPlatform::ArcGis,
            "bing" => MapPlatform::Bing,
            _ => MapPlatform::Osm,
        }
    }
}

/// 地图类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapType {
    Street,
    Satellite,
    Hybrid,
    Terrain,
    Roadnet,
    Annotation,
}

impl ToString for MapType {
    fn to_string(&self) -> String {
        match self {
            MapType::Street => "street".to_string(),
            MapType::Satellite => "satellite".to_string(),
            MapType::Hybrid => "hybrid".to_string(),
            MapType::Terrain => "terrain".to_string(),
            MapType::Roadnet => "roadnet".to_string(),
            MapType::Annotation => "annotation".to_string(),
        }
    }
}

impl From<&str> for MapType {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "street" => MapType::Street,
            "satellite" => MapType::Satellite,
            "hybrid" => MapType::Hybrid,
            "terrain" => MapType::Terrain,
            "roadnet" => MapType::Roadnet,
            "annotation" => MapType::Annotation,
            _ => MapType::Street,
        }
    }
}

/// 输出格式
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Folder,
    Mbtiles,
    Zip,
}

impl ToString for OutputFormat {
    fn to_string(&self) -> String {
        match self {
            OutputFormat::Folder => "folder".to_string(),
            OutputFormat::Mbtiles => "mbtiles".to_string(),
            OutputFormat::Zip => "zip".to_string(),
        }
    }
}

impl From<&str> for OutputFormat {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "folder" => OutputFormat::Folder,
            "mbtiles" => OutputFormat::Mbtiles,
            "zip" => OutputFormat::Zip,
            _ => OutputFormat::Folder,
        }
    }
}

/// 下载区域边界
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

impl Bounds {
    pub fn new(north: f64, south: f64, east: f64, west: f64) -> Self {
        Self { north, south, east, west }
    }

    /// 验证边界是否有效
    pub fn is_valid(&self) -> bool {
        self.north > self.south && self.east > self.west
            && self.north <= 85.0511 && self.south >= -85.0511
            && self.east <= 180.0 && self.west >= -180.0
    }
}

/// 下载任务配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConfig {
    pub name: String,
    pub platform: String,
    pub map_type: String,
    pub bounds: Bounds,
    pub zoom_levels: Vec<u32>,
    pub output_path: String,
    pub output_format: String,
    pub thread_count: u32,
    pub retry_count: u32,
    pub api_key: Option<String>,
}

/// 下载任务信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub map_type: String,
    pub bounds: Bounds,
    pub zoom_levels: Vec<u32>,
    pub status: String,
    pub total_tiles: u64,
    pub completed_tiles: u64,
    pub failed_tiles: u64,
    pub output_path: String,
    pub output_format: String,
    pub thread_count: u32,
    pub retry_count: u32,
    pub api_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
    pub download_speed: f64,
}

/// 瓦片进度状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TileStatus {
    Pending,
    Completed,
    Failed,
}

impl ToString for TileStatus {
    fn to_string(&self) -> String {
        match self {
            TileStatus::Pending => "pending".to_string(),
            TileStatus::Completed => "completed".to_string(),
            TileStatus::Failed => "failed".to_string(),
        }
    }
}

/// 瓦片坐标
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileCoord {
    pub z: u32,
    pub x: u32,
    pub y: u32,
}

impl TileCoord {
    pub fn new(z: u32, x: u32, y: u32) -> Self {
        Self { z, x, y }
    }
}

/// 瓦片数量估算结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileEstimate {
    pub total_tiles: u64,
    pub tiles_per_level: Vec<(u32, u64)>,
    pub estimated_size_mb: f64,
}

/// 下载进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub task_id: String,
    pub completed: u64,
    pub failed: u64,
    pub total: u64,
    pub speed: f64, // tiles per second
    pub current_zoom: u32,
    pub status: String,
    pub message: Option<String>,
}

/// 平台配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub min_zoom: u32,
    pub max_zoom: u32,
    pub map_types: Vec<String>,
    pub requires_key: bool,
}
