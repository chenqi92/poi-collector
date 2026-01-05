// Baidu (百度) POI Collector
// TODO: Implement actual collection logic

pub struct BaiduCollector {
    api_key: String,
}

impl BaiduCollector {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}
