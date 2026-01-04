#!/usr/bin/env python3
"""
多平台POI数据采集器
支持天地图、高德地图、百度地图
"""
import requests
import json
import time
import sqlite3
import threading
import math
from abc import ABC, abstractmethod
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict, field
from datetime import datetime
from enum import Enum
import logging

# 导入区域配置
from region_config import get_current_region, RegionConfig

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


class Platform(Enum):
    """地图平台"""
    TIANDITU = "tianditu"
    AMAP = "amap"          # 高德
    BAIDU = "baidu"


def get_region_config() -> dict:
    """获取当前区域配置（转换为字典格式供采集器使用）"""
    region = get_current_region()
    return {
        "name": region.name,
        "admin_code": region.admin_code,
        "city_code": region.city_code,
        "bounds": region.bounds,
        "center": region.center
    }

# POI采集类别
POI_CATEGORIES = [
    # 基础生活类
    {"id": "residential", "name": "住宅小区", "keywords": ["小区", "花园", "家园", "公寓", "名苑", "雅苑", "新村", "嘉园", "华府", "名邸", "御府", "馨园"]},
    {"id": "commercial", "name": "商业楼盘", "keywords": ["广场", "中心", "大厦", "商厦", "写字楼", "商城", "购物中心", "步行街"]},
    {"id": "school", "name": "学校", "keywords": ["学校", "小学", "中学", "高中", "大学", "学院", "幼儿园", "实验学校", "培训学校", "职业学校"]},
    {"id": "hospital", "name": "医疗", "keywords": ["医院", "诊所", "卫生院", "社区卫生", "药店", "卫生室", "门诊", "急救中心"]},

    # 政务交通类
    {"id": "government", "name": "政府", "keywords": ["政府", "派出所", "公安局", "法院", "检察院", "街道办", "村委会", "居委会", "行政服务"]},
    {"id": "transport", "name": "交通", "keywords": ["汽车站", "火车站", "公交站", "停车场", "加油站", "高速出口", "收费站", "服务区", "码头"]},

    # 商业服务类
    {"id": "business", "name": "商业服务", "keywords": ["超市", "商场", "市场", "银行", "酒店", "宾馆", "餐厅", "饭店", "便利店"]},
    {"id": "entertainment", "name": "休闲娱乐", "keywords": ["电影院", "KTV", "游乐场", "健身房", "网吧", "咖啡厅", "酒吧", "茶馆", "棋牌室"]},

    # 地貌地标类
    {"id": "nature", "name": "自然地貌", "keywords": ["湖", "河", "公园", "景区", "森林", "湿地", "水库", "风景区", "自然保护区"]},
    {"id": "admin", "name": "行政区划", "keywords": ["镇", "乡", "村", "社区", "街道", "开发区", "高新区"]},
    {"id": "landmark", "name": "地标建筑", "keywords": ["塔", "桥", "广场", "纪念碑", "体育馆", "图书馆", "文化馆", "博物馆", "展览馆", "剧院"]},

    # 工业农业类
    {"id": "industrial", "name": "工业园区", "keywords": ["工业园", "产业园", "开发区", "厂区", "仓库", "物流园", "科技园", "创业园", "工厂"]},
    {"id": "agriculture", "name": "农业设施", "keywords": ["农场", "果园", "大棚", "养殖场", "农业基地", "合作社", "农庄", "采摘园"]},

    # 公共设施类
    {"id": "municipal", "name": "市政设施", "keywords": ["变电站", "水厂", "污水处理", "垃圾站", "消防站", "供电所", "自来水", "燃气站"]},
    {"id": "public_service", "name": "公共服务", "keywords": ["社区服务中心", "便民中心", "邮局", "快递站", "电信", "移动营业厅", "联通"]},
    {"id": "religious", "name": "宗教场所", "keywords": ["寺庙", "教堂", "道观", "祠堂", "庵", "佛寺", "清真寺"]},
]


class RateLimiter:
    """令牌桶限流器"""
    def __init__(self, requests_per_second: float = 2.0, burst: int = 5):
        self.rate = requests_per_second
        self.burst = burst
        self.tokens = burst
        self.last_update = time.time()
        self.lock = threading.Lock()

    def acquire(self, timeout: float = 30.0) -> bool:
        start_time = time.time()
        while True:
            with self.lock:
                now = time.time()
                elapsed = now - self.last_update
                self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
                self.last_update = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return True
            if time.time() - start_time > timeout:
                return False
            time.sleep(0.1)

    def wait(self):
        while not self.acquire():
            time.sleep(0.1)


