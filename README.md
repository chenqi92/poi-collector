# POI Collector 🗺️

多平台POI数据采集与查询系统，支持天地图、高德地图、百度地图，可用于无人机导航、地理信息系统等场景。针对公司不肯花钱用在线api并且需要可以搜索到小区、街道等osm无法检索到的场景。

## ✨ 特性

- **多平台支持** - 同时采集天地图(先支持)、高德、百度三大地图平台的POI数据
- **多Key轮换** - 支持配置多个API Key，自动轮换避免配额限制
- **动态区域配置** - 支持预设区域和自定义区域，灵活配置采集范围
- **断点续传** - 采集中断后可从断点继续，不丢失进度
- **实时日志** - SSE推送采集进度，实时查看采集状态
- **智能搜索** - 支持精确、前缀、模糊等多种匹配模式
- **坐标统一** - 自动将各平台坐标转换为WGS84标准坐标
- **Web管理** - Web界面管理，支持数据采集、查询、平台对比

## 📦 安装

```bash
# 克隆项目
git clone https://github.com/chenqi92/poi-collector.git
cd poi-collector

# 安装依赖
pip install -r requirements.txt
```

## 🚀 快速开始

```bash
# 启动Web服务
python web_server.py

# 或使用启动脚本
./start.bat  # Windows
```

访问 http://localhost:5000 打开管理界面。

## ⚙️ 配置

### 1. 配置API Key

在Web界面 **API Key设置** 页面配置各平台的API Key：
- [天地图开发者平台](https://console.tianditu.gov.cn/)
- [高德开放平台](https://console.amap.com/)
- [百度地图开放平台](https://lbsyun.baidu.com/)

![配置key](https://nas.allbs.cn:8888/cloudpic/2026/01/176f26834a40983e524acc4c699d4446.png)

### 2. 配置采集区域

在 **API Key设置** 页面的 **采集区域配置** 中选择预设区域或自定义区域。

![采集范围](https://nas.allbs.cn:8888/cloudpic/2026/01/ef53feb1f4850d076f859b03a48bf287.png)

## 📂 POI分类

支持16种POI类别：

| 分组 | 类别 |
|-----|------|
| 基础生活 | 住宅小区、商业楼盘、学校、医疗 |
| 政务交通 | 政府、交通 |
| 商业服务 | 商业服务、休闲娱乐 |
| 地貌地标 | 自然地貌、行政区划、地标建筑 |
| 工业农业 | 工业园区、农业设施 |
| 公共设施 | 市政设施、公共服务、宗教场所 |

## 🔧 API接口

| 接口 | 方法 | 说明 |
|-----|-----|------|
| `/api/region` | GET/PUT | 获取/更新区域配置 |
| `/api/regions/presets` | GET | 获取预设区域列表 |
| `/api/keys/<platform>` | GET/POST | 获取/添加API Key |
| `/api/collector/<platform>/start` | POST | 启动采集 |
| `/api/search?q=关键词` | GET | 搜索POI |
| `/api/compare?q=关键词` | GET | 多平台对比 |

![数据库](https://nas.allbs.cn:8888/cloudpic/2026/01/8d2aad42b875b900835ea41f1408fd97.png)
