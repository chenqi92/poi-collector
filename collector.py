#!/usr/bin/env python3
"""
天地图POI数据采集器（增强版）
支持限流、断点续传、重试机制
"""
import requests
import json
import time
import sqlite3
import threading
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict, field
from datetime import datetime
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# 天地图API配置
TIANDITU_SEARCH_URL = "http://api.tianditu.gov.cn/v2/search"

# 阜宁县边界范围
FUNING_BOUNDS = {
    "min_lon": 119.45,
    "max_lon": 119.95,
    "min_lat": 33.55,
    "max_lat": 34.05
}

# 阜宁县行政区划代码
FUNING_ADMIN_CODE = "320923"

# POI采集类别配置
POI_CATEGORIES = [
    {"id": "residential", "name": "住宅小区", "keywords": ["小区", "花园", "家园", "公寓", "名苑", "雅苑", "新村", "嘉园", "名邸", "华府", "御府"]},
    {"id": "commercial", "name": "商业楼盘", "keywords": ["广场", "中心", "大厦", "商厦", "写字楼", "商城", "购物"]},
    {"id": "school", "name": "学校", "keywords": ["学校", "小学", "中学", "高中", "大学", "学院", "幼儿园", "实验学校"]},
    {"id": "hospital", "name": "医疗", "keywords": ["医院", "诊所", "卫生院", "社区卫生", "药店", "卫生室"]},
    {"id": "government", "name": "政府", "keywords": ["政府", "派出所", "公安局", "法院", "检察院", "街道办", "村委会", "居委会"]},
    {"id": "transport", "name": "交通", "keywords": ["汽车站", "火车站", "公交站", "停车场", "加油站", "收费站"]},
    {"id": "business", "name": "商业服务", "keywords": ["超市", "商场", "市场", "银行", "酒店", "宾馆", "饭店", "餐厅"]},
    {"id": "nature", "name": "自然地貌", "keywords": ["湖", "河", "公园", "景区", "森林", "湿地", "水库"]},
    {"id": "admin", "name": "行政区划", "keywords": ["镇", "乡", "村", "社区", "街道", "开发区"]},
    {"id": "landmark", "name": "地标建筑", "keywords": ["塔", "桥", "广场", "纪念", "体育馆", "图书馆", "文化馆"]},
]


class RateLimiter:
    """令牌桶限流器"""

    def __init__(self, requests_per_second: float = 2.0, burst: int = 5):
        """
        初始化限流器

        Args:
            requests_per_second: 每秒请求数
            burst: 突发请求上限
        """
        self.rate = requests_per_second
        self.burst = burst
        self.tokens = burst
        self.last_update = time.time()
        self.lock = threading.Lock()

    def acquire(self, timeout: float = 30.0) -> bool:
        """
        获取一个令牌

        Args:
            timeout: 最大等待时间(秒)

        Returns:
            是否成功获取令牌
        """
        start_time = time.time()

        while True:
            with self.lock:
                now = time.time()
                # 补充令牌
                elapsed = now - self.last_update
                self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
                self.last_update = now

                if self.tokens >= 1:
                    self.tokens -= 1
                    return True

            # 检查超时
            if time.time() - start_time > timeout:
                return False

            # 等待令牌补充
            time.sleep(0.1)

    def wait(self):
        """等待并获取令牌"""
        while not self.acquire():
            time.sleep(0.1)


@dataclass
class CollectorProgress:
    """采集进度"""
    started_at: str = ""
    last_updated: str = ""
    current_category_id: str = ""
    current_keyword_index: int = 0
    current_page: int = 1
    completed_categories: List[str] = field(default_factory=list)
    total_collected: int = 0
    failed_requests: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> 'CollectorProgress':
        return cls(**data)


@dataclass
class POI:
    """POI数据结构"""
    name: str
    lon: float
    lat: float
    category: str
    category_id: str = ""
    address: str = ""
    phone: str = ""
    source: str = "tianditu"
    raw_data: str = ""


