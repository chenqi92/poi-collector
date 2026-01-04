#!/usr/bin/env python3
"""
POI查询HTTP服务
为无人机导航提供地点坐标查询API
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import argparse
import logging
from database import POIDatabase, MatchMode

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)


class POIServiceHandler(BaseHTTPRequestHandler):
    """HTTP请求处理器"""

    db: POIDatabase = None

    def _set_headers(self, status: int = 200, content_type: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _send_json(self, data: dict, status: int = 200):
        self._set_headers(status)
        response = json.dumps(data, ensure_ascii=False, indent=2)
        self.wfile.write(response.encode("utf-8"))

    def _send_error(self, message: str, status: int = 400):
        self._send_json({"error": message, "success": False}, status)

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        routes = {
            "/search": self._handle_search,
            "/coordinates": self._handle_coordinates,
            "/nearby": self._handle_nearby,
            "/categories": self._handle_categories,
            "/stats": self._handle_stats,
            "/health": self._handle_health,
        }

        handler = routes.get(path)
        if handler:
            try:
                handler(params)
            except Exception as e:
                logger.exception("请求处理错误")
                self._send_error(f"服务器错误: {str(e)}", 500)
        else:
            self._handle_index()

    def _handle_index(self):
        """API文档"""
        doc = """<!DOCTYPE html>
