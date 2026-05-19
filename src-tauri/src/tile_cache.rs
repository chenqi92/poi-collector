//! Simple on-disk cache for public-OSM tiles served to the frontend Leaflet
//! layers.  Each tile is stored as a plain PNG under:
//!
//!     <app_data_dir>/tile_cache/osm/{z}/{x}/{y}.png
//!
//! The frontend asks for tiles via `cached_osm_tile`; the command returns
//! base64-encoded PNG bytes so React can stuff them directly into an
//! `<img src="data:image/png;base64,...">` element.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::fs;

const OSM_USER_AGENT: &str =
    "GeoCollector/0.2 (https://github.com/anthropics/claude-code; desktop tile cache)";

/// Build the on-disk path for a single tile.
fn tile_path(app: &AppHandle, z: u32, x: u32, y: u32) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {}", e))?;
    Ok(base
        .join("tile_cache")
        .join("osm")
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{}.png", y)))
}

/// Best-effort directory cleanup of cached tiles.  Returns the path that was
/// removed (or empty if no cache existed).
#[tauri::command]
pub async fn clear_osm_tile_cache(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {}", e))?
        .join("tile_cache")
        .join("osm");
    if !base.exists() {
        return Ok(String::new());
    }
    fs::remove_dir_all(&base)
        .await
        .map_err(|e| format!("清理失败: {}", e))?;
    Ok(base.display().to_string())
}

/// Read a tile from disk, fetching from OSM if missing.  Returns
/// base64-encoded PNG bytes (empty string on hard failure so the frontend
/// can render a transparent tile instead of throwing).
#[tauri::command]
pub async fn cached_osm_tile(
    app: AppHandle,
    z: u32,
    x: u32,
    y: u32,
) -> Result<String, String> {
    // Reasonable zoom guard.
    if z > 19 {
        return Ok(String::new());
    }
    let path = tile_path(&app, z, x, y)?;

    // Cache hit.
    if let Ok(bytes) = fs::read(&path).await {
        if !bytes.is_empty() {
            return Ok(BASE64.encode(&bytes));
        }
    }

    // Cache miss → fetch.  OSM's usage policy asks for an honest UA.
    let url = format!(
        "https://tile.openstreetmap.org/{}/{}/{}.png",
        z, x, y
    );
    let client = match reqwest::Client::builder()
        .user_agent(OSM_USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("构建 HTTP client 失败: {}", e)),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("下载瓦片失败: {}", e)),
    };
    if !resp.status().is_success() {
        return Err(format!("瓦片返回 {}: {}", resp.status(), url));
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return Err(format!("读取响应失败: {}", e)),
    };

    // Persist to disk — best effort; even if write fails we still return bytes.
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent).await {
            eprintln!("tile_cache mkdir failed for {:?}: {}", parent, e);
        }
    }
    if let Err(e) = fs::write(&path, &bytes).await {
        eprintln!("tile_cache write failed for {:?}: {}", path, e);
    }

    Ok(BASE64.encode(&bytes))
}
