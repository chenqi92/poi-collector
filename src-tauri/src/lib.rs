mod commands;
mod database;
mod config;
mod collectors;
mod regions;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // Stats
            get_stats,
            // Region (legacy)
            get_region_config,
            get_region_presets,
            set_region_by_preset,
            // API Keys
            get_api_keys,
            add_api_key,
            delete_api_key,
            // Collector
            get_categories,
            get_collector_statuses,
            start_collector,
            stop_collector,
            reset_collector,
            // Search
            search_poi,
            // 行政区划
            get_regions,
            get_provinces,
            get_region_children,
            search_regions,
            get_district_codes_for_region,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
