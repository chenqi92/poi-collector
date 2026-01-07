use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct TiandituPlatform {
    api_key: Option<String>,
}

impl TiandituPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

impl TilePlatform for TiandituPlatform {
    fn id(&self) -> &str {
        "tianditu"
    }

    fn name(&self) -> &str {
        "天地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let key = self.api_key.as_deref()?;
        let s = self.get_subdomain(x, y);

        let (layer, style) = match map_type {
            MapType::Street => ("vec", "default"),     // 矢量底图
            MapType::Satellite => ("img", "default"),  // 影像底图
            MapType::Terrain => ("ter", "default"),    // 地形底图
            MapType::Annotation => ("cva", "default"), // 矢量注记
            _ => return None,
        };

        Some(format!(
            "http://t{}.tianditu.gov.cn/{}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={}&STYLE={}&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={}&TILEROW={}&TILEMATRIX={}&tk={}",
            s, layer, layer, style, x, y, z, key
        ))
    }

    fn max_zoom(&self) -> u32 {
        18
    }

    fn min_zoom(&self) -> u32 {
        1
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        vec![MapType::Street, MapType::Satellite, MapType::Terrain, MapType::Annotation]
    }

    fn requires_api_key(&self) -> bool {
        true
    }

    fn set_api_key(&mut self, key: &str) {
        self.api_key = Some(key.to_string());
    }

    fn subdomains(&self) -> Vec<&str> {
        vec!["0", "1", "2", "3", "4", "5", "6", "7"]
    }
}