class CoordinateConverter:
    """坐标转换工具"""

    PI = math.pi
    X_PI = PI * 3000.0 / 180.0
    A = 6378245.0
    EE = 0.00669342162296594323

    @classmethod
    def bd09_to_gcj02(cls, bd_lon: float, bd_lat: float) -> Tuple[float, float]:
        """百度BD09坐标转GCJ02"""
        x = bd_lon - 0.0065
        y = bd_lat - 0.006
        z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * cls.X_PI)
        theta = math.atan2(y, x) - 0.000003 * math.cos(x * cls.X_PI)
        gcj_lon = z * math.cos(theta)
        gcj_lat = z * math.sin(theta)
        return gcj_lon, gcj_lat

    @classmethod
    def gcj02_to_wgs84(cls, gcj_lon: float, gcj_lat: float) -> Tuple[float, float]:
        """GCJ02坐标转WGS84"""
        if cls._out_of_china(gcj_lon, gcj_lat):
            return gcj_lon, gcj_lat

        dlat = cls._transform_lat(gcj_lon - 105.0, gcj_lat - 35.0)
        dlon = cls._transform_lon(gcj_lon - 105.0, gcj_lat - 35.0)
        radlat = gcj_lat / 180.0 * cls.PI
        magic = math.sin(radlat)
        magic = 1 - cls.EE * magic * magic
        sqrtmagic = math.sqrt(magic)
        dlat = (dlat * 180.0) / ((cls.A * (1 - cls.EE)) / (magic * sqrtmagic) * cls.PI)
        dlon = (dlon * 180.0) / (cls.A / sqrtmagic * math.cos(radlat) * cls.PI)
        wgs_lat = gcj_lat - dlat
        wgs_lon = gcj_lon - dlon
        return wgs_lon, wgs_lat

    @classmethod
    def bd09_to_wgs84(cls, bd_lon: float, bd_lat: float) -> Tuple[float, float]:
        """百度BD09坐标转WGS84"""
        gcj_lon, gcj_lat = cls.bd09_to_gcj02(bd_lon, bd_lat)
        return cls.gcj02_to_wgs84(gcj_lon, gcj_lat)

    @classmethod
    def amap_to_wgs84(cls, gcj_lon: float, gcj_lat: float) -> Tuple[float, float]:
        """高德GCJ02坐标转WGS84"""
        return cls.gcj02_to_wgs84(gcj_lon, gcj_lat)

    @classmethod
    def _out_of_china(cls, lon: float, lat: float) -> bool:
        return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)

    @classmethod
    def _transform_lat(cls, x: float, y: float) -> float:
        ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * cls.PI) + 20.0 * math.sin(2.0 * x * cls.PI)) * 2.0 / 3.0
        ret += (20.0 * math.sin(y * cls.PI) + 40.0 * math.sin(y / 3.0 * cls.PI)) * 2.0 / 3.0
        ret += (160.0 * math.sin(y / 12.0 * cls.PI) + 320 * math.sin(y * cls.PI / 30.0)) * 2.0 / 3.0
        return ret

    @classmethod
    def _transform_lon(cls, x: float, y: float) -> float:
        ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
        ret += (20.0 * math.sin(6.0 * x * cls.PI) + 20.0 * math.sin(2.0 * x * cls.PI)) * 2.0 / 3.0
        ret += (20.0 * math.sin(x * cls.PI) + 40.0 * math.sin(x / 3.0 * cls.PI)) * 2.0 / 3.0
        ret += (150.0 * math.sin(x / 12.0 * cls.PI) + 300.0 * math.sin(x / 30.0 * cls.PI)) * 2.0 / 3.0
        return ret


@dataclass
class POI:
    """POI数据结构"""
    name: str
    lon: float           # WGS84经度
    lat: float           # WGS84纬度
    original_lon: float  # 原始经度
    original_lat: float  # 原始纬度
    category: str
    category_id: str
    address: str
    phone: str
    platform: str
    raw_data: str


@dataclass
class CollectorProgress:
    """采集进度"""
    platform: str = ""
    started_at: str = ""
    last_updated: str = ""
    current_category_id: str = ""
    current_keyword_index: int = 0
    current_page: int = 1
    completed_categories: List[str] = field(default_factory=list)
    total_collected: int = 0
    status: str = "idle"  # idle, running, paused, completed, error
    error_message: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> 'CollectorProgress':
        return cls(**data)


