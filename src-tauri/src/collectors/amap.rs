// Amap (高德) POI Collector
// TODO: Implement actual collection logic

pub struct AmapCollector {
    api_key: String,
}

impl AmapCollector {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}
