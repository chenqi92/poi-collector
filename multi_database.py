#!/usr/bin/env python3
"""
多平台POI数据库查询模块
支持多种模糊查询和跨平台对比
"""
import sqlite3
import json
import math
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Union
from dataclasses import dataclass
from enum import Enum


class MatchMode(Enum):
    EXACT = "exact"
    PREFIX = "prefix"
    CONTAINS = "contains"
    FUZZY = "fuzzy"
    FULLTEXT = "fulltext"
    SMART = "smart"


class Platform(Enum):
    TIANDITU = "tianditu"
    AMAP = "amap"
    BAIDU = "baidu"
    ALL = "all"


@dataclass
class POIResult:
    id: int
    name: str
    lon: float
    lat: float
    original_lon: float
    original_lat: float
    category: str
    category_id: str
    address: str
    phone: str
    platform: str
    distance: float = 0.0
    score: float = 0.0

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "name": self.name,
            "lon": round(self.lon, 6),
            "lat": round(self.lat, 6),
            "original_lon": round(self.original_lon, 6),
            "original_lat": round(self.original_lat, 6),
            "category": self.category,
            "category_id": self.category_id,
            "address": self.address,
            "phone": self.phone,
            "platform": self.platform,
            "distance": round(self.distance, 2),
            "score": round(self.score, 3)
        }