class BaseCollector(ABC):
    """采集器基类"""

    def __init__(self, api_key: str, db_path: str, requests_per_second: float = 2.0,
                 key_id: int = None, key_manager=None):
        self.api_key = api_key
        self.db_path = db_path
        self.session = requests.Session()
        self.rate_limiter = RateLimiter(requests_per_second, burst=5)
        self.max_retries = 3
        self.retry_delay = 2.0
        self._stop_flag = False
        self.key_id = key_id  # 当前使用的key的ID
        self.key_manager = key_manager  # 用于切换key的管理器
        self.selected_categories = None  # 选中的采集类别ID列表

    @property
    @abstractmethod
    def platform(self) -> Platform:
        pass

    @property
    def progress_file(self) -> str:
        return f"progress_{self.platform.value}.json"

    def stop(self):
        """停止采集"""
        self._stop_flag = True

    def set_categories(self, category_ids: List[str]):
        """设置要采集的类别"""
        self.selected_categories = category_ids if category_ids else None

    def _switch_api_key(self) -> bool:
        """切换到下一个可用的API Key，返回是否成功"""
        if not self.key_manager or not self.key_id:
            return False

        result = self.key_manager.get_next_api_key(self.platform.value, self.key_id)
        if result:
            self.key_id, self.api_key = result
            logger.info(f"[{self.platform.value}] 已切换到新的API Key (ID: {self.key_id})")
            return True
        else:
            logger.warning(f"[{self.platform.value}] 没有更多可用的API Key")
            return False

    def _is_quota_error(self, response_data: Dict) -> bool:
        """检查是否是配额耗尽错误（子类可重写）"""
        return False

    def _load_progress(self) -> CollectorProgress:
        if Path(self.progress_file).exists():
            try:
                with open(self.progress_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return CollectorProgress.from_dict(data)
            except Exception as e:
                logger.warning(f"加载进度失败: {e}")
        return CollectorProgress(platform=self.platform.value, started_at=datetime.now().isoformat())

    def _save_progress(self, progress: CollectorProgress):
        progress.last_updated = datetime.now().isoformat()
        with open(self.progress_file, 'w', encoding='utf-8') as f:
            json.dump(progress.to_dict(), f, ensure_ascii=False, indent=2)

    def _request_with_retry(self, url: str, params: Dict) -> Optional[Dict]:
        for attempt in range(self.max_retries):
            self.rate_limiter.wait()
            try:
                response = self.session.get(url, params=params, timeout=30)

                # 处理429限流错误 - 等待后重试
                if response.status_code == 429:
                    wait_time = 5 * (attempt + 1)
                    logger.warning(f"请求过快(429)，等待{wait_time}秒后重试...")
                    time.sleep(wait_time)
                    continue

                # 处理400错误 - 可能是分页超限，返回空结果
                if response.status_code == 400:
                    logger.debug(f"请求返回400，可能是分页超限")
                    return None

                response.raise_for_status()
                data = response.json()

                # 检查是否是配额耗尽错误
                if self._is_quota_error(data):
                    logger.warning(f"[{self.platform.value}] API Key 配额已耗尽")
                    if self._switch_api_key():
                        # 切换成功，使用新key重新更新params
                        params = self._update_params_with_new_key(params)
                        continue
                    else:
                        return None

                return data
            except requests.Timeout:
                logger.warning(f"请求超时 (尝试 {attempt + 1}/{self.max_retries})")
            except requests.RequestException as e:
                logger.warning(f"请求错误: {e} (尝试 {attempt + 1}/{self.max_retries})")

            if attempt < self.max_retries - 1:
                time.sleep(self.retry_delay * (attempt + 1))
        return None

    def _update_params_with_new_key(self, params: Dict) -> Dict:
        """用新的API Key更新请求参数（子类需重写）"""
        return params

    @abstractmethod
    def search_poi(self, keyword: str, page: int = 1) -> Tuple[List[Dict], bool]:
        """搜索POI，返回(结果列表, 是否还有更多)"""
        pass

    @abstractmethod
    def parse_poi(self, raw: Dict, category: str, category_id: str) -> Optional[POI]:
        """解析POI数据"""
        pass

    def save_pois(self, pois: List[POI]) -> int:
        """保存POI到数据库"""
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
            except sqlite3.Error as e:
                logger.debug(f"保存失败 {poi.name}: {e}")

        conn.commit()
        conn.close()
        return saved

    def collect_all(self, resume: bool = True) -> CollectorProgress:
        """采集所有数据"""
        self._stop_flag = False

        if resume:
            progress = self._load_progress()
            if progress.status == "completed":
                progress = CollectorProgress(platform=self.platform.value,
                                           started_at=datetime.now().isoformat())
        else:
            progress = CollectorProgress(platform=self.platform.value,
                                        started_at=datetime.now().isoformat())

        progress.status = "running"
        self._save_progress(progress)

        # 确定要采集的类别
        categories_to_collect = POI_CATEGORIES
        if self.selected_categories:
            categories_to_collect = [c for c in POI_CATEGORIES if c["id"] in self.selected_categories]
            logger.info(f"[{self.platform.value}] 开始采集 (选中 {len(categories_to_collect)} 个类别)")
        else:
            logger.info(f"[{self.platform.value}] 开始采集 (全部类别)")

        # 找到恢复点
        start_cat_idx = 0
        if progress.current_category_id:
            for i, cat in enumerate(categories_to_collect):
                if cat["id"] == progress.current_category_id:
                    start_cat_idx = i
                    break

        try:
            for cat_idx in range(start_cat_idx, len(categories_to_collect)):
                if self._stop_flag:
                    progress.status = "paused"
                    self._save_progress(progress)
                    logger.info(f"[{self.platform.value}] 采集已暂停")
                    return progress

                cat_info = categories_to_collect[cat_idx]
                cat_id = cat_info["id"]
                cat_name = cat_info["name"]

                if cat_id in progress.completed_categories:
                    continue

                logger.info(f"[{self.platform.value}] 采集类别: {cat_name}")

                start_kw_idx = progress.current_keyword_index if cat_id == progress.current_category_id else 0

                for kw_idx in range(start_kw_idx, len(cat_info["keywords"])):
                    if self._stop_flag:
                        progress.current_category_id = cat_id
                        progress.current_keyword_index = kw_idx
                        progress.status = "paused"
                        self._save_progress(progress)
                        return progress

                    keyword = cat_info["keywords"][kw_idx]
                    start_page = progress.current_page if (cat_id == progress.current_category_id and
                                                           kw_idx == progress.current_keyword_index) else 1

                    page = start_page
                    while True:
                        if self._stop_flag:
                            progress.current_category_id = cat_id
                            progress.current_keyword_index = kw_idx
                            progress.current_page = page
                            progress.status = "paused"
                            self._save_progress(progress)
                            return progress

                        progress.current_category_id = cat_id
                        progress.current_keyword_index = kw_idx
                        progress.current_page = page
                        self._save_progress(progress)

                        raw_pois, has_more = self.search_poi(keyword, page)

                        if not raw_pois:
                            break

                        pois = []
                        for raw in raw_pois:
                            poi = self.parse_poi(raw, cat_name, cat_id)
                            if poi:
                                pois.append(poi)

                        if pois:
                            saved = self.save_pois(pois)
                            progress.total_collected += saved
                            logger.info(f"  [{keyword}] 第{page}页: 获取{len(raw_pois)}条, 新增{saved}条")

                        if not has_more:
                            break
                        page += 1

                progress.completed_categories.append(cat_id)
                progress.current_keyword_index = 0
                progress.current_page = 1

            progress.status = "completed"
            self._save_progress(progress)
            logger.info(f"[{self.platform.value}] 采集完成，共{progress.total_collected}条")

            # 注意：不删除进度文件，保留完成状态供前端查询

        except Exception as e:
            progress.status = "error"
            progress.error_message = str(e)
            self._save_progress(progress)
            logger.exception(f"[{self.platform.value}] 采集错误")

        return progress


class TianDiTuCollector(BaseCollector):
    """天地图采集器"""

    API_URL = "http://api.tianditu.gov.cn/v2/search"

    @property
    def platform(self) -> Platform:
        return Platform.TIANDITU

    def _is_quota_error(self, data: Dict) -> bool:
        """天地图配额错误检测"""
        status = data.get("status", {})
        # infocode 10001 表示配额超限
        return status.get("infocode") in [10001, 10002, 10003]

    def _update_params_with_new_key(self, params: Dict) -> Dict:
        """更新天地图请求参数中的key"""
        params["tk"] = self.api_key
        return params

    def search_poi(self, keyword: str, page: int = 1) -> Tuple[List[Dict], bool]:
        config = get_region_config()
        bounds = config["bounds"]
        region_name = config["name"]

        # 构建搜索参数 - 在关键词前加上区域名称提高精确度
        # 使用mapBound限制地理范围，不使用specify参数（API格式问题）
        search_keyword = f"{region_name} {keyword}"

        search_params = {
            "keyWord": search_keyword,
            "level": 12,
            "mapBound": f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}",
            "queryType": 1,
            "start": (page - 1) * 100,
            "count": 100
        }

        params = {
            "postStr": json.dumps(search_params, ensure_ascii=False),
            "type": "query",
            "tk": self.api_key
        }

        data = self._request_with_retry(self.API_URL, params)
        if data and data.get("status", {}).get("infocode") == 1000:
            pois = data.get("pois", [])
            return pois, len(pois) >= 100
        return [], False

    def parse_poi(self, raw: Dict, category: str, category_id: str) -> Optional[POI]:
        try:
            lonlat = raw.get("lonlat", "").split(",")
            if len(lonlat) != 2:
                return None

            lon, lat = float(lonlat[0]), float(lonlat[1])
            bounds = get_region_config()["bounds"]
            if not (bounds["min_lon"] <= lon <= bounds["max_lon"] and
                    bounds["min_lat"] <= lat <= bounds["max_lat"]):
                return None

            name = raw.get("name", "").strip()
            if not name:
                return None

            return POI(
                name=name,
                lon=lon,
                lat=lat,
                original_lon=lon,
                original_lat=lat,
                category=category,
                category_id=category_id,
                address=raw.get("address", ""),
                phone=raw.get("phone", ""),
                platform=self.platform.value,
                raw_data=json.dumps(raw, ensure_ascii=False)
            )
        except Exception:
            return None


