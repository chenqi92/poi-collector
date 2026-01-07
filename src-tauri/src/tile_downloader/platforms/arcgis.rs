use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct ArcGisPlatform {
    api_key: Option<String>,
}

impl ArcGisPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

impl TilePlatform for ArcGisPlatform {
    fn id(&self) -> &str {
        "arcgis"
    }

    fn name(&self) -> &str {
        "ArcGIS"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let service = match map_type {
            MapType::Street => "World_Street_Map",
            MapType::Satellite => "World_Imagery",
            MapType::Terrain => "World_Topo_Map",
            _ => return None,
        };

        Some(format!(
            "https://server.arcgisonline.com/ArcGIS/rest/services/{}/MapServer/tile/{}/{}/{}",
            service, z, y, x
        ))
    }

    fn max_zoom(&self) -> u32 {
        19
    }

    fn min_zoom(&self) -> u32 {
        0
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
}
