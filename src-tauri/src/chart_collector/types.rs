use serde::{Deserialize, Serialize};

/// 航道图图层枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartLayer {
    /// 底图 (一张图)
    Yizhangtu,
    /// 水域 (手动)
    Cjshoudong,
    /// 水深
    Soundg,
}

impl ChartLayer {
    pub fn id(&self) -> &str {
        match self {
            ChartLayer::Yizhangtu => "yizhangtu",
            ChartLayer::Cjshoudong => "cjshoudong",
            ChartLayer::Soundg => "soundg",
        }
    }

    pub fn name(&self) -> &str {
        match self {
            ChartLayer::Yizhangtu => "底图",
            ChartLayer::Cjshoudong => "水域",
            ChartLayer::Soundg => "水深",
        }
    }

    /// 获取瓦片URL模板
    /// ArcGIS REST 格式: tile/{z}/{y}/{x}
    pub fn tile_url(&self, z: u32, y: u32, x: u32) -> String {
        match self {
            ChartLayer::Yizhangtu => format!(
                "https://api.cjienc.cn/zxtfw/server/rest/services/yizhangtu20241209/MapServer/tile/{}/{}/{}",
                z, y, x
            ),
            ChartLayer::Cjshoudong => format!(
                "https://api.cjienc.cn/zxtfw/server/rest/services/cjshoudong/MapServer/tile/{}/{}/{}",
                z, y, x
            ),
            ChartLayer::Soundg => format!(
                "https://www.cjhy.com.cn/eweb/hdt/arcgis/rest/services/soundg/MapServer/tile/{}/{}/{}",
                z, y, x
            ),
        }
    }

    /// 获取请求头（不同域名需要不同的 Referer）
    pub fn get_headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            ("User-Agent".to_string(), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string()),
            ("Accept".to_string(), "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8".to_string()),
            ("Accept-Encoding".to_string(), "gzip, deflate, br".to_string()),
            ("Accept-Language".to_string(), "zh-CN,zh;q=0.9,en;q=0.8".to_string()),
        ];

        match self {
            ChartLayer::Yizhangtu | ChartLayer::Cjshoudong => {
                headers.push((
                    "Referer".to_string(),
                    "https://www.cjhy.com.cn/eweb/".to_string(),
                ));
                headers.push(("Origin".to_string(), "https://www.cjhy.com.cn".to_string()));
            }
            ChartLayer::Soundg => {
                headers.push((
                    "Referer".to_string(),
                    "https://www.cjhy.com.cn/eweb/".to_string(),
                ));
                headers.push(("Origin".to_string(), "https://www.cjhy.com.cn".to_string()));
            }
        }

        headers
    }

    pub fn all() -> Vec<ChartLayer> {
        vec![
            ChartLayer::Yizhangtu,
            ChartLayer::Cjshoudong,
            ChartLayer::Soundg,
        ]
    }
}

impl std::fmt::Display for ChartLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.id())
    }
}

/// 航道图矩形范围
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartBounds {
    pub west: f64,  // lon_min
    pub south: f64, // lat_min
    pub east: f64,  // lon_max
    pub north: f64, // lat_max
}

impl ChartBounds {
    pub fn new(west: f64, south: f64, east: f64, north: f64) -> Self {
        Self {
            west,
            south,
            east,
            north,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.east > self.west && self.north > self.south
    }

    /// 默认范围：荆州-岳阳航段
    pub fn default_jingzhou_yueyang() -> Self {
        Self {
            west: 111.36978149414064,
            south: 29.22889003019423,
            east: 114.00650024414064,
            north: 30.37169036980603,
        }
    }
}

/// 航标信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuoyInfo {
    pub id: String,
    /// 航标名称
    pub name: Option<String>,
    /// WGS84 经度
    pub lon_84: Option<f64>,
    /// WGS84 纬度
    pub lat_84: Option<f64>,
    /// 航标类型
    pub buoy_type: Option<String>,
    /// 航标图标URL
    pub icon_url: Option<String>,
    /// 所属组织
    pub organization_id: Option<String>,
    /// 航标颜色
    pub color: Option<String>,
    /// 所属航道 (sshd)
    pub waterway: Option<String>,
    /// 航标形状 (hbxz)
    pub shape: Option<String>,
    /// 灯质信息 (dzxx)
    pub light_info: Option<String>,
    /// 所属地区（从 ID 前缀推导）
    pub region: Option<String>,
    /// 原始 JSON 数据
    pub raw_json: String,
}

/// 网格切片单元
#[derive(Debug, Clone)]
pub struct GridCell {
    pub lon1: f64,
    pub lat1: f64,
    pub lon2: f64,
    pub lat2: f64,
    pub index: usize,
}

/// 瓦片坐标（ArcGIS 格式: z/y/x）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChartTileCoord {
    pub z: u32,
    pub y: u32,
    pub x: u32,
}

impl ChartTileCoord {
    pub fn new(z: u32, y: u32, x: u32) -> Self {
        Self { z, y, x }
    }
}

/// 航道图采集任务状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartTaskStatus {
    Idle,
    CollectingBuoys,
    DownloadingTiles,
    Composing,
    Completed,
    Failed,
    Stopped,
}

/// 航道图采集进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartProgressEvent {
    pub task_type: String, // "buoy" | "tile" | "compose"
    pub status: String,
    pub current: u64,
    pub total: u64,
    pub message: Option<String>,
}

/// 航标 API 响应结构
#[derive(Debug, Clone, Deserialize)]
pub struct BuoyApiResponse {
    pub result: Option<String>,
    pub time: Option<u64>,
    #[serde(rename = "errorCode")]
    pub error_code: Option<i32>,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
    pub data: Option<serde_json::Value>,
    pub total: Option<u64>,
}

/// 瓦片估算结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartTileEstimate {
    pub total_tiles: u64,
    pub tiles_per_level: Vec<(u32, u64)>,
    pub layers_count: usize,
    pub total_with_layers: u64,
}