class AmapCollector(BaseCollector):
    """高德地图采集器"""

    API_URL = "https://restapi.amap.com/v3/place/text"

    @property
    def platform(self) -> Platform:
        return Platform.AMAP

    def _is_quota_error(self, data: Dict) -> bool:
        """高德配额错误检测"""
        # status=0 表示失败，infocode 10003/10004/10005 表示配额相关错误
        if data.get("status") == "0":
            infocode = data.get("infocode", "")
            return infocode in ["10003", "10004", "10005", "10009", "10044"]
        return False

    def _update_params_with_new_key(self, params: Dict) -> Dict:
        """更新高德请求参数中的key"""
        params["key"] = self.api_key
        return params

    def search_poi(self, keyword: str, page: int = 1) -> Tuple[List[Dict], bool]:
        config = get_region_config()
        params = {
            "key": self.api_key,
            "keywords": keyword,
            "city": config["city_code"],
            "citylimit": "true",
            "offset": 25,
            "page": page,
            "extensions": "all"
        }

        data = self._request_with_retry(self.API_URL, params)
        if data and data.get("status") == "1":
            pois = data.get("pois", [])
            total = int(data.get("count", 0))
            has_more = page * 25 < total and len(pois) >= 25
            return pois, has_more
        return [], False

    def parse_poi(self, raw: Dict, category: str, category_id: str) -> Optional[POI]:
        try:
            location = raw.get("location", "")
            if not location:
                return None

            parts = location.split(",")
            if len(parts) != 2:
                return None

            gcj_lon, gcj_lat = float(parts[0]), float(parts[1])
            # 转换为WGS84
            wgs_lon, wgs_lat = CoordinateConverter.amap_to_wgs84(gcj_lon, gcj_lat)

            bounds = get_region_config()["bounds"]
            if not (bounds["min_lon"] <= wgs_lon <= bounds["max_lon"] and
                    bounds["min_lat"] <= wgs_lat <= bounds["max_lat"]):
                return None

            name = raw.get("name", "").strip()
            if not name:
                return None

            return POI(
                name=name,
                lon=wgs_lon,
                lat=wgs_lat,
                original_lon=gcj_lon,
                original_lat=gcj_lat,
                category=category,
                category_id=category_id,
                address=raw.get("address", "") if isinstance(raw.get("address"), str) else "",
                phone=raw.get("tel", "") if isinstance(raw.get("tel"), str) else "",
                platform=self.platform.value,
                raw_data=json.dumps(raw, ensure_ascii=False)
            )
        except Exception:
            return None


