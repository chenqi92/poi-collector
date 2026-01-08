use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct GooglePlatform {
    api_key: Option<String>,
}

impl GooglePlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

impl TilePlatform for GooglePlatform {
    fn id(&self) -> &str {
        "google"
    }

    fn name(&self) -> &str {
        "谷歌地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);

        let lyrs = match map_type {
            MapType::Street => "m",    // 街道图
            MapType::Satellite => "s", // 卫星图
            MapType::Hybrid => "y",    // 混合图
            MapType::Terrain => "t",   // 地形图
            _ => return None,
        };

        Some(format!(
            "https://mt{}.google.com/vt/lyrs={}&x={}&y={}&z={}",
            s, lyrs, x, y, z
        ))
    }

    fn max_zoom(&self) -> u32 {
        21
    }

    fn min_zoom(&self) -> u32 {
        0
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        vec![
            MapType::Street,
            MapType::Satellite,
            MapType::Hybrid,
            MapType::Terrain,
        ]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn set_api_key(&mut self, key: &str) {
        self.api_key = Some(key.to_string());
    }

    fn subdomains(&self) -> Vec<&str> {
        vec!["0", "1", "2", "3"]
    }
}
