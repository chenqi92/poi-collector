"""
阜宁县POI数据采集与查询系统

支持天地图、高德地图、百度地图三大平台

模块:
- multi_collector: 多平台POI数据采集器（支持限流和断点续传）
- multi_database: 多平台POI数据库查询接口（支持多种模糊匹配）
- web_server: Web管理界面服务器

使用方法:
1. 安装依赖: pip install -r requirements.txt
2. 启动Web服务: python web_server.py
3. 访问 http://localhost:5000
"""

__version__ = "2.0.0"
