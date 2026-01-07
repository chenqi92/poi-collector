use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct TencentPlatform {
    api_key: Option<String>,
}

impl TencentPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }

    /// 腾讯地图Y坐标需要翻转
    fn flip_y(&self, z: u32, y: u32) -> u32 {
        (1u32 << z) - 1 - y
    }
}

impl TilePlatform for TencentPlatform {
    fn id(&self) -> &str {
        "tencent"
    }

    fn name(&self) -> &str {
        "腾讯地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);
        let flipped_y = self.flip_y(z, y);

        match map_type {
            MapType::Street => {
                Some(format!(
                    "http://rt{}.map.gtimg.com/realtimerender?z={}&x={}&y={}&type=vector&style=0",
                    s, z, x, flipped_y
                ))
            }
            MapType::Satellite => {
                // 腾讯卫星图需要分块
                let sx = x >> 4;
                let sy = flipped_y >> 4;
                Some(format!(
                    "http://p{}.map.gtimg.com/sateTiles/{}/{}/{}/{}_{}.jpg",
                    s, z, sx, sy, x, flipped_y
                ))
            }
            MapType::Terrain => {
                Some(format!(
                    "http://rt{}.map.gtimg.com/realtimerender?z={}&x={}&y={}&type=vector&style=4",
                    s, z, x, flipped_y
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
        vec![MapType::Street, MapType::Satellite, MapType::Terrain]
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