class MultiPlatformDatabase:
    """多平台POI数据库"""

    def __init__(self, db_path: str = "funing_poi.db"):
        self.db_path = db_path
        self._ensure_database()

    def _ensure_database(self):
        """确保数据库存在并初始化"""
        conn = sqlite3.connect(self.db_path)
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name, platform, ROUND(lon, 5), ROUND(lat, 5))
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_name ON pois(name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_platform ON pois(platform)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_category ON pois(category)")

        # 旧表兼容性检查
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
        if cursor.fetchone():
            # 检查是否是旧结构（platform为主键）
            cursor.execute("PRAGMA table_info(api_keys)")
            columns = {row[1]: row for row in cursor.fetchall()}
            if 'id' not in columns:
                # 迁移旧数据到新表
                cursor.execute("ALTER TABLE api_keys RENAME TO api_keys_old")
                cursor.execute("""
                    CREATE TABLE api_keys (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        platform TEXT NOT NULL,
                        api_key TEXT NOT NULL,
                        name TEXT DEFAULT '',
                        is_active INTEGER DEFAULT 1,
                        quota_exhausted INTEGER DEFAULT 0,
                        last_used_at TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    INSERT INTO api_keys (platform, api_key, is_active)
                    SELECT platform, api_key, 1 FROM api_keys_old
                """)
                cursor.execute("DROP TABLE api_keys_old")
        else:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    api_key TEXT NOT NULL,
                    name TEXT DEFAULT '',
                    is_active INTEGER DEFAULT 1,
                    quota_exhausted INTEGER DEFAULT 0,
                    last_used_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform)")

        conn.commit()
        conn.close()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.create_function("calc_score", 2, self._calc_match_score)
        return conn

    @staticmethod
    def _calc_match_score(name: str, query: str) -> float:
        if not name or not query:
            return 0.0
        name_lower = name.lower()
        query_lower = query.lower()
        if name_lower == query_lower:
            return 1.0
        if name_lower.startswith(query_lower):
            return 0.9 - (len(name) - len(query)) * 0.01
        if query_lower in name_lower:
            pos = name_lower.find(query_lower)
            return 0.7 - pos * 0.01 - (len(name) - len(query)) * 0.005
        return 0.0

    def search(self, query: str, mode: MatchMode = MatchMode.SMART,
               platform: Platform = Platform.ALL, limit: int = 50,
               category: str = None) -> List[POIResult]:
        """搜索POI"""
        if mode == MatchMode.SMART:
            return self._smart_search(query, platform, limit, category)

        conn = self._get_connection()
        cursor = conn.cursor()

        sql_base = """
            SELECT id, name, lon, lat, original_lon, original_lat,
                   category, category_id, address, phone, platform,
                   calc_score(name, ?) as score
            FROM pois WHERE 1=1
        """
        params = [query]

        # 平台过滤
        if platform != Platform.ALL:
            sql_base += " AND platform = ?"
            params.append(platform.value)

        # 分类过滤
        if category:
            sql_base += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        # 匹配模式
        if mode == MatchMode.EXACT:
            sql_base += " AND name = ?"
            params.append(query)
        elif mode == MatchMode.PREFIX:
            sql_base += " AND name LIKE ?"
            params.append(f"{query}%")
        elif mode == MatchMode.CONTAINS:
            sql_base += " AND name LIKE ?"
            params.append(f"%{query}%")
        elif mode == MatchMode.FUZZY:
            pattern = query.replace("*", "%").replace("?", "_")
            if "%" not in pattern and "_" not in pattern:
                pattern = f"%{pattern}%"
            sql_base += " AND name LIKE ?"
            params.append(pattern)

        sql_base += " ORDER BY score DESC, length(name) LIMIT ?"
        params.append(limit)

        cursor.execute(sql_base, params)
        results = self._rows_to_results(cursor.fetchall())
        conn.close()
        return results

    def _smart_search(self, query: str, platform: Platform,
                      limit: int, category: str = None) -> List[POIResult]:
        """智能搜索"""
        results = []
        seen_ids = set()

        for mode, bonus in [(MatchMode.EXACT, 0.3), (MatchMode.PREFIX, 0.2),
                            (MatchMode.CONTAINS, 0.1)]:
            for r in self.search(query, mode, platform, limit, category):
                if r.id not in seen_ids:
                    r.score += bonus
                    results.append(r)
                    seen_ids.add(r.id)

        results.sort(key=lambda x: (-x.score, len(x.name)))
        return results[:limit]

    def compare_platforms(self, query: str, limit: int = 20) -> Dict[str, List[POIResult]]:
        """对比三个平台的搜索结果"""
        result = {}
        for platform in [Platform.TIANDITU, Platform.AMAP, Platform.BAIDU]:
            result[platform.value] = self.search(query, MatchMode.SMART, platform, limit)
        return result

    def get_stats(self, platform: Platform = Platform.ALL) -> Dict:
        """获取统计信息"""
        conn = self._get_connection()
        cursor = conn.cursor()

        if platform == Platform.ALL:
            cursor.execute("SELECT platform, COUNT(*) FROM pois GROUP BY platform")
            by_platform = dict(cursor.fetchall())

            cursor.execute("SELECT category, COUNT(*) FROM pois GROUP BY category ORDER BY COUNT(*) DESC")
            by_category = dict(cursor.fetchall())

            cursor.execute("SELECT COUNT(*) FROM pois")
            total = cursor.fetchone()[0]
        else:
            cursor.execute("SELECT COUNT(*) FROM pois WHERE platform = ?", (platform.value,))
            total = cursor.fetchone()[0]
            by_platform = {platform.value: total}

            cursor.execute("""
                SELECT category, COUNT(*) FROM pois
                WHERE platform = ? GROUP BY category ORDER BY COUNT(*) DESC
            """, (platform.value,))
            by_category = dict(cursor.fetchall())

        conn.close()
        return {
            "total": total,
            "by_platform": by_platform,
            "by_category": by_category
        }

    def get_categories(self, platform: Platform = Platform.ALL) -> List[Dict]:
        """获取分类列表"""
        conn = self._get_connection()
        cursor = conn.cursor()

        if platform == Platform.ALL:
            cursor.execute("""
                SELECT category, category_id, platform, COUNT(*) as count
                FROM pois GROUP BY category, category_id, platform
                ORDER BY count DESC
            """)
        else:
            cursor.execute("""
                SELECT category, category_id, platform, COUNT(*) as count
                FROM pois WHERE platform = ?
                GROUP BY category, category_id
                ORDER BY count DESC
            """, (platform.value,))

        results = [{"category": r[0], "category_id": r[1], "platform": r[2], "count": r[3]}
                   for r in cursor.fetchall()]
        conn.close()
        return results

    def get_pois_by_platform(self, platform: Platform, limit: int = 100,
                             offset: int = 0) -> Tuple[List[POIResult], int]:
        """获取指定平台的POI列表"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM pois WHERE platform = ?", (platform.value,))
        total = cursor.fetchone()[0]

        cursor.execute("""
            SELECT id, name, lon, lat, original_lon, original_lat,
                   category, category_id, address, phone, platform
            FROM pois WHERE platform = ?
            ORDER BY id DESC LIMIT ? OFFSET ?
        """, (platform.value, limit, offset))

        results = self._rows_to_results(cursor.fetchall())
        conn.close()
        return results, total

    def search_nearby(self, lon: float, lat: float, radius_km: float = 1.0,
                      platform: Platform = Platform.ALL,
                      limit: int = 50) -> List[POIResult]:
        """搜索附近POI"""
        conn = self._get_connection()
        cursor = conn.cursor()

        delta = radius_km / 111.0

        sql = """
            SELECT id, name, lon, lat, original_lon, original_lat,
                   category, category_id, address, phone, platform
            FROM pois
            WHERE lon BETWEEN ? AND ?
              AND lat BETWEEN ? AND ?
        """
        params = [lon - delta, lon + delta, lat - delta, lat + delta]

        if platform != Platform.ALL:
            sql += " AND platform = ?"
            params.append(platform.value)

        cursor.execute(sql, params)

        results = []
        for r in cursor.fetchall():
            dist = self._haversine_distance(lon, lat, r["lon"], r["lat"])
            if dist <= radius_km * 1000:
                poi = self._row_to_result(r)
                poi.distance = dist
                results.append(poi)

        conn.close()
        results.sort(key=lambda x: x.distance)
        return results[:limit]

    # API Key管理 - 支持多Key
    def add_api_key(self, platform: str, api_key: str, name: str = "") -> int:
        """添加API Key，返回key的ID"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO api_keys (platform, api_key, name, is_active, quota_exhausted, created_at, updated_at)
            VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))
        """, (platform, api_key, name))
        key_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return key_id

    def save_api_key(self, platform: str, api_key: str):
        """保存API Key（兼容旧接口，添加新key）"""
        self.add_api_key(platform, api_key)

    def update_api_key(self, key_id: int, api_key: str = None, name: str = None, is_active: bool = None):
        """更新API Key"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        updates = []
        params = []
        if api_key is not None:
            updates.append("api_key = ?")
            params.append(api_key)
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if is_active is not None:
            updates.append("is_active = ?")
            params.append(1 if is_active else 0)
        if updates:
            updates.append("updated_at = datetime('now')")
            params.append(key_id)
            cursor.execute(f"UPDATE api_keys SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()
        conn.close()

    def delete_api_key(self, key_id: int):
        """删除API Key"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        conn.commit()
        conn.close()

    def mark_key_exhausted(self, key_id: int):
        """标记Key配额已用尽"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE api_keys SET quota_exhausted = 1, updated_at = datetime('now')
            WHERE id = ?
        """, (key_id,))
        conn.commit()
        conn.close()

    def reset_key_quota(self, key_id: int):
        """重置Key配额状态"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE api_keys SET quota_exhausted = 0, updated_at = datetime('now')
            WHERE id = ?
        """, (key_id,))
        conn.commit()
        conn.close()

    def reset_all_key_quotas(self, platform: str = None):
        """重置所有Key的配额状态"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        if platform:
            cursor.execute("""
                UPDATE api_keys SET quota_exhausted = 0, updated_at = datetime('now')
                WHERE platform = ?
            """, (platform,))
        else:
            cursor.execute("UPDATE api_keys SET quota_exhausted = 0, updated_at = datetime('now')")
        conn.commit()
        conn.close()

    def get_api_key(self, platform: str) -> Optional[str]:
        """获取可用的API Key（优先使用未耗尽配额的）"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        # 优先获取未耗尽配额且激活的key
        cursor.execute("""
            SELECT api_key FROM api_keys
            WHERE platform = ? AND is_active = 1 AND quota_exhausted = 0
            ORDER BY last_used_at ASC NULLS FIRST
            LIMIT 1
        """, (platform,))
        row = cursor.fetchone()
        conn.close()
        return row[0] if row else None

    def get_api_key_with_id(self, platform: str) -> Optional[Tuple[int, str]]:
        """获取可用的API Key及其ID"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, api_key FROM api_keys
            WHERE platform = ? AND is_active = 1 AND quota_exhausted = 0
            ORDER BY last_used_at ASC NULLS FIRST
            LIMIT 1
        """, (platform,))
        row = cursor.fetchone()
        conn.close()
        return (row[0], row[1]) if row else None

    def get_next_api_key(self, platform: str, current_key_id: int) -> Optional[Tuple[int, str]]:
        """获取下一个可用的API Key（当前key配额耗尽时调用）"""
        # 先标记当前key配额已耗尽
        self.mark_key_exhausted(current_key_id)
        # 获取下一个可用key
        return self.get_api_key_with_id(platform)

    def update_key_last_used(self, key_id: int):
        """更新Key最后使用时间"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE api_keys SET last_used_at = datetime('now')
            WHERE id = ?
        """, (key_id,))
        conn.commit()
        conn.close()

    def get_platform_keys(self, platform: str) -> List[Dict]:
        """获取平台的所有API Key"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, platform, api_key, name, is_active, quota_exhausted, last_used_at, created_at
            FROM api_keys WHERE platform = ?
            ORDER BY created_at ASC
        """, (platform,))
        keys = []
        for row in cursor.fetchall():
            keys.append({
                "id": row[0],
                "platform": row[1],
                "api_key": row[2],
                "name": row[3] or "",
                "is_active": bool(row[4]),
                "quota_exhausted": bool(row[5]),
                "last_used_at": row[6],
                "created_at": row[7]
            })
        conn.close()
        return keys

    def get_all_api_keys(self) -> Dict[str, str]:
        """获取所有平台的首个可用API Key（兼容旧接口）"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT platform, api_key FROM api_keys
            WHERE is_active = 1
            GROUP BY platform
        """)
        keys = {row[0]: row[1] for row in cursor.fetchall()}
        conn.close()
        return keys

    def get_all_platform_keys(self) -> Dict[str, List[Dict]]:
        """获取所有平台的所有API Key"""
        result = {}
        for platform in ['tianditu', 'amap', 'baidu']:
            result[platform] = self.get_platform_keys(platform)
        return result

    def delete_pois_by_platform(self, platform: str) -> int:
        """删除指定平台的所有数据"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM pois WHERE platform = ?", (platform,))
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
        return deleted

    def _rows_to_results(self, rows) -> List[POIResult]:
        return [self._row_to_result(r) for r in rows]

    def _row_to_result(self, r) -> POIResult:
        return POIResult(
            id=r["id"],
            name=r["name"],
            lon=r["lon"],
            lat=r["lat"],
            original_lon=r["original_lon"] or r["lon"],
            original_lat=r["original_lat"] or r["lat"],
            category=r["category"] or "",
            category_id=r["category_id"] or "",
            address=r["address"] or "",
            phone=r["phone"] or "",
            platform=r["platform"],
            score=r["score"] if "score" in r.keys() else 0.0
        )

    @staticmethod
    def _haversine_distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        R = 6371000
        lat1_rad, lat2_rad = math.radians(lat1), math.radians(lat2)
        delta_lat = math.radians(lat2 - lat1)
        delta_lon = math.radians(lon2 - lon1)
        a = math.sin(delta_lat / 2) ** 2 + \
            math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c
