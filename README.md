# GeoCollector

多源地理数据采集工具，支持 POI（兴趣点）批量采集、航标数据采集、多平台瓦片地图下载，以及数据管理与导出。

![Platform](https://img.shields.io/badge/Platform-Windows%20|%20macOS-blue)
![Tech](https://img.shields.io/badge/Built%20with-Tauri%202.x%20+%20React-orange)
![Version](https://img.shields.io/badge/Version-0.2.2-green)

## 功能特性

### 🗺️ 多平台 POI 采集
- **天地图** - 国家测绘地理信息局官方地图服务
- **高德地图** - 支持全类别 POI 搜索
- **百度地图** - 百度地图开放平台
- **OpenStreetMap** - 开源免费地图（无需 API Key）
- 支持按类别配置、暂停/继续/停止、断点续传
- 实时采集日志、进度可视化

### ⚓ 航标数据采集
- 长江航道航标数据自动采集
- 根据所选地区自动确定采集范围
- 网格步长可调（0.05°~0.5°）
- 支持航标名称、坐标、类型、航道、灯光信息等完整字段

### 🧩 瓦片地图下载
- **多平台支持** - 谷歌、百度、高德、腾讯、天地图、OSM、ArcGIS、长江航道图
- **多种地图类型** - 卫星图、街道图、地形图、混合图、航道图水域/水深图层等
- **区域选择** - 矩形框选 / 行政区域两种模式，支持行政区搜索定位
- **多级别下载** - 自定义缩放级别范围（1-20级）
- **并发控制** - 可调节下载线程数（1-32）
- **断点续传** - 暂停/继续，失败瓦片可重试
- **多种输出格式** - 文件夹（Z/X/Y）、MBTiles、ZIP
- **格式互转** - ZIP ↔ MBTiles 格式互转
- **实时进度** - 下载速度、进度百分比、预估大小

### 📍 地区管理
- 内置全国省/市/县三级行政区划数据
- 支持多选地区批量采集
- 快速搜索定位目标地区

### 🔑 API Key 管理
- 每个平台支持配置多个 API Key
- 自动轮换机制，避免单 Key 配额耗尽
- 一键跳转到各平台申请页面

### 📊 数据查询
- 关键词搜索已采集的 POI 数据
- 按平台筛选
- 精确 / 前缀 / 包含三种匹配模式
- 列表 / 地图 / 分屏三种视图模式

### 📤 数据导出
- **POI 数据导出**
  - Excel (.xlsx)、JSON、MySQL (.sql) 格式
  - 按地区树筛选导出范围
  - 导出前数据预览
- **航标数据导出**
  - JSON、CSV 格式
  - 按地区筛选
  - 完整字段导出（名称、坐标、类型、航道、灯光信息等）

### 🎨 界面特性
- 现代化 UI 设计（shadcn/ui）
- 亮色 / 暗色 / 跟随系统主题切换
- 采集页面左右分栏、可拖动日志面板
- 仪表盘数据概览

## 下载

从 [Releases](../../releases) 页面下载：

| 平台 | 文件 |
|------|------|
| Windows | `.msi` 或 `.exe` |
| macOS Intel | `*x64*.dmg` |
| macOS Apple Silicon | `*aarch64*.dmg` |

## 快速开始

1. 下载并安装应用
2. 打开设置（左下角 ⚙️）→ API Key → 添加各平台 Key
3. 设置 → 地区管理 → 选择采集地区
4. 进入 **数据采集** 页面 → 配置类别 → 开始采集
5. 使用 **数据导出** 页面按地区筛选并导出数据
6. 使用 **瓦片下载** 页面下载离线地图瓦片

## 技术栈

- **框架**: Tauri 2.x（Rust + WebView）
- **前端**: React 18 + TypeScript + Vite
- **UI**: shadcn/ui + Tailwind CSS
- **数据库**: SQLite（POI + 瓦片任务 + 航标数据）
- **地图**: Leaflet + react-leaflet
- **HTTP**: reqwest（Rust 端并发下载）

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建 Release
npm run tauri build
```

## License

MIT
