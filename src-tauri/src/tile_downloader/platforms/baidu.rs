use super::TilePlatform;
use crate::tile_downloader::types::MapType;

pub struct BaiduPlatform {
    api_key: Option<String>,
}

impl BaiduPlatform {
    pub fn new() -> Self {
        Self { api_key: None }
    }

    /// 将标准 WGS84/GCJ02 坐标的瓦片坐标转换为百度坐标系
    /// 百度瓦片坐标系原点在经度0纬度0，X从左向右，Y从下向上
    fn convert_tile_coord(&self, z: u32, x: u32, y: u32) -> (i32, i32) {
        // 百度地图的瓦片坐标系统与标准XYZ不同
        // 标准XYZ：原点在左上角，Y向下增加
        // 百度：原点在中心(经度0,纬度0)，X向右增加，Y向上增加

        let tile_count = 1u32 << z;
        let center = tile_count / 2;

        let bx = x as i32 - center as i32;
        let by = center as i32 - 1 - y as i32;

        (bx, by)
    }
}

impl TilePlatform for BaiduPlatform {
    fn id(&self) -> &str {
        "baidu"
    }

    fn name(&self) -> &str {
        "百度地图"
    }

    fn get_tile_url(&self, z: u32, x: u32, y: u32, map_type: &MapType) -> Option<String> {
        let s = self.get_subdomain(x, y);
        let (bx, by) = self.convert_tile_coord(z, x, y);

        match map_type {
            MapType::Street => {
                Some(format!(
                    "http://online{}.map.bdimg.com/onlinelabel/?qt=tile&x={}&y={}&z={}&styles=pl&udt=20200101&scaler=1&p=1",
                    s, bx, by, z
                ))
            }
            MapType::Satellite => {
                Some(format!(
                    "http://shangetu{}.map.bdimg.com/it/u=x={};y={};z={};v=009;type=sate&fm=46",
                    s, bx, by, z
                ))
            }
            MapType::Roadnet => {
                Some(format!(
                    "http://online{}.map.bdimg.com/tile/?qt=tile&x={}&y={}&z={}&styles=sl",
                    s, bx, by, z
                ))
            }
            _ => None,
        }
    }

    fn max_zoom(&self) -> u32 {
        19
    }

    fn min_zoom(&self) -> u32 {
        3
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
        vec!["0", "1", "2", "3"]
    }
}
