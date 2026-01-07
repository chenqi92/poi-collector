use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct OsmPlatform {
    api_key: Option<String>,
}

impl OsmPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

impl TilePlatform for OsmPlatform {
    fn id(&self) -> &str {
        "osm"
    }

    fn name(&self) -> &str {
        "OpenStreetMap"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);

        match map_type {
            MapType::Street => {
                Some(format!(
                    "https://{}.tile.openstreetmap.org/{}/{}/{}.png",
                    s, z, x, y
                ))
            }
            _ => None,
        }
    }

    fn max_zoom(&self) -> u32 {
        19
    }

    fn min_zoom(&self) -> u32 {
        0
    }

    fn supported_map_types(&self) -> Vec<MapType> {
        vec![MapType::Street]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn set_api_key(&mut self, key: &str) {
        self.api_key = Some(key.to_string());
    }

    fn subdomains(&self) -> Vec<&str> {
        vec!["a", "b", "c"]
    }
}
