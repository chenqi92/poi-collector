#!/usr/bin/env python3
"""
增强版POI采集器
支持：
1. 关键词搜索（原有）
2. 网格区域搜索 - 将区域划分为小块，逐块搜索
3. POI类型搜索 - 按平台POI分类代码搜索
"""
import requests
import json
import time
import sqlite3
import math
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict, field
from datetime import datetime
from enum import Enum
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# 导入基础模块
from multi_collector import (
    Platform, FUNING_CONFIG, RateLimiter, CoordinateConverter,
    POI, CollectorProgress, init_database
)

# ============ 高德POI类型 ============
# 参考: https://lbs.amap.com/api/webservice/download
AMAP_POI_TYPES = [
    # 汽车服务
    ("010000", "汽车服务"),
    ("010100", "加油站"),
    ("010400", "停车场"),
    # 餐饮服务
    ("050000", "餐饮服务"),
    # 购物服务
    ("060000", "购物服务"),
    ("060100", "商场"),
    ("060400", "超市"),
    # 生活服务
    ("070000", "生活服务"),
    ("070200", "邮局"),
    ("070700", "银行"),
    # 体育休闲
    ("080000", "体育休闲服务"),
    # 医疗保健
    ("090000", "医疗保健服务"),
    ("090100", "综合医院"),
    ("090200", "专科医院"),
    ("090300", "诊所"),
    ("090400", "药店"),
    # 住宿服务
    ("100000", "住宿服务"),
    ("100100", "宾馆酒店"),
    # 风景名胜
    ("110000", "风景名胜"),
    # 商务住宅
    ("120000", "商务住宅"),
    ("120200", "住宅区"),
    ("120300", "楼宇"),
    # 政府机构
    ("130000", "政府机构及社会团体"),
    # 科教文化
    ("140000", "科教文化服务"),
    ("141200", "学校"),
    # 交通设施
    ("150000", "交通设施服务"),
    ("150200", "火车站"),
    ("150300", "长途汽车站"),
    ("150500", "公交车站"),
    # 金融保险
    ("160000", "金融保险服务"),
    # 公司企业
    ("170000", "公司企业"),
    # 地名地址
    ("190000", "地名地址信息"),
    ("190100", "村庄"),
    ("190200", "乡镇"),
]

# ============ 百度POI类型 ============
BAIDU_POI_TYPES = [
    ("美食", "美食"),
    ("酒店", "酒店"),
    ("购物", "购物"),
    ("生活服务", "生活服务"),
    ("丽人", "丽人"),
    ("旅游景点", "旅游景点"),
    ("休闲娱乐", "休闲娱乐"),
    ("运动健身", "运动健身"),
    ("教育培训", "教育培训"),
    ("文化传媒", "文化传媒"),
    ("医疗", "医疗"),
    ("汽车服务", "汽车服务"),
    ("交通设施", "交通设施"),
    ("金融", "金融"),
    ("房地产", "房地产"),
    ("公司企业", "公司企业"),
    ("政府机构", "政府机构"),
]

# ============ 天地图POI类型 ============
TIANDITU_POI_TYPES = [
    ("010", "餐饮"),
    ("020", "宾馆"),
    ("030", "购物"),
    ("040", "生活服务"),
    ("050", "风景名胜"),
    ("060", "休闲娱乐"),
    ("070", "体育健身"),
    ("080", "文化传媒"),
    ("090", "教育科研"),
    ("100", "医疗卫生"),
    ("110", "交通运输"),
    ("120", "金融保险"),
    ("130", "商业公司"),
    ("140", "政府机关"),
    ("150", "社区服务"),
    ("160", "邮政通信"),
    ("170", "住宅区"),
]


