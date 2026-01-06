//! 多平台 POI 采集器模块
//!
//! 支持天地图、高德地图、百度地图

pub mod tianditu;
pub mod amap;
pub mod baidu;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use tianditu::TianDiTuCollector;
pub use amap::AmapCollector;
pub use baidu::BaiduCollector;

/// POI 类别定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub keywords: Vec<String>,
}

/// 采集进度
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CollectorProgress {
    pub platform: String,
    pub status: String,           // idle, running, paused, completed, error
    pub total_collected: i64,
    pub current_category_id: String,
    pub current_keyword_index: usize,
    pub current_page: usize,
    pub completed_categories: Vec<String>,
    pub error_message: Option<String>,
}

/// 区域边界
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bounds {
    pub min_lon: f64,
    pub max_lon: f64,
    pub min_lat: f64,
    pub max_lat: f64,
}

/// 区域配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionConfig {
    pub name: String,
    pub admin_code: String,
    pub city_code: String,
    pub bounds: Bounds,
}

/// POI 数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct POIData {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub original_lon: f64,
    pub original_lat: f64,
    pub category: String,
    pub category_id: String,
    pub address: String,
    pub phone: String,
    pub platform: String,
    pub raw_data: String,
}

/// 采集器 trait
pub trait Collector: Send + Sync {
    /// 平台名称
    fn platform(&self) -> &'static str;

    /// 设置 API Key
    fn set_api_key(&mut self, key: String);

    /// 设置区域配置
    fn set_region(&mut self, region: RegionConfig);

    /// 搜索 POI
    /// 返回 (POI 列表, 是否还有更多)
    fn search_poi(
        &self,
        keyword: &str,
        page: usize,
        category_name: &str,
        category_id: &str,
    ) -> Result<(Vec<POIData>, bool), String>;

    /// 检查是否是配额错误
    fn is_quota_error(&self, response: &serde_json::Value) -> bool;
}

/// 默认 POI 类别
pub fn default_categories() -> Vec<Category> {
    vec![
        Category {
            id: "residential".into(),
            name: "住宅小区".into(),
            keywords: vec!["小区", "花园", "家园", "公寓", "名苑", "雅苑", "新村", "嘉园", "华府", "名邸"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "commercial".into(),
            name: "商业楼盘".into(),
            keywords: vec!["广场", "中心", "大厦", "商厦", "写字楼", "商城", "购物中心"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "school".into(),
            name: "学校".into(),
            keywords: vec!["学校", "小学", "中学", "高中", "大学", "学院", "幼儿园", "实验学校"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "hospital".into(),
            name: "医疗".into(),
            keywords: vec!["医院", "诊所", "卫生院", "社区卫生", "药店", "卫生室", "门诊"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "government".into(),
            name: "政府".into(),
            keywords: vec!["政府", "派出所", "公安局", "法院", "街道办", "村委会", "居委会"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "transport".into(),
            name: "交通".into(),
            keywords: vec!["汽车站", "火车站", "公交站", "停车场", "加油站", "高速出口"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "business".into(),
            name: "商业服务".into(),
            keywords: vec!["超市", "商场", "市场", "银行", "酒店", "宾馆", "餐厅", "饭店"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "entertainment".into(),
            name: "休闲娱乐".into(),
            keywords: vec!["电影院", "KTV", "游乐场", "健身房", "网吧", "咖啡厅"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "nature".into(),
            name: "自然地貌".into(),
            keywords: vec!["湖", "河", "公园", "景区", "森林", "湿地", "水库"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "admin".into(),
            name: "行政区划".into(),
            keywords: vec!["镇", "乡", "村", "社区", "街道", "开发区"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "landmark".into(),
            name: "地标建筑".into(),
            keywords: vec!["塔", "桥", "广场", "体育馆", "图书馆", "文化馆", "博物馆"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "industrial".into(),
            name: "工业园区".into(),
            keywords: vec!["工业园", "产业园", "开发区", "厂区", "仓库", "物流园"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "agriculture".into(),
            name: "农业设施".into(),
            keywords: vec!["农场", "果园", "大棚", "养殖场", "农业基地", "合作社"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "municipal".into(),
            name: "市政设施".into(),
            keywords: vec!["变电站", "水厂", "污水处理", "垃圾站", "消防站"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "public_service".into(),
            name: "公共服务".into(),
            keywords: vec!["社区服务中心", "便民中心", "邮局", "快递站"]
                .into_iter().map(String::from).collect(),
        },
        Category {
            id: "religious".into(),
            name: "宗教场所".into(),
            keywords: vec!["寺庙", "教堂", "道观", "祠堂"]
                .into_iter().map(String::from).collect(),
        },
    ]
}
