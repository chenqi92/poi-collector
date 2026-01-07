mod collectors;
mod commands;
mod config;
mod coords;
mod database;
mod regions;
mod tile_downloader;

use commands::*;
use tile_downloader::commands as tile_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            // 导出
            get_all_poi_data,
            export_poi_to_file,
            fix_region_codes,
            // 数据管理
            get_poi_stats_by_region,
            delete_poi_by_regions,
            clear_all_poi,
            // 瓦片下载
            tile_commands::get_tile_platforms,
            tile_commands::calculate_tiles_count,
            tile_commands::create_tile_task,
            tile_commands::get_tile_tasks,
            tile_commands::get_tile_task,
            tile_commands::start_tile_download,
            tile_commands::pause_tile_download,
            tile_commands::cancel_tile_download,
            tile_commands::delete_tile_task,
            tile_commands::set_tile_thread_count,
            tile_commands::retry_failed_tiles,
            tile_commands::convert_tile_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