class BaiduCollector(BaseCollector):
    """百度地图采集器"""

    API_URL = "https://api.map.baidu.com/place/v2/search"

    @property
    def platform(self) -> Platform:
        return Platform.BAIDU

    def _is_quota_error(self, data: Dict) -> bool:
        """百度配额错误检测"""
        # status 302/401/402 表示配额相关错误
        status = data.get("status", 0)
        return status in [302, 401, 402, 4]

    def _update_params_with_new_key(self, params: Dict) -> Dict:
        """更新百度请求参数中的key"""
        params["ak"] = self.api_key
        return params

    def search_poi(self, keyword: str, page: int = 1) -> Tuple[List[Dict], bool]:
        config = get_region_config()
        params = {
            "ak": self.api_key,
            "query": keyword,
            "region": config["name"],
            "city_limit": "true",
            "output": "json",
            "page_size": 20,
            "page_num": page - 1,
            "scope": 2
        }

        data = self._request_with_retry(self.API_URL, params)
        if data and data.get("status") == 0:
            pois = data.get("results", [])
            total = data.get("total", 0)
            has_more = page * 20 < total and len(pois) >= 20
            return pois, has_more
        return [], False

    def parse_poi(self, raw: Dict, category: str, category_id: str) -> Optional[POI]:
        try:
            location = raw.get("location", {})
            if not location:
                return None

            bd_lon = location.get("lng", 0)
            bd_lat = location.get("lat", 0)
            if not bd_lon or not bd_lat:
                return None

            # 转换为WGS84
            wgs_lon, wgs_lat = CoordinateConverter.bd09_to_wgs84(bd_lon, bd_lat)

            bounds = get_region_config()["bounds"]
            if not (bounds["min_lon"] <= wgs_lon <= bounds["max_lon"] and
                    bounds["min_lat"] <= wgs_lat <= bounds["max_lat"]):
                return None

            name = raw.get("name", "").strip()
            if not name:
                return None

            return POI(
                name=name,
                lon=wgs_lon,
                lat=wgs_lat,
                original_lon=bd_lon,
                original_lat=bd_lat,
                category=category,
                category_id=category_id,
                address=raw.get("address", ""),
                phone=raw.get("telephone", ""),
                platform=self.platform.value,
                raw_data=json.dumps(raw, ensure_ascii=False)
            )
        except Exception:
            return None