class TianDiTuCollector:
    """天地图POI采集器（增强版）"""

    def __init__(self, api_key: str, db_path: str = "funing_poi.db",
                 progress_file: str = "collector_progress.json",
                 requests_per_second: float = 2.0):
        """
        初始化采集器

        Args:
            api_key: 天地图API Key
            db_path: 数据库文件路径
            progress_file: 进度文件路径
            requests_per_second: 每秒最大请求数
        """
        self.api_key = api_key
        self.db_path = db_path
        self.progress_file = progress_file
        self.session = requests.Session()
        self.rate_limiter = RateLimiter(requests_per_second, burst=5)
        self.max_retries = 3
        self.retry_delay = 2.0

        self._init_database()

    def _init_database(self):
        """初始化SQLite数据库"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        # 主表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS pois (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                lon REAL NOT NULL,
                lat REAL NOT NULL,
                category TEXT,
                category_id TEXT,
                address TEXT,
                phone TEXT,
                source TEXT DEFAULT 'tianditu',
                raw_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name, lon, lat)
            )
        """)

        # 索引
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_name ON pois(name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_category ON pois(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_category_id ON pois(category_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_coords ON pois(lon, lat)")

        # 全文搜索表 (支持中文模糊查询)
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

        # 触发器：自动同步FTS索引
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS pois_ai AFTER INSERT ON pois BEGIN
                INSERT INTO pois_fts(rowid, name, address, category)
                VALUES (new.id, new.name, new.address, new.category);
            END
        """)

        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS pois_ad AFTER DELETE ON pois BEGIN
                INSERT INTO pois_fts(pois_fts, rowid, name, address, category)
                VALUES ('delete', old.id, old.name, old.address, old.category);
            END
        """)

        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS pois_au AFTER UPDATE ON pois BEGIN
                INSERT INTO pois_fts(pois_fts, rowid, name, address, category)
                VALUES ('delete', old.id, old.name, old.address, old.category);
                INSERT INTO pois_fts(rowid, name, address, category)
                VALUES (new.id, new.name, new.address, new.category);
            END
        """)

        conn.commit()
        conn.close()
        logger.info(f"数据库初始化完成: {self.db_path}")

    def _load_progress(self) -> CollectorProgress:
        """加载采集进度"""
        if Path(self.progress_file).exists():
            try:
                with open(self.progress_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    return CollectorProgress.from_dict(data)
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"进度文件损坏，将重新开始: {e}")

        return CollectorProgress(started_at=datetime.now().isoformat())

    def _save_progress(self, progress: CollectorProgress):
        """保存采集进度"""
        progress.last_updated = datetime.now().isoformat()
        with open(self.progress_file, 'w', encoding='utf-8') as f:
            json.dump(progress.to_dict(), f, ensure_ascii=False, indent=2)

    def _request_with_retry(self, params: Dict) -> Optional[Dict]:
        """
        带重试的请求

        Args:
            params: 请求参数

        Returns:
            响应数据，失败返回None
        """
        for attempt in range(self.max_retries):
            # 限流等待
            self.rate_limiter.wait()

            try:
                response = self.session.get(
                    TIANDITU_SEARCH_URL,
                    params=params,
                    timeout=30
                )
                response.raise_for_status()
                data = response.json()

                # 检查API返回状态
                status = data.get("status", {})
                if status.get("infocode") == 1000:
                    return data
                else:
                    error_msg = status.get("msg", "未知错误")
                    logger.warning(f"API返回错误: {error_msg}")

                    # 如果是超出限制，等待更长时间
                    if "limit" in error_msg.lower() or "频率" in error_msg:
                        wait_time = self.retry_delay * (attempt + 2)
                        logger.info(f"触发限流，等待 {wait_time}秒...")
                        time.sleep(wait_time)
                        continue

                    return None

            except requests.Timeout:
                logger.warning(f"请求超时 (尝试 {attempt + 1}/{self.max_retries})")
            except requests.RequestException as e:
                logger.warning(f"请求错误: {e} (尝试 {attempt + 1}/{self.max_retries})")

            if attempt < self.max_retries - 1:
                wait_time = self.retry_delay * (attempt + 1)
                logger.info(f"等待 {wait_time}秒后重试...")
                time.sleep(wait_time)

        return None

    def search_poi(self, keyword: str, page: int = 1, count: int = 100) -> List[Dict]:
        """
        搜索POI

        Args:
            keyword: 搜索关键词
            page: 页码
            count: 每页数量

        Returns:
            POI列表
        """
        params = {
            "postStr": json.dumps({
                "keyWord": keyword,
                "level": 12,
                "mapBound": f"{FUNING_BOUNDS['min_lon']},{FUNING_BOUNDS['min_lat']},{FUNING_BOUNDS['max_lon']},{FUNING_BOUNDS['max_lat']}",
                "queryType": 1,
                "start": (page - 1) * count,
                "count": count,
                "specify": FUNING_ADMIN_CODE
            }),
            "type": "query",
            "tk": self.api_key
        }

        data = self._request_with_retry(params)
        if data:
            return data.get("pois", [])
        return []

    def parse_poi(self, raw_poi: Dict, category: str, category_id: str) -> Optional[POI]:
        """解析天地图POI数据"""
        try:
            lonlat = raw_poi.get("lonlat", "").split(",")
            if len(lonlat) != 2:
                return None

            lon, lat = float(lonlat[0]), float(lonlat[1])

            # 验证坐标范围
            if not (FUNING_BOUNDS["min_lon"] <= lon <= FUNING_BOUNDS["max_lon"] and
                    FUNING_BOUNDS["min_lat"] <= lat <= FUNING_BOUNDS["max_lat"]):
                return None

            name = raw_poi.get("name", "").strip()
            if not name:
                return None

            return POI(
                name=name,
                lon=lon,
                lat=lat,
                category=category,
                category_id=category_id,
                address=raw_poi.get("address", ""),
                phone=raw_poi.get("phone", ""),
                raw_data=json.dumps(raw_poi, ensure_ascii=False)
            )
        except (ValueError, KeyError) as e:
            logger.debug(f"解析POI失败: {e}")
            return None

    def save_pois(self, pois: List[POI]) -> int:
        """保存POI到数据库"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        saved_count = 0

        for poi in pois:
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO pois
                    (name, lon, lat, category, category_id, address, phone, source, raw_data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (poi.name, poi.lon, poi.lat, poi.category, poi.category_id,
                      poi.address, poi.phone, poi.source, poi.raw_data))

                if cursor.rowcount > 0:
                    saved_count += 1
            except sqlite3.Error as e:
                logger.debug(f"保存失败 {poi.name}: {e}")

        conn.commit()
        conn.close()
        return saved_count

    def collect_all(self, resume: bool = True) -> int:
        """
        采集所有POI数据

        Args:
            resume: 是否从断点续传

        Returns:
            采集总数
        """
        # 加载或初始化进度
        if resume:
            progress = self._load_progress()
            if progress.current_category_id:
                logger.info(f"从断点恢复: 类别={progress.current_category_id}, "
                           f"关键词索引={progress.current_keyword_index}, 页码={progress.current_page}")
        else:
            progress = CollectorProgress(started_at=datetime.now().isoformat())
            # 清空进度文件
            if Path(self.progress_file).exists():
                Path(self.progress_file).unlink()

        logger.info("=" * 60)
        logger.info("开始采集阜宁县POI数据")
        logger.info(f"限流配置: {self.rate_limiter.rate} 请求/秒")
        logger.info("=" * 60)

        # 找到恢复点
        start_category_idx = 0
        if progress.current_category_id:
            for i, cat in enumerate(POI_CATEGORIES):
                if cat["id"] == progress.current_category_id:
                    start_category_idx = i
                    break

        try:
            for cat_idx in range(start_category_idx, len(POI_CATEGORIES)):
                cat_info = POI_CATEGORIES[cat_idx]
                cat_id = cat_info["id"]
                cat_name = cat_info["name"]
                keywords = cat_info["keywords"]

                # 跳过已完成的类别
                if cat_id in progress.completed_categories:
                    continue

                logger.info(f"\n[{cat_name}] 开始采集 ({cat_idx + 1}/{len(POI_CATEGORIES)})")
                cat_count = 0

                # 确定关键词起始位置
                start_kw_idx = 0
                if cat_id == progress.current_category_id:
                    start_kw_idx = progress.current_keyword_index

                for kw_idx in range(start_kw_idx, len(keywords)):
                    keyword = keywords[kw_idx]
                    logger.info(f"  搜索: {keyword}")

                    # 确定页码起始位置
                    start_page = 1
                    if (cat_id == progress.current_category_id and
                        kw_idx == progress.current_keyword_index):
                        start_page = progress.current_page

                    page = start_page
                    while True:
                        # 更新进度
                        progress.current_category_id = cat_id
                        progress.current_keyword_index = kw_idx
                        progress.current_page = page
                        self._save_progress(progress)

                        # 请求数据
                        raw_pois = self.search_poi(keyword, page=page)

                        if not raw_pois:
                            break

                        # 解析并保存
                        pois = []
                        for raw in raw_pois:
                            poi = self.parse_poi(raw, cat_name, cat_id)
                            if poi:
                                pois.append(poi)

                        if pois:
                            saved = self.save_pois(pois)
                            cat_count += saved
                            progress.total_collected += saved
                            logger.info(f"    第{page}页: 获取{len(raw_pois)}条, 新增{saved}条")

                        # 检查是否是最后一页
                        if len(raw_pois) < 100:
                            break

                        page += 1

                # 标记类别完成
                progress.completed_categories.append(cat_id)
                progress.current_keyword_index = 0
                progress.current_page = 1
                self._save_progress(progress)

                logger.info(f"[{cat_name}] 完成，新增 {cat_count} 条")

        except KeyboardInterrupt:
            logger.info("\n用户中断，进度已保存")
            self._save_progress(progress)
            raise

        logger.info("\n" + "=" * 60)
        logger.info(f"采集完成！总计新增 {progress.total_collected} 条POI数据")
        logger.info(f"数据保存在: {self.db_path}")
        logger.info("=" * 60)

        # 清理进度文件
        if Path(self.progress_file).exists():
            Path(self.progress_file).unlink()
            logger.info("进度文件已清理")

        return progress.total_collected

    def collect_keywords(self, keywords: List[str], category: str = "自定义",
                         category_id: str = "custom") -> int:
        """采集指定关键词"""
        total = 0
        for keyword in keywords:
            logger.info(f"搜索: {keyword}")
            page = 1
            while True:
                raw_pois = self.search_poi(keyword, page=page)
                if not raw_pois:
                    break

                pois = [self.parse_poi(r, category, category_id) for r in raw_pois]
                pois = [p for p in pois if p]

                if pois:
                    saved = self.save_pois(pois)
                    total += saved
                    logger.info(f"  第{page}页: 获取{len(raw_pois)}条, 新增{saved}条")

                if len(raw_pois) < 100:
                    break
                page += 1

        return total

    def get_stats(self) -> Dict:
        """获取统计信息"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM pois")
        total = cursor.fetchone()[0]

        cursor.execute("SELECT category, COUNT(*) FROM pois GROUP BY category ORDER BY COUNT(*) DESC")
        by_category = cursor.fetchall()

        conn.close()

        return {
            "total": total,
            "by_category": dict(by_category)
        }


def main():
    import argparse

    parser = argparse.ArgumentParser(description="阜宁县POI数据采集器（支持限流和断点续传）")
    parser.add_argument("--api-key", "-k", required=True, help="天地图API Key")
    parser.add_argument("--db", "-d", default="funing_poi.db", help="数据库文件路径")
    parser.add_argument("--rate", "-r", type=float, default=2.0, help="每秒最大请求数")
    parser.add_argument("--keywords", "-w", nargs="+", help="自定义搜索关键词")
    parser.add_argument("--no-resume", action="store_true", help="不从断点恢复，重新开始")
    parser.add_argument("--stats", action="store_true", help="只显示统计信息")

    args = parser.parse_args()

    collector = TianDiTuCollector(
        api_key=args.api_key,
        db_path=args.db,
        requests_per_second=args.rate
    )

    if args.stats:
        stats = collector.get_stats()
        print(f"\n数据库统计:")
        print(f"  总数: {stats['total']}")
        print(f"  分类:")
        for cat, count in stats['by_category'].items():
            print(f"    - {cat}: {count}")
        return

    try:
        if args.keywords:
            collector.collect_keywords(args.keywords)
        else:
            collector.collect_all(resume=not args.no_resume)
    except KeyboardInterrupt:
        print("\n采集已中断，可使用相同命令继续")


if __name__ == "__main__":
    main()