<html>
<head>
    <title>阜宁县POI查询服务</title>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
        .endpoint { background: #fafafa; padding: 15px; margin: 15px 0; border-radius: 5px; border-left: 4px solid #4CAF50; }
        code { background: #e8e8e8; padding: 2px 8px; border-radius: 3px; font-family: Consolas, monospace; }
        .method { color: #4CAF50; font-weight: bold; }
        .param { color: #666; font-size: 0.9em; margin-top: 8px; }
        a { color: #1976D2; }
    </style>
</head>
<body>
    <div class="container">
        <h1>阜宁县POI查询服务 API</h1>
        <p>为无人机导航提供地点坐标查询服务，支持多种模糊匹配模式</p>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/search?q=关键词&mode=smart&limit=20</code></p>
            <p>搜索地点，返回匹配的POI列表</p>
            <p class="param">参数:
                <br>- q: 搜索关键词 (必需)
                <br>- mode: 匹配模式 [smart|exact|prefix|contains|fuzzy|fulltext] (默认: smart)
                <br>- category: 分类过滤 (可选)
                <br>- limit: 返回数量 (默认: 20)
            </p>
            <p>示例: <a href="/search?q=清华">/search?q=清华</a> |
                <a href="/search?q=金沙*&mode=fuzzy">/search?q=金沙*&mode=fuzzy</a></p>
        </div>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/coordinates?name=地点名称</code></p>
            <p>获取地点的经纬度坐标（返回最匹配的一个）</p>
            <p>示例: <a href="/coordinates?name=阜宁中学">/coordinates?name=阜宁中学</a></p>
        </div>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/nearby?lon=经度&lat=纬度&radius=1.0</code></p>
            <p>搜索指定坐标附近的地点</p>
            <p class="param">参数:
                <br>- lon, lat: 坐标 (必需)
                <br>- radius: 搜索半径(公里) (默认: 1.0)
                <br>- category: 分类过滤 (可选)
            </p>
            <p>示例: <a href="/nearby?lon=119.55&lat=33.78&radius=2">/nearby?lon=119.55&lat=33.78&radius=2</a></p>
        </div>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/categories</code></p>
            <p>获取所有POI分类及数量</p>
        </div>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/stats</code></p>
            <p>获取数据库统计信息</p>
        </div>

        <div class="endpoint">
            <p><span class="method">GET</span> <code>/health</code></p>
            <p>健康检查</p>
        </div>

        <h2>匹配模式说明</h2>
        <ul>
            <li><b>smart</b> (推荐): 智能匹配，自动组合多种策略，按相关性排序</li>
            <li><b>exact</b>: 精确匹配，名称完全相同</li>
            <li><b>prefix</b>: 前缀匹配，名称以关键词开头</li>
            <li><b>contains</b>: 包含匹配，名称包含关键词</li>
            <li><b>fuzzy</b>: 模糊匹配，支持通配符 * 和 ?</li>
            <li><b>fulltext</b>: 全文搜索，搜索名称和地址</li>
        </ul>
    </div>
</body>
</html>"""
        self._set_headers(200, "text/html")
        self.wfile.write(doc.encode("utf-8"))

    def _handle_search(self, params: dict):
        """搜索地点"""
        query = params.get("q", params.get("query", [""]))[0]
        if not query:
            self._send_error("缺少查询参数 'q'")
            return

        mode_str = params.get("mode", ["smart"])[0]
        try:
            mode = MatchMode(mode_str)
        except ValueError:
            mode = MatchMode.SMART

        limit = int(params.get("limit", ["20"])[0])
        category = params.get("category", [None])[0]

        results = self.db.search(query, mode, limit, category)

        self._send_json({
            "success": True,
            "query": query,
            "mode": mode.value,
            "count": len(results),
            "results": [poi.to_dict() for poi in results]
        })

    def _handle_coordinates(self, params: dict):
        """获取地点坐标"""
        name = params.get("name", [""])[0]
        if not name:
            self._send_error("缺少参数 'name'")
            return

        results = self.db.search(name, MatchMode.SMART, limit=1)
        if results:
            poi = results[0]
            self._send_json({
                "success": True,
                "name": poi.name,
                "matched_name": poi.name,
                "score": poi.score,
                "coordinates": {
                    "lon": poi.lon,
                    "lat": poi.lat,
                    "wgs84": [poi.lon, poi.lat]
                },
                "category": poi.category,
                "address": poi.address
            })
        else:
            # 尝试获取建议
            suggestions = self.db.search(name, MatchMode.CONTAINS, limit=5)
            self._send_json({
                "success": False,
                "error": f"未找到地点: {name}",
                "suggestions": [poi.name for poi in suggestions]
            }, 404)

    def _handle_nearby(self, params: dict):
        """搜索附近地点"""
        try:
            lon = float(params.get("lon", ["0"])[0])
            lat = float(params.get("lat", ["0"])[0])
            radius = float(params.get("radius", ["1.0"])[0])
            limit = int(params.get("limit", ["20"])[0])
            category = params.get("category", [None])[0]
        except ValueError:
            self._send_error("参数格式错误")
            return

        if lon == 0 or lat == 0:
            self._send_error("缺少参数 'lon' 和 'lat'")
            return

        results = self.db.search_nearby(lon, lat, radius, limit, category)
        self._send_json({
            "success": True,
            "center": {"lon": lon, "lat": lat},
            "radius_km": radius,
            "count": len(results),
            "results": [poi.to_dict() for poi in results]
        })

    def _handle_categories(self, params: dict):
        """获取所有分类"""
        categories = self.db.get_all_categories()
        self._send_json({
            "success": True,
            "categories": [
                {"name": cat, "id": cat_id, "count": count}
                for cat, cat_id, count in categories
            ]
        })

    def _handle_stats(self, params: dict):
        """数据库统计"""
        total = self.db.get_total_count()
        categories = self.db.get_all_categories()
        self._send_json({
            "success": True,
            "total_pois": total,
            "category_count": len(categories),
            "categories": {cat: count for cat, _, count in categories}
        })

    def _handle_health(self, params: dict):
        """健康检查"""
        self._send_json({
            "success": True,
            "status": "healthy",
            "database": self.db.db_path,
            "total_pois": self.db.get_total_count()
        })

    def log_message(self, format, *args):
        logger.info(f"{self.address_string()} - {args[0]}")


def run_server(host: str = "0.0.0.0", port: int = 8080, db_path: str = "funing_poi.db"):
    """启动HTTP服务"""
    try:
        POIServiceHandler.db = POIDatabase(db_path)
    except FileNotFoundError:
        print(f"错误: 数据库文件 {db_path} 不存在")
        print("请先运行 collector.py 采集数据")
        return

    server = HTTPServer((host, port), POIServiceHandler)

    print("=" * 60)
    print("阜宁县POI查询服务")
    print("=" * 60)
    print(f"数据库: {db_path}")
    print(f"POI总数: {POIServiceHandler.db.get_total_count()}")
    print(f"服务地址: http://{host}:{port}")
    print("=" * 60)
    print("API端点:")
    print("  GET /search?q=关键词&mode=smart")
    print("  GET /coordinates?name=地点名称")
    print("  GET /nearby?lon=经度&lat=纬度&radius=1.0")
    print("  GET /categories")
    print("  GET /stats")
    print("=" * 60)
    print("按 Ctrl+C 停止服务\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.shutdown()


def main():
    parser = argparse.ArgumentParser(description="阜宁县POI查询HTTP服务")
    parser.add_argument("--host", "-H", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", "-p", type=int, default=8080, help="监听端口")
    parser.add_argument("--db", "-d", default="funing_poi.db", help="数据库文件路径")

    args = parser.parse_args()
    run_server(args.host, args.port, args.db)


if __name__ == "__main__":
    main()