def create_collector(platform: Platform, api_key: str, db_path: str,
                     rate: float = 2.0, key_id: int = None,
                     key_manager=None) -> BaseCollector:
    """创建采集器实例"""
    collectors = {
        Platform.TIANDITU: TianDiTuCollector,
        Platform.AMAP: AmapCollector,
        Platform.BAIDU: BaiduCollector
    }
    return collectors[platform](api_key, db_path, rate, key_id, key_manager)


def init_database(db_path: str):
    """初始化数据库"""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pois (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            lon REAL NOT NULL,
            lat REAL NOT NULL,
            original_lon REAL,
            original_lat REAL,
            category TEXT,
            category_id TEXT,
            address TEXT,
            phone TEXT,
            platform TEXT NOT NULL,
            raw_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pois_unique 
        ON pois(name, platform, ROUND(lon, 5), ROUND(lat, 5))
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_name ON pois(name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_platform ON pois(platform)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_category ON pois(category)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_coords ON pois(lon, lat)")

    # API Key配置表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS api_keys (
            platform TEXT PRIMARY KEY,
            api_key TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # 全文搜索表
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS pois_fts USING fts5(
            name,
            address,
            category,
            content='pois',
            content_rowid='id',
            tokenize='unicode61'
        )
    """)

    conn.commit()
    conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="多平台POI采集器")
    parser.add_argument("--platform", "-p", choices=["tianditu", "amap", "baidu"], required=True)
    parser.add_argument("--api-key", "-k", required=True)
    parser.add_argument("--db", "-d", default="funing_poi.db")
    parser.add_argument("--rate", "-r", type=float, default=2.0)
    parser.add_argument("--no-resume", action="store_true")

    args = parser.parse_args()

    init_database(args.db)
    platform = Platform(args.platform)
    collector = create_collector(platform, args.api_key, args.db, args.rate)
    collector.collect_all(resume=not args.no_resume)