class EnhancedCollector:
    """增强版采集器"""

    def __init__(self, platform: str, api_key: str, db_path: str = "funing_poi.db",
                 requests_per_second: float = 2.0):
        self.platform = platform
        self.api_key = api_key
        self.db_path = db_path
        self.session = requests.Session()
        self.rate_limiter = RateLimiter(requests_per_second, burst=5)
        self.max_retries = 3
        self._stop_flag = False

        # 网格配置
        self.grid_size = 0.02  # 约2km的网格

        # 统计
        self.total_saved = 0
        self.total_requests = 0

    def stop(self):
        self._stop_flag = True

    def _request(self, url: str, params: Dict) -> Optional[Dict]:
        """带限流和重试的请求"""
        for attempt in range(self.max_retries):
            if self._stop_flag:
                return None

            self.rate_limiter.wait()
            self.total_requests += 1

            try:
                resp = self.session.get(url, params=params, timeout=30)
                resp.raise_for_status()
                return resp.json()
            except Exception as e:
                if attempt < self.max_retries - 1:
                    time.sleep(1)
                    continue
                logger.warning(f"请求失败: {e}")
        return None

    def save_pois(self, pois: List[POI]) -> int:
        """保存POI到数据库"""
        if not pois:
            return 0

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        saved = 0

        for poi in pois:
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO pois
                    (name, lon, lat, original_lon, original_lat, category, category_id,
                     address, phone, platform, raw_data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (poi.name, poi.lon, poi.lat, poi.original_lon, poi.original_lat,
                      poi.category, poi.category_id, poi.address, poi.phone,
                      poi.platform, poi.raw_data))
                if cursor.rowcount > 0:
                    saved += 1
            except sqlite3.Error:
                pass

        conn.commit()
        conn.close()
        self.total_saved += saved
        return saved

    def generate_grid_centers(self) -> List[Tuple[float, float]]:
        """生成网格中心点"""
        bounds = FUNING_CONFIG["bounds"]
        centers = []

        lon = bounds["min_lon"]
        while lon < bounds["max_lon"]:
            lat = bounds["min_lat"]
            while lat < bounds["max_lat"]:
                centers.append((lon + self.grid_size/2, lat + self.grid_size/2))
                lat += self.grid_size
            lon += self.grid_size

        logger.info(f"生成 {len(centers)} 个网格中心点")
        return centers

    # ============ 高德采集 ============

    def collect_amap_by_type(self) -> int:
        """高德POI类型搜索"""
        logger.info("[高德] 开始POI类型搜索...")

        for type_code, type_name in AMAP_POI_TYPES:
            if self._stop_flag:
                break

            logger.info(f"  类型: {type_name} ({type_code})")
            page = 1

            while True:
                if self._stop_flag:
                    break

                params = {
                    "key": self.api_key,
                    "types": type_code,
                    "city": FUNING_CONFIG["city_code"],
                    "citylimit": "true",
                    "offset": 25,
                    "page": page,
                    "extensions": "all"
                }

                data = self._request("https://restapi.amap.com/v3/place/text", params)
                if not data or data.get("status") != "1":
                    break

                pois_data = data.get("pois", [])
                if not pois_data:
                    break

                pois = self._parse_amap_pois(pois_data, type_name, type_code)
                saved = self.save_pois(pois)

                total = int(data.get("count", 0))
                logger.info(f"    第{page}页: 获取{len(pois_data)}, 新增{saved}, 总计{total}")

                if page * 25 >= total or len(pois_data) < 25:
                    break
                page += 1

        return self.total_saved

    def collect_amap_by_grid(self) -> int:
        """高德网格周边搜索"""
        logger.info("[高德] 开始网格周边搜索...")
        centers = self.generate_grid_centers()

        for i, (lon, lat) in enumerate(centers):
            if self._stop_flag:
                break

            # 周边搜索，半径1500米
            params = {
                "key": self.api_key,
                "location": f"{lon},{lat}",
                "radius": 1500,
                "offset": 25,
                "page": 1,
                "extensions": "all"
            }

            data = self._request("https://restapi.amap.com/v3/place/around", params)
            if data and data.get("status") == "1":
                pois_data = data.get("pois", [])
                pois = self._parse_amap_pois(pois_data, "周边搜索", "around")
                saved = self.save_pois(pois)

                if saved > 0:
                    logger.info(f"  网格 {i+1}/{len(centers)}: 新增{saved}条")

        return self.total_saved

    def _parse_amap_pois(self, pois_data: List[Dict], category: str, category_id: str) -> List[POI]:
        """解析高德POI"""
        result = []
        bounds = FUNING_CONFIG["bounds"]

        for raw in pois_data:
            try:
                location = raw.get("location", "")
                if not location:
                    continue

                parts = location.split(",")
                if len(parts) != 2:
                    continue

                gcj_lon, gcj_lat = float(parts[0]), float(parts[1])
                wgs_lon, wgs_lat = CoordinateConverter.amap_to_wgs84(gcj_lon, gcj_lat)

                if not (bounds["min_lon"] <= wgs_lon <= bounds["max_lon"] and
                        bounds["min_lat"] <= wgs_lat <= bounds["max_lat"]):
                    continue

                name = raw.get("name", "").strip()
                if not name:
                    continue

                # 使用API返回的类型
                poi_type = raw.get("type", category)

                result.append(POI(
                    name=name,
                    lon=wgs_lon,
                    lat=wgs_lat,
                    original_lon=gcj_lon,
                    original_lat=gcj_lat,
                    category=poi_type.split(";")[0] if poi_type else category,
                    category_id=raw.get("typecode", category_id),
                    address=raw.get("address", "") if isinstance(raw.get("address"), str) else "",
                    phone=raw.get("tel", "") if isinstance(raw.get("tel"), str) else "",
                    platform="amap",
                    raw_data=json.dumps(raw, ensure_ascii=False)
                ))
            except Exception:
                continue

        return result

    # ============ 百度采集 ============

    def collect_baidu_by_type(self) -> int:
        """百度POI类型搜索"""
        logger.info("[百度] 开始POI类型搜索...")

        for query, type_name in BAIDU_POI_TYPES:
            if self._stop_flag:
                break

            logger.info(f"  类型: {type_name}")
            page = 0

            while True:
                if self._stop_flag:
                    break

                params = {
                    "ak": self.api_key,
                    "query": query,
                    "region": FUNING_CONFIG["name"],
                    "city_limit": "true",
                    "output": "json",
                    "page_size": 20,
                    "page_num": page,
                    "scope": 2
                }

                data = self._request("https://api.map.baidu.com/place/v2/search", params)
                if not data or data.get("status") != 0:
                    break

                pois_data = data.get("results", [])
                if not pois_data:
                    break

                pois = self._parse_baidu_pois(pois_data, type_name)
                saved = self.save_pois(pois)

                total = data.get("total", 0)
                logger.info(f"    第{page+1}页: 获取{len(pois_data)}, 新增{saved}, 总计{total}")

                if (page + 1) * 20 >= total or len(pois_data) < 20:
                    break
                page += 1

        return self.total_saved

    def collect_baidu_by_grid(self) -> int:
        """百度网格矩形搜索"""
        logger.info("[百度] 开始网格矩形搜索...")
        centers = self.generate_grid_centers()

        for i, (lon, lat) in enumerate(centers):
            if self._stop_flag:
                break

            # 矩形区域搜索
            half = self.grid_size / 2
            bounds_str = f"{lat-half},{lon-half},{lat+half},{lon+half}"

            params = {
                "ak": self.api_key,
                "query": "所有",
                "bounds": bounds_str,
                "output": "json",
                "page_size": 20,
                "page_num": 0,
                "scope": 2
            }

            data = self._request("https://api.map.baidu.com/place/v2/search", params)
            if data and data.get("status") == 0:
                pois_data = data.get("results", [])
                pois = self._parse_baidu_pois(pois_data, "网格搜索")
                saved = self.save_pois(pois)

                if saved > 0:
                    logger.info(f"  网格 {i+1}/{len(centers)}: 新增{saved}条")

        return self.total_saved

    def _parse_baidu_pois(self, pois_data: List[Dict], category: str) -> List[POI]:
        """解析百度POI"""
        result = []
        bounds = FUNING_CONFIG["bounds"]

        for raw in pois_data:
            try:
                location = raw.get("location", {})
                if not location:
                    continue

                bd_lon = location.get("lng", 0)
                bd_lat = location.get("lat", 0)
                if not bd_lon or not bd_lat:
                    continue

                wgs_lon, wgs_lat = CoordinateConverter.bd09_to_wgs84(bd_lon, bd_lat)

                if not (bounds["min_lon"] <= wgs_lon <= bounds["max_lon"] and
                        bounds["min_lat"] <= wgs_lat <= bounds["max_lat"]):
                    continue

                name = raw.get("name", "").strip()
                if not name:
                    continue

                result.append(POI(
                    name=name,
                    lon=wgs_lon,
                    lat=wgs_lat,
                    original_lon=bd_lon,
                    original_lat=bd_lat,
                    category=raw.get("detail_info", {}).get("tag", category) or category,
                    category_id=category,
                    address=raw.get("address", ""),
                    phone=raw.get("telephone", ""),
                    platform="baidu",
                    raw_data=json.dumps(raw, ensure_ascii=False)
                ))
            except Exception:
                continue

        return result

    # ============ 天地图采集 ============

    def collect_tianditu_by_type(self) -> int:
        """天地图POI类型搜索"""
        logger.info("[天地图] 开始POI类型搜索...")
        bounds = FUNING_CONFIG["bounds"]

        for type_code, type_name in TIANDITU_POI_TYPES:
            if self._stop_flag:
                break

            logger.info(f"  类型: {type_name} ({type_code})")
            start = 0

            while True:
                if self._stop_flag:
                    break

                params = {
                    "postStr": json.dumps({
                        "keyWord": type_name,
                        "level": 12,
                        "mapBound": f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}",
                        "queryType": 1,
                        "start": start,
                        "count": 100,
                        "specify": FUNING_CONFIG["admin_code"]
                    }),
                    "type": "query",
                    "tk": self.api_key
                }

                data = self._request("http://api.tianditu.gov.cn/v2/search", params)
                if not data or data.get("status", {}).get("infocode") != 1000:
                    break

                pois_data = data.get("pois", [])
                if not pois_data:
                    break

                pois = self._parse_tianditu_pois(pois_data, type_name, type_code)
                saved = self.save_pois(pois)
                logger.info(f"    获取{len(pois_data)}, 新增{saved}")

                if len(pois_data) < 100:
                    break
                start += 100

        return self.total_saved

    def _parse_tianditu_pois(self, pois_data: List[Dict], category: str, category_id: str) -> List[POI]:
        """解析天地图POI"""
        result = []
        bounds = FUNING_CONFIG["bounds"]

        for raw in pois_data:
            try:
                lonlat = raw.get("lonlat", "").split(",")
                if len(lonlat) != 2:
                    continue

                lon, lat = float(lonlat[0]), float(lonlat[1])

                if not (bounds["min_lon"] <= lon <= bounds["max_lon"] and
                        bounds["min_lat"] <= lat <= bounds["max_lat"]):
                    continue

                name = raw.get("name", "").strip()
                if not name:
                    continue

                result.append(POI(
                    name=name,
                    lon=lon,
                    lat=lat,
                    original_lon=lon,
                    original_lat=lat,
                    category=raw.get("poiType", category) or category,
                    category_id=category_id,
                    address=raw.get("address", ""),
                    phone=raw.get("phone", ""),
                    platform="tianditu",
                    raw_data=json.dumps(raw, ensure_ascii=False)
                ))
            except Exception:
                continue

        return result

    def collect_all(self) -> Dict:
        """执行全量采集"""
        logger.info(f"\n{'='*60}")
        logger.info(f"开始增强采集 - 平台: {self.platform}")
        logger.info(f"{'='*60}\n")

        start_time = time.time()

        if self.platform == "amap":
            self.collect_amap_by_type()
            if not self._stop_flag:
                self.collect_amap_by_grid()

        elif self.platform == "baidu":
            self.collect_baidu_by_type()
            if not self._stop_flag:
                self.collect_baidu_by_grid()

        elif self.platform == "tianditu":
            self.collect_tianditu_by_type()

        elapsed = time.time() - start_time

        result = {
            "platform": self.platform,
            "total_saved": self.total_saved,
            "total_requests": self.total_requests,
            "elapsed_seconds": round(elapsed, 1)
        }

        logger.info(f"\n{'='*60}")
        logger.info(f"采集完成!")
        logger.info(f"  平台: {self.platform}")
        logger.info(f"  新增数据: {self.total_saved}")
        logger.info(f"  API请求: {self.total_requests}")
        logger.info(f"  耗时: {elapsed:.1f}秒")
        logger.info(f"{'='*60}\n")

        return result


def main():
    import argparse

    parser = argparse.ArgumentParser(description="增强版POI采集器")
    parser.add_argument("--platform", "-p", choices=["tianditu", "amap", "baidu"], required=True)
    parser.add_argument("--api-key", "-k", help="API Key (可选，从数据库读取)")
    parser.add_argument("--db", "-d", default="funing_poi.db")
    parser.add_argument("--rate", "-r", type=float, default=3.0, help="每秒请求数")

    args = parser.parse_args()

    init_database(args.db)

    # 获取API Key
    api_key = args.api_key
    if not api_key:
        conn = sqlite3.connect(args.db)
        cursor = conn.cursor()
        cursor.execute("SELECT api_key FROM api_keys WHERE platform = ?", (args.platform,))
        row = cursor.fetchone()
        conn.close()
        if row:
            api_key = row[0]
        else:
            print(f"错误: 未找到 {args.platform} 的API Key")
            print("请先在Web界面配置，或使用 -k 参数指定")
            return

    collector = EnhancedCollector(args.platform, api_key, args.db, args.rate)

    try:
        collector.collect_all()
    except KeyboardInterrupt:
        print("\n采集已中断")
        collector.stop()


if __name__ == "__main__":
    main()
