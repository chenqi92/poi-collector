mod google;
mod baidu;
mod amap;
mod tencent;
mod tianditu;
mod osm;
mod arcgis;
mod bing;

pub use google::GooglePlatform;
pub use baidu::BaiduPlatform;
pub use amap::AmapPlatform;
pub use tencent::TencentPlatform;
pub use tianditu::TiandituPlatform;
pub use osm::OsmPlatform;
pub use arcgis::ArcGisPlatform;
pub use bing::BingPlatform;

use super::types::{MapType, PlatformInfo};
use std::collections::HashMap;

/// 瓦片平台 trait
pub trait TilePlatform: Send + Sync {
    /// 平台标识
    fn id(&self) -> &str;

    /// 平台名称
    fn name(&self) -> &str;

    /// 获取瓦片URL
    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String>;

    /// 最大层级
    fn max_zoom(&self) -> u32;

    /// 最小层级
    fn min_zoom(&self) -> u32;

    /// 支持的地图类型
    fn supported_map_types(&self) -> Vec<MapType>;

    /// 是否需要API Key
    fn requires_api_key(&self) -> bool;

    /// 设置API Key
    fn set_api_key(&mut self, key: &str);

    /// 获取请求头
    fn get_headers(&self) -> HashMap<String, String> {
        let mut headers = HashMap::new();
        headers.insert(
            "User-Agent".to_string(),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36".to_string(),
        );
        headers
    }

    /// 获取子域名
    fn get_subdomain(&self, x: u32, y: u32) -> String {
        let subdomains = self.subdomains();
        if subdomains.is_empty() {
            return String::new();
        }
        let index = ((x + y) as usize) % subdomains.len();
        subdomains[index].to_string()
    }

    /// 子域名列表
    fn subdomains(&self) -> Vec<&str> {
        vec![]
    }

    /// 获取平台信息
    fn info(&self) -> PlatformInfo {
        PlatformInfo {
            id: self.id().to_string(),
            name: self.name().to_string(),
            enabled: true,
            min_zoom: self.min_zoom(),
            max_zoom: self.max_zoom(),
            map_types: self.supported_map_types().iter().map(|t| t.to_string()).collect(),
            requires_key: self.requires_api_key(),
        }
    }
}

/// 创建平台实例
pub fn create_platform(platform: &str, api_key: Option<&str>) -> Box<dyn TilePlatform> {
    let mut p: Box<dyn TilePlatform> = match platform.to_lowercase().as_str() {
        "google" => Box::new(GooglePlatform::new()),
        "baidu" => Box::new(BaiduPlatform::new()),
        "amap" => Box::new(AmapPlatform::new()),
        "tencent" => Box::new(TencentPlatform::new()),
        "tianditu" => Box::new(TiandituPlatform::new()),
        "osm" => Box::new(OsmPlatform::new()),
        "arcgis" => Box::new(ArcGisPlatform::new()),
        "bing" => Box::new(BingPlatform::new()),
        _ => Box::new(OsmPlatform::new()),
    };

    if let Some(key) = api_key {
        p.set_api_key(key);
    }

    p
}

/// 获取所有平台信息
pub fn get_all_platforms() -> Vec<PlatformInfo> {
    vec![
        GooglePlatform::new().info(),
        BaiduPlatform::new().info(),
        AmapPlatform::new().info(),
        TencentPlatform::new().info(),
        TiandituPlatform::new().info(),
        OsmPlatform::new().info(),
        ArcGisPlatform::new().info(),
        BingPlatform::new().info(),
    ]
}
