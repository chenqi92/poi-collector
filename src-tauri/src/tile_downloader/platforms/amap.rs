use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct AmapPlatform {
    api_key: Option<String>,
}

impl AmapPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

impl TilePlatform for AmapPlatform {
    fn id(&self) -> &str {
        "amap"
    }

    fn name(&self) -> &str {
        "高德地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);

        match map_type {
            MapType::Street => {
                Some(format!(
                    "http://webrd0{}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={}&y={}&z={}",
                    s, x, y, z
                ))
            }
            MapType::Satellite => {
                Some(format!(
                    "http://webst0{}.is.autonavi.com/appmaptile?style=6&x={}&y={}&z={}",
                    s, x, y, z
                ))
            }
            MapType::Roadnet => {
                Some(format!(
                    "http://webst0{}.is.autonavi.com/appmaptile?style=8&x={}&y={}&z={}",
                    s, x, y, z
                ))
            }
            _ => None,
        }
    }

    fn max_zoom(&self) -> u32 {
        18
    }

    fn min_zoom(&self) -> u32 {
        1
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        vec![MapType::Street, MapType::Satellite, MapType::Roadnet]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn set_api_key(&mut self, key: &str) {
        self.api_key = Some(key.to_string());
    }

    fn subdomains(&self) -> Vec<&str> {
        vec!["1", "2", "3", "4"]
    }
}
