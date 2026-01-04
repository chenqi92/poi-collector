#!/usr/bin/env python3
"""
POI管理Web服务器
提供Web界面进行API Key管理、数据采集、查询和对比
"""
from flask import Flask, request, jsonify, render_template, send_from_directory, Response
from flask_cors import CORS
import threading
import json
import os
import queue
import time
from pathlib import Path
from datetime import datetime

# 获取脚本所在目录，确保路径一致
SCRIPT_DIR = Path(__file__).parent.absolute()
os.chdir(SCRIPT_DIR)  # 切换工作目录

from multi_database import MultiPlatformDatabase, Platform, MatchMode
from multi_collector import (
    create_collector, init_database, Platform as CollectorPlatform,
    CollectorProgress, POI_CATEGORIES, get_region_config
)
from region_config import (
    get_current_region, set_region, set_region_by_preset,
    get_preset_list, create_custom_region, RegionConfig
)

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

# 配置 - 使用绝对路径
DB_PATH = os.environ.get('POI_DB_PATH', str(SCRIPT_DIR / 'funing_poi.db'))

# 日志队列（用于实时推送）
log_queues = {}  # platform -> queue

# 全局变量
db = None
collectors = {}  # 运行中的采集器
collector_threads = {}  # 采集线程


def get_db() -> MultiPlatformDatabase:
    global db
    if db is None:
        init_database(DB_PATH)
        db = MultiPlatformDatabase(DB_PATH)
    return db


