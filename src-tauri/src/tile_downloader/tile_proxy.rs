use super::platforms::create_platform;
use super::types::MapType;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
});

#[derive(Debug, Deserialize)]
pub struct TileRequest {
    pub platform: String,
    pub map_type: String,
    pub z: u32,
    pub x: u32,
    pub y: u32,
    pub api_key: Option<String>,
}

/// 代理瓦片请求，避免浏览器 CORS 限制
#[tauri::command]
pub async fn proxy_tile_request(request: TileRequest) -> Result<Vec<u8>, String> {
    let platform = create_platform(&request.platform, request.api_key.as_deref());
    let map_type = MapType::from(request.map_type.as_str());

    let url = platform
        .get_tile_url(request.z, request.x, request.y, &map_type)
        .ok_or("此平台不支持该地图类型")?;

    let headers = platform.get_headers();

    let mut req = HTTP_CLIENT.get(&url);
    for (key, value) in headers {
        req = req.header(&key, &value);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP 错误: {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    Ok(bytes.to_vec())
}
