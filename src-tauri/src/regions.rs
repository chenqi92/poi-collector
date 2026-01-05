//! 行政区划数据模块
//! 
//! 从内置 JSON 文件加载省市区数据，支持按层级查询

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Region {
    pub code: String,
    pub name: String,
    pub level: String, // province, city, district
    #[serde(rename = "parentCode")]
    pub parent_code: Option<String>,
}

/// 所有行政区划数据（首次访问时加载）
static REGIONS: OnceLock<Vec<Region>> = OnceLock::new();

/// 按 code 索引的映射
static REGIONS_BY_CODE: OnceLock<HashMap<String, Region>> = OnceLock::new();

/// 按 parent_code 分组的子区划
static CHILDREN_BY_PARENT: OnceLock<HashMap<String, Vec<Region>>> = OnceLock::new();

/// 加载内置行政区划数据
fn load_regions() -> Vec<Region> {
    let json_data = include_str!("../resources/regions.json");
    serde_json::from_str(json_data).unwrap_or_else(|e| {
        log::error!("Failed to parse regions.json: {}", e);
        vec![]
    })
}

/// 获取所有行政区划
pub fn get_all_regions() -> &'static Vec<Region> {
    REGIONS.get_or_init(load_regions)
}

/// 按代码获取区划
pub fn get_region_by_code(code: &str) -> Option<Region> {
    let map = REGIONS_BY_CODE.get_or_init(|| {
        get_all_regions()
            .iter()
            .map(|r| (r.code.clone(), r.clone()))
            .collect()
    });
    map.get(code).cloned()
}

/// 获取某个区划的子区划
pub fn get_children(parent_code: &str) -> Vec<Region> {
    let map = CHILDREN_BY_PARENT.get_or_init(|| {
        let mut result: HashMap<String, Vec<Region>> = HashMap::new();
        for r in get_all_regions() {
            if let Some(parent) = &r.parent_code {
                result.entry(parent.clone()).or_default().push(r.clone());
            }
        }
        result
    });
    map.get(parent_code).cloned().unwrap_or_default()
}

/// 获取所有省份
pub fn get_provinces() -> Vec<Region> {
    get_all_regions()
        .iter()
        .filter(|r| r.level == "province")
        .cloned()
        .collect()
}

/// 获取所有城市
pub fn get_cities() -> Vec<Region> {
    get_all_regions()
        .iter()
        .filter(|r| r.level == "city")
        .cloned()
        .collect()
}

/// 获取所有区县
pub fn get_districts() -> Vec<Region> {
    get_all_regions()
        .iter()
        .filter(|r| r.level == "district")
        .cloned()
        .collect()
}

/// 获取某个区划的所有下属区县代码（递归）
/// 用于查询某省/市时自动聚合下属县的数据
pub fn get_all_district_codes(code: &str) -> Vec<String> {
    let region = match get_region_by_code(code) {
        Some(r) => r,
        None => return vec![],
    };
    
    match region.level.as_str() {
        "district" => vec![code.to_string()],
        "city" => {
            get_children(code)
                .iter()
                .filter(|r| r.level == "district")
                .map(|r| r.code.clone())
                .collect()
        }
        "province" => {
            let mut result = vec![];
            for city in get_children(code) {
                if city.level == "city" {
                    for district in get_children(&city.code) {
                        if district.level == "district" {
                            result.push(district.code.clone());
                        }
                    }
                }
            }
            result
        }
        _ => vec![],
    }
}

/// 按名称模糊搜索区划
pub fn search_regions(query: &str) -> Vec<Region> {
    get_all_regions()
        .iter()
        .filter(|r| r.name.contains(query))
        .take(50)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_load_regions() {
        let regions = get_all_regions();
        assert!(!regions.is_empty());
        println!("Loaded {} regions", regions.len());
    }
    
    #[test]
    fn test_get_provinces() {
        let provinces = get_provinces();
        assert!(!provinces.is_empty());
        println!("Found {} provinces", provinces.len());
    }
}