def get_collector_status(platform: str) -> dict:
    """获取采集器状态"""
    progress_file = SCRIPT_DIR / f"progress_{platform}.json"
    if progress_file.exists():
        try:
            with open(progress_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            pass

    return {
        "platform": platform,
        "status": "idle",
        "total_collected": 0,
        "completed_categories": [],
        "current_category_id": "",
        "current_keyword_index": 0
    }


class LogHandler:
    """日志处理器，用于捕获采集日志"""
    def __init__(self, platform: str):
        self.platform = platform
        self.queue = queue.Queue(maxsize=100)
        log_queues[platform] = self.queue

    def write(self, msg: str):
        if msg.strip():
            try:
                self.queue.put_nowait({
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "msg": msg.strip()
                })
            except queue.Full:
                try:
                    self.queue.get_nowait()
                    self.queue.put_nowait({
                        "time": datetime.now().strftime("%H:%M:%S"),
                        "msg": msg.strip()
                    })
                except:
                    pass

    def flush(self):
        pass


# ============ 工具函数 ============

def mask_key(key: str) -> str:
    """隐藏API Key中间部分"""
    if key and len(key) > 8:
        return key[:4] + '*' * (len(key) - 8) + key[-4:]
    return key


# ============ API路由 ============

@app.route('/api/keys', methods=['GET'])
def get_api_keys():
    """获取所有平台的API Key列表"""
    all_keys = get_db().get_all_platform_keys()
    result = {}
    configured = []

    for platform, keys in all_keys.items():
        result[platform] = []
        for k in keys:
            result[platform].append({
                "id": k["id"],
                "name": k["name"],
                "api_key": mask_key(k["api_key"]),
                "is_active": k["is_active"],
                "quota_exhausted": k["quota_exhausted"],
                "last_used_at": k["last_used_at"]
            })
        if keys:
            configured.append(platform)

    return jsonify({
        "success": True,
        "keys": result,
        "configured": configured
    })


@app.route('/api/keys/<platform>', methods=['POST'])
def add_api_key(platform):
    """添加API Key"""
    data = request.get_json()
    api_key = data.get('api_key', '').strip()
    name = data.get('name', '').strip()

    if not api_key:
        return jsonify({"success": False, "error": "API Key不能为空"}), 400

    if platform not in ['tianditu', 'amap', 'baidu']:
        return jsonify({"success": False, "error": "无效的平台"}), 400

    key_id = get_db().add_api_key(platform, api_key, name)
    return jsonify({
        "success": True,
        "message": f"{platform} API Key已添加",
        "key_id": key_id
    })


@app.route('/api/keys/<platform>/<int:key_id>', methods=['PUT'])
def update_api_key(platform, key_id):
    """更新API Key"""
    data = request.get_json()
    api_key = data.get('api_key')
    name = data.get('name')
    is_active = data.get('is_active')

    get_db().update_api_key(key_id, api_key, name, is_active)
    return jsonify({"success": True, "message": "API Key已更新"})


@app.route('/api/keys/<platform>/<int:key_id>', methods=['DELETE'])
def delete_api_key(platform, key_id):
    """删除API Key"""
    get_db().delete_api_key(key_id)
    return jsonify({"success": True, "message": "API Key已删除"})


@app.route('/api/keys/<platform>/reset-quota', methods=['POST'])
def reset_key_quotas(platform):
    """重置平台所有Key的配额状态"""
    if platform not in ['tianditu', 'amap', 'baidu']:
        return jsonify({"success": False, "error": "无效的平台"}), 400

    get_db().reset_all_key_quotas(platform)
    return jsonify({"success": True, "message": f"{platform} 所有Key配额已重置"})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """获取统计信息"""
    platform = request.args.get('platform', 'all')
    try:
        p = Platform(platform) if platform != 'all' else Platform.ALL
        stats = get_db().get_stats(p)
        return jsonify({"success": True, **stats})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/categories', methods=['GET'])
def get_categories():
    """获取分类列表"""
    platform = request.args.get('platform', 'all')
    p = Platform(platform) if platform != 'all' else Platform.ALL
    categories = get_db().get_categories(p)
    return jsonify({"success": True, "categories": categories})


@app.route('/api/search', methods=['GET'])
def search_pois():
    """搜索POI"""
    query = request.args.get('q', '')
    platform = request.args.get('platform', 'all')
    mode = request.args.get('mode', 'smart')
    category = request.args.get('category')
    limit = int(request.args.get('limit', 50))

    if not query:
        return jsonify({"success": False, "error": "缺少搜索关键词"}), 400

    try:
        p = Platform(platform) if platform != 'all' else Platform.ALL
        m = MatchMode(mode)
        results = get_db().search(query, m, p, limit, category)
        return jsonify({
            "success": True,
            "query": query,
            "count": len(results),
            "results": [r.to_dict() for r in results]
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/compare', methods=['GET'])
def compare_platforms():
    """对比三个平台的数据"""
    query = request.args.get('q', '')
    limit = int(request.args.get('limit', 20))

    if not query:
        return jsonify({"success": False, "error": "缺少搜索关键词"}), 400

    results = get_db().compare_platforms(query, limit)
    return jsonify({
        "success": True,
        "query": query,
        "results": {
            platform: [r.to_dict() for r in pois]
            for platform, pois in results.items()
        }
    })


@app.route('/api/pois/<platform>', methods=['GET'])
def get_platform_pois(platform):
    """获取指定平台的POI列表"""
    limit = int(request.args.get('limit', 50))
    offset = int(request.args.get('offset', 0))

    try:
        p = Platform(platform)
        pois, total = get_db().get_pois_by_platform(p, limit, offset)
        return jsonify({
            "success": True,
            "platform": platform,
            "total": total,
            "limit": limit,
            "offset": offset,
            "results": [r.to_dict() for r in pois]
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/pois/<platform>', methods=['DELETE'])
def delete_platform_pois(platform):
    """删除指定平台的所有数据"""
    try:
        deleted = get_db().delete_pois_by_platform(platform)
        return jsonify({
            "success": True,
            "message": f"已删除 {deleted} 条 {platform} 数据"
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ============ 采集相关API ============

@app.route('/api/collector/status', methods=['GET'])
def get_all_collector_status():
    """获取所有采集器状态"""
    statuses = {}
    finished_platforms = []

    for platform in ['tianditu', 'amap', 'baidu']:
        status = get_collector_status(platform)
        # 检查线程是否还在运行
        if platform in collector_threads:
            if collector_threads[platform].is_alive():
                status['status'] = 'running'
            else:
                # 标记已结束的平台，稍后清理
                finished_platforms.append(platform)
        statuses[platform] = status

    # 清理已结束的线程（在循环外进行）
    for platform in finished_platforms:
        collector_threads.pop(platform, None)
        collectors.pop(platform, None)

    return jsonify({"success": True, "statuses": statuses})


@app.route('/api/collector/<platform>/status', methods=['GET'])
def get_collector_status_api(platform):
    """获取指定平台采集器状态"""
    status = get_collector_status(platform)

    if platform in collector_threads and collector_threads[platform].is_alive():
        status['status'] = 'running'

    return jsonify({"success": True, **status})


@app.route('/api/collector/<platform>/start', methods=['POST'])
def start_collector(platform):
    """启动采集"""
    if platform not in ['tianditu', 'amap', 'baidu']:
        return jsonify({"success": False, "error": "无效的平台"}), 400

    # 检查是否已在运行
    if platform in collector_threads and collector_threads[platform].is_alive():
        return jsonify({"success": False, "error": "采集器正在运行中"}), 400

    # 获取API Key（支持多Key）
    db_instance = get_db()
    key_info = db_instance.get_api_key_with_id(platform)
    if not key_info:
        return jsonify({"success": False, "error": f"请先配置 {platform} 的API Key"}), 400

    key_id, api_key = key_info

    data = request.get_json() or {}
    resume = data.get('resume', True)
    rate = float(data.get('rate', 2.0))
    categories = data.get('categories', None)  # 选中的类别ID列表

    # 创建日志处理器
    log_handler = LogHandler(platform)

    # 创建采集器（支持key轮换）
    try:
        collector = create_collector(
            CollectorPlatform(platform),
            api_key,
            DB_PATH,
            rate,
            key_id=key_id,
            key_manager=db_instance
        )

        # 设置采集类别
        if categories:
            collector.set_categories(categories)
            log_handler.write(f"[{platform}] 已选择 {len(categories)} 个类别进行采集")

        collectors[platform] = collector

        # 在后台线程中运行
        def run_collector():
            import logging

            # 设置日志输出到队列
            logger = logging.getLogger()
            handler = logging.StreamHandler(log_handler)
            handler.setFormatter(logging.Formatter('%(message)s'))
            logger.addHandler(handler)

            try:
                log_handler.write(f"[{platform}] 开始采集...")
                collector.collect_all(resume=resume)
                log_handler.write(f"[{platform}] 采集完成!")
            except Exception as e:
                log_handler.write(f"[{platform}] 错误: {str(e)}")
                # 保存错误状态
                progress = CollectorProgress(
                    platform=platform,
                    status="error",
                    error_message=str(e)
                )
                progress_file = SCRIPT_DIR / f"progress_{platform}.json"
                with open(progress_file, 'w', encoding='utf-8') as f:
                    json.dump(progress.to_dict(), f, ensure_ascii=False, indent=2)
            finally:
                logger.removeHandler(handler)

        thread = threading.Thread(target=run_collector, daemon=True)
        thread.start()
        collector_threads[platform] = thread

        return jsonify({
            "success": True,
            "message": f"{platform} 采集已启动",
            "resume": resume,
            "categories": categories
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/collector/<platform>/logs')
def stream_logs(platform):
    """SSE日志流"""
    def generate():
        q = log_queues.get(platform)
        if not q:
            yield f"data: {json.dumps({'msg': '等待采集开始...'})}\n\n"
            return

        while True:
            try:
                log = q.get(timeout=1)
                yield f"data: {json.dumps(log, ensure_ascii=False)}\n\n"
            except queue.Empty:
                # 发送心跳
                yield f": heartbeat\n\n"
            except:
                break

    return Response(generate(), mimetype='text/event-stream')


@app.route('/api/collector/<platform>/stop', methods=['POST'])
def stop_collector(platform):
    """停止采集"""
    if platform not in collectors:
        return jsonify({"success": False, "error": "采集器未运行"}), 400

    collectors[platform].stop()
    return jsonify({"success": True, "message": f"{platform} 采集已停止"})


@app.route('/api/collector/<platform>/reset', methods=['POST'])
def reset_collector(platform):
    """重置采集进度"""
    progress_file = SCRIPT_DIR / f"progress_{platform}.json"
    if progress_file.exists():
        progress_file.unlink()

    return jsonify({"success": True, "message": f"{platform} 进度已重置"})


@app.route('/api/collector/categories', methods=['GET'])
def get_poi_categories():
    """获取POI采集类别配置"""
    return jsonify({
        "success": True,
        "categories": POI_CATEGORIES
    })


# ============ 区域配置API ============

@app.route('/api/region', methods=['GET'])
def get_region():
    """获取当前区域配置"""
    region = get_current_region()
    return jsonify({
        "success": True,
        "region": region.to_dict()
    })


@app.route('/api/region', methods=['PUT'])
def update_region():
    """更新区域配置"""
    data = request.get_json()
    
    # 检查是否是预设区域
    preset_id = data.get('preset_id')
    if preset_id:
        region = set_region_by_preset(preset_id)
        if region:
            return jsonify({
                "success": True,
                "message": f"已切换到预设区域: {region.name}",
                "region": region.to_dict()
            })
        else:
            return jsonify({"success": False, "error": "无效的预设区域ID"}), 400
    
    # 自定义区域配置
    required_fields = ['name', 'admin_code', 'city_code', 'bounds']
    for field in required_fields:
        if field not in data:
            return jsonify({"success": False, "error": f"缺少必填字段: {field}"}), 400
    
    try:
        bounds = data['bounds']
        region = create_custom_region(
            name=data['name'],
            admin_code=data['admin_code'],
            city_code=data['city_code'],
            min_lon=float(bounds['min_lon']),
            max_lon=float(bounds['max_lon']),
            min_lat=float(bounds['min_lat']),
            max_lat=float(bounds['max_lat']),
            center_lon=data.get('center', [None])[0],
            center_lat=data.get('center', [None, None])[1]
        )
        
        if set_region(region):
            return jsonify({
                "success": True,
                "message": f"区域配置已更新: {region.name}",
                "region": region.to_dict()
            })
        else:
            return jsonify({"success": False, "error": "保存配置失败"}), 500
    except (KeyError, ValueError) as e:
        return jsonify({"success": False, "error": f"配置参数错误: {str(e)}"}), 400


@app.route('/api/regions/presets', methods=['GET'])
def get_region_presets():
    """获取预设区域列表"""
    return jsonify({
        "success": True,
        "presets": get_preset_list()
    })


# ============ 页面路由 ============

@app.route('/')
def index():
    """主页"""
    return render_template('index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)


def create_templates():
    """创建模板目录和文件"""
    templates_dir = Path(__file__).parent / 'templates'
    static_dir = Path(__file__).parent / 'static'
    templates_dir.mkdir(exist_ok=True)
    static_dir.mkdir(exist_ok=True)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="POI管理Web服务器")
    parser.add_argument("--host", "-H", default="0.0.0.0")
    parser.add_argument("--port", "-p", type=int, default=5000)
    parser.add_argument("--db", "-d", default="funing_poi.db")
    parser.add_argument("--debug", action="store_true")

    args = parser.parse_args()

    global DB_PATH
    DB_PATH = args.db

    create_templates()
    init_database(DB_PATH)

    print("=" * 60)
    print("阜宁县POI管理系统")
    print("=" * 60)
    print(f"数据库: {DB_PATH}")
    print(f"访问地址: http://{args.host}:{args.port}")
    print("=" * 60)

    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
