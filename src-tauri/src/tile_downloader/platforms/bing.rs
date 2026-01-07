use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct BingPlatform {
    api_key: Option<String>,
}

impl BingPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }

    /// 将XYZ坐标转换为Bing的QuadKey
    fn tile_to_quadkey(&self, z: u32, x: u32, y: u32) -> String {
        let mut quadkey = String::with_capacity(z as usize);
        for i in (1..=z).rev() {
            let mut digit = 0u8;
            let mask = 1u32 << (i - 1);
            if (x & mask) != 0 {
                digit += 1;
            }
            if (y & mask) != 0 {
                digit += 2;
            }
            quadkey.push((b'0' + digit) as char);
        }
        quadkey
    }
}

impl TilePlatform for BingPlatform {
    fn id(&self) -> &str {
        "bing"
    }

    fn name(&self) -> &str {
        "Bing地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);
        let quadkey = self.tile_to_quadkey(z, x, y);

        let (url_type, suffix) = match map_type {
            MapType::Street => ("r", "png"),      // 街道图
            MapType::Satellite => ("a", "jpeg"),   // 卫星图
            MapType::Hybrid => ("h", "jpeg"),      // 混合图
            _ => return None,
        };

        Some(format!(
            "http://ecn.t{}.tiles.virtualearth.net/tiles/{}{}.{}?g=587",
            s, url_type, quadkey, suffix
        ))
    }

    fn max_zoom(&self) -> u32 {
        19
    }

    fn min_zoom(&self) -> u32 {
        1
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        vec![MapType::Street, MapType::Satellite, MapType::Hybrid]
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
