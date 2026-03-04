use super::TilePlatform;
use crate::tile_downloader::types::MapType;
use std::collections::HashMap;

/// 长江航道图平台
/// 使用 ArcGIS REST 瓦片服务，WGS84 (4326) 切片方案
pub struct CjhyPlatform;

impl CjhyPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl TilePlatform for CjhyPlatform {
    fn id(&self) -> &str {
        "cjhy"
    }

    fn name(&self) -> &str {
        "长江航道图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let service = match map_type {
            MapType::Street => "yizhangtu20241209", // 底图
            MapType::Satellite => "cjshoudong",     // 水域
            MapType::Terrain => "soundg",           // 水深
            _ => return None,
        };

        // 底图和水域用 api.cjienc.cn，水深用 www.cjhy.com.cn
        let base_url = match map_type {
            MapType::Terrain => format!(
                "https://www.cjhy.com.cn/eweb/hdt/arcgis/rest/services/{}/MapServer/tile/{}/{}/{}",
                service, z, y, x
            ),
            _ => format!(
                "https://api.cjienc.cn/zxtfw/server/rest/services/{}/MapServer/tile/{}/{}/{}",
                service, z, y, x
            ),
        };

        Some(base_url)
    }

    fn max_zoom(&self) -> u32 {
        13
    }

    fn min_zoom(&self) -> u32 {
        0
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        // street=底图, satellite=水域, terrain=水深
        vec![MapType::Street, MapType::Satellite, MapType::Terrain]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn set_api_key(&mut self, _key: &str) {}

    fn get_headers(&self) -> HashMap<String, String> {
        let mut headers = HashMap::new();
        headers.insert(
            "User-Agent".to_string(),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string(),
        );
        headers.insert(
            "Referer".to_string(),
            "https://www.cjhy.com.cn/eweb/".to_string(),
        );
        headers.insert("Origin".to_string(), "https://www.cjhy.com.cn".to_string());
        headers
    }

    /// 航道图使用 ArcGIS 4326 切片方案，而非 Web Mercator
    fn uses_custom_4326_scheme(&self) -> bool {
        true
    }
}
