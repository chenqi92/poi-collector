#!/usr/bin/env python3
"""
POI数据库查询模块（增强版）
支持多种模糊查询方式：精确匹配、前缀匹配、包含匹配、全文搜索
"""
import sqlite3
import json
import math
import re
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Union
from dataclasses import dataclass
from enum import Enum


class MatchMode(Enum):
    """匹配模式"""
    EXACT = "exact"          # 精确匹配
    PREFIX = "prefix"        # 前缀匹配 (名称以关键词开头)
    CONTAINS = "contains"    # 包含匹配 (名称包含关键词)
    FUZZY = "fuzzy"          # 模糊匹配 (支持通配符)
    FULLTEXT = "fulltext"    # 全文搜索 (FTS5)
    SMART = "smart"          # 智能匹配 (自动选择最佳策略)


@dataclass
class POIResult:
    """POI查询结果"""
    id: int
    name: str
    lon: float
    lat: float
    category: str
    category_id: str
    address: str
    distance: float = 0.0
    score: float = 0.0  # 匹配得分

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "name": self.name,
            "lon": self.lon,
            "lat": self.lat,
            "category": self.category,
            "category_id": self.category_id,
            "address": self.address,
            "distance": round(self.distance, 2),
            "score": round(self.score, 3)
        }

    def to_wgs84(self) -> Tuple[float, float]:
        """返回WGS84坐标 (经度, 纬度)"""
        return (self.lon, self.lat)

    def __str__(self):
        return f"{self.name} ({self.lon:.6f}, {self.lat:.6f}) [{self.category}]"


class POIDatabase:
    """POI数据库查询接口（增强版）"""

    def __init__(self, db_path: str = "funing_poi.db"):
        self.db_path = db_path
        if not Path(db_path).exists():
            raise FileNotFoundError(f"数据库文件不存在: {db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # 注册自定义函数
        conn.create_function("calc_score", 2, self._calc_match_score)
        return conn

    @staticmethod
    def _calc_match_score(name: str, query: str) -> float:
        """计算匹配得分"""
        if not name or not query:
            return 0.0

        name_lower = name.lower()
        query_lower = query.lower()

        # 精确匹配得分最高
        if name_lower == query_lower:
            return 1.0

        # 前缀匹配
        if name_lower.startswith(query_lower):
            return 0.9 - (len(name) - len(query)) * 0.01

        # 包含匹配
        if query_lower in name_lower:
            pos = name_lower.find(query_lower)
            # 越靠前得分越高
            return 0.7 - pos * 0.01 - (len(name) - len(query)) * 0.005

        return 0.0

    def search(self, query: str, mode: Union[MatchMode, str] = MatchMode.SMART,
               limit: int = 20, category: str = None) -> List[POIResult]:
        """
        通用搜索接口

        Args:
            query: 搜索关键词
            mode: 匹配模式
            limit: 返回结果数量限制
            category: 可选的分类过滤

        Returns:
            POI结果列表
        """
        if isinstance(mode, str):
            mode = MatchMode(mode)

        if mode == MatchMode.SMART:
            return self._smart_search(query, limit, category)
        elif mode == MatchMode.EXACT:
            return self._exact_search(query, limit, category)
        elif mode == MatchMode.PREFIX:
            return self._prefix_search(query, limit, category)
        elif mode == MatchMode.CONTAINS:
            return self._contains_search(query, limit, category)
        elif mode == MatchMode.FUZZY:
            return self._fuzzy_search(query, limit, category)
        elif mode == MatchMode.FULLTEXT:
            return self._fulltext_search(query, limit, category)
        else:
            return self._smart_search(query, limit, category)

    def _smart_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """
        智能搜索：自动选择最佳匹配策略

        策略：
        1. 先尝试精确匹配
        2. 再尝试前缀匹配
        3. 然后包含匹配
        4. 最后全文搜索
        5. 合并结果并去重，按得分排序
        """
        results = []
        seen_ids = set()

        # 1. 精确匹配 (得分加成 +0.3)
        for r in self._exact_search(query, limit, category):
            if r.id not in seen_ids:
                r.score += 0.3
                results.append(r)
                seen_ids.add(r.id)

        # 2. 前缀匹配 (得分加成 +0.2)
        for r in self._prefix_search(query, limit, category):
            if r.id not in seen_ids:
                r.score += 0.2
                results.append(r)
                seen_ids.add(r.id)

        # 3. 包含匹配 (得分加成 +0.1)
        for r in self._contains_search(query, limit * 2, category):
            if r.id not in seen_ids:
                r.score += 0.1
                results.append(r)
                seen_ids.add(r.id)

        # 4. 全文搜索 (无加成)
        if len(results) < limit:
            for r in self._fulltext_search(query, limit, category):
                if r.id not in seen_ids:
                    results.append(r)
                    seen_ids.add(r.id)

        # 按得分排序
        results.sort(key=lambda x: (-x.score, len(x.name)))
        return results[:limit]

    def _exact_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """精确匹配"""
        conn = self._get_connection()
        cursor = conn.cursor()

        sql = "SELECT id, name, lon, lat, category, category_id, address FROM pois WHERE name = ?"
        params = [query]

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        sql += " LIMIT ?"
        params.append(limit)

        cursor.execute(sql, params)
        results = self._rows_to_results(cursor.fetchall(), query)
        conn.close()
        return results

    def _prefix_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """前缀匹配"""
        conn = self._get_connection()
        cursor = conn.cursor()

        sql = """
            SELECT id, name, lon, lat, category, category_id, address
            FROM pois
            WHERE name LIKE ? AND name != ?
        """
        params = [f"{query}%", query]

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        sql += " ORDER BY length(name) LIMIT ?"
        params.append(limit)

        cursor.execute(sql, params)
        results = self._rows_to_results(cursor.fetchall(), query)
        conn.close()
        return results

    def _contains_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """包含匹配"""
        conn = self._get_connection()
        cursor = conn.cursor()

        sql = """
            SELECT id, name, lon, lat, category, category_id, address,
                   calc_score(name, ?) as score
            FROM pois
            WHERE name LIKE ? AND name NOT LIKE ?
        """
        params = [query, f"%{query}%", f"{query}%"]

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        sql += " ORDER BY score DESC, length(name) LIMIT ?"
        params.append(limit)

        cursor.execute(sql, params)
        results = self._rows_to_results(cursor.fetchall(), query)
        conn.close()
        return results

    def _fuzzy_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """
        模糊匹配（支持通配符）

        通配符:
        - * 或 % : 匹配任意字符
        - ? 或 _ : 匹配单个字符
        """
        # 转换通配符
        pattern = query.replace("*", "%").replace("?", "_")
        if "%" not in pattern and "_" not in pattern:
            pattern = f"%{pattern}%"

        conn = self._get_connection()
        cursor = conn.cursor()

        sql = """
            SELECT id, name, lon, lat, category, category_id, address
            FROM pois
            WHERE name LIKE ?
        """
        params = [pattern]

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        sql += " ORDER BY length(name) LIMIT ?"
        params.append(limit)

        cursor.execute(sql, params)
        results = self._rows_to_results(cursor.fetchall(), query)
        conn.close()
        return results

    def _fulltext_search(self, query: str, limit: int, category: str = None) -> List[POIResult]:
        """全文搜索（FTS5）"""
        conn = self._get_connection()
        cursor = conn.cursor()

        try:
            if category:
                sql = """
                    SELECT p.id, p.name, p.lon, p.lat, p.category, p.category_id, p.address
                    FROM pois p
                    JOIN pois_fts fts ON p.id = fts.rowid
                    WHERE pois_fts MATCH ?
                      AND (p.category LIKE ? OR p.category_id = ?)
                    ORDER BY rank
                    LIMIT ?
                """
                params = [query, f"%{category}%", category, limit]
            else:
                sql = """
                    SELECT p.id, p.name, p.lon, p.lat, p.category, p.category_id, p.address
                    FROM pois p
                    JOIN pois_fts fts ON p.id = fts.rowid
                    WHERE pois_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                """
                params = [query, limit]

            cursor.execute(sql, params)
            results = self._rows_to_results(cursor.fetchall(), query)

        except sqlite3.OperationalError:
            # FTS表可能不存在，回退到包含搜索
            results = self._contains_search(query, limit, category)

        conn.close()
        return results

    def search_by_name(self, name: str, limit: int = 10) -> List[POIResult]:
        """按名称搜索（智能匹配）"""
        return self.search(name, MatchMode.SMART, limit)

    def search_by_category(self, category: str, limit: int = 100) -> List[POIResult]:
        """按分类搜索"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT id, name, lon, lat, category, category_id, address
            FROM pois
            WHERE category LIKE ? OR category_id = ?
            ORDER BY name
            LIMIT ?
        """, (f"%{category}%", category, limit))

        results = self._rows_to_results(cursor.fetchall())
        conn.close()
        return results

    def search_nearby(self, lon: float, lat: float, radius_km: float = 1.0,
                      limit: int = 20, category: str = None) -> List[POIResult]:
        """
        搜索附近地点

        Args:
            lon: 经度
            lat: 纬度
            radius_km: 搜索半径(公里)
            limit: 返回数量限制
            category: 可选的分类过滤

        Returns:
            按距离排序的POI列表
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        # 矩形范围过滤
        delta = radius_km / 111.0

        sql = """
            SELECT id, name, lon, lat, category, category_id, address
            FROM pois
            WHERE lon BETWEEN ? AND ?
              AND lat BETWEEN ? AND ?
        """
        params = [lon - delta, lon + delta, lat - delta, lat + delta]

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        cursor.execute(sql, params)

        results = []
        for r in cursor.fetchall():
            dist = self._haversine_distance(lon, lat, r["lon"], r["lat"])
            if dist <= radius_km * 1000:
                poi = POIResult(
                    id=r["id"],
                    name=r["name"],
                    lon=r["lon"],
                    lat=r["lat"],
                    category=r["category"],
                    category_id=r["category_id"] or "",
                    address=r["address"] or "",
                    distance=dist
                )
                results.append(poi)

        conn.close()

        results.sort(key=lambda x: x.distance)
        return results[:limit]

    def get_coordinates(self, name: str) -> Optional[Tuple[float, float]]:
        """获取地点坐标"""
        results = self.search(name, MatchMode.SMART, limit=1)
        if results:
            return results[0].to_wgs84()
        return None

    def get_all_categories(self) -> List[Tuple[str, str, int]]:
        """获取所有分类: (category, category_id, count)"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT category, category_id, COUNT(*) as count
            FROM pois
            GROUP BY category, category_id
            ORDER BY count DESC
        """)

        results = [(r["category"], r["category_id"] or "", r["count"]) for r in cursor.fetchall()]
        conn.close()
        return results

    def get_total_count(self) -> int:
        """获取POI总数"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM pois")
        count = cursor.fetchone()[0]
        conn.close()
        return count

    def export_geojson(self, output_path: str, category: str = None, query: str = None):
        """导出为GeoJSON格式"""
        conn = self._get_connection()
        cursor = conn.cursor()

        sql = "SELECT id, name, lon, lat, category, category_id, address FROM pois WHERE 1=1"
        params = []

        if category:
            sql += " AND (category LIKE ? OR category_id = ?)"
            params.extend([f"%{category}%", category])

        if query:
            sql += " AND name LIKE ?"
            params.append(f"%{query}%")

        cursor.execute(sql, params)

        features = []
        for r in cursor.fetchall():
            features.append({
                "type": "Feature",
                "properties": {
                    "id": r["id"],
                    "name": r["name"],
                    "category": r["category"],
                    "category_id": r["category_id"],
                    "address": r["address"]
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [r["lon"], r["lat"]]
                }
            })

        conn.close()

        geojson = {
            "type": "FeatureCollection",
            "features": features
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, ensure_ascii=False, indent=2)

        print(f"已导出 {len(features)} 条数据到 {output_path}")

    def _rows_to_results(self, rows, query: str = "") -> List[POIResult]:
        """将数据库行转换为POIResult列表"""
        results = []
        for r in rows:
            score = self._calc_match_score(r["name"], query) if query else 0.0
            results.append(POIResult(
                id=r["id"],
                name=r["name"],
                lon=r["lon"],
                lat=r["lat"],
                category=r["category"] or "",
                category_id=r["category_id"] or "",
                address=r["address"] or "",
                score=score
            ))
        return results

    @staticmethod
    def _haversine_distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        """计算两点距离（米）"""
        R = 6371000
        lat1_rad, lat2_rad = math.radians(lat1), math.radians(lat2)
        delta_lat = math.radians(lat2 - lat1)
        delta_lon = math.radians(lon2 - lon1)

        a = math.sin(delta_lat / 2) ** 2 + \
            math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c


def main():
    """命令行查询工具"""
    import argparse

    parser = argparse.ArgumentParser(description="阜宁县POI查询工具（支持多种模糊匹配）")
    parser.add_argument("--db", "-d", default="funing_poi.db", help="数据库文件路径")
    parser.add_argument("--search", "-s", help="搜索地点名称")
    parser.add_argument("--mode", "-m", choices=["exact", "prefix", "contains", "fuzzy", "fulltext", "smart"],
                        default="smart", help="匹配模式")
    parser.add_argument("--category", "-c", help="按分类过滤")
    parser.add_argument("--nearby", "-n", nargs=2, type=float, metavar=("LON", "LAT"),
                        help="搜索附近地点")
    parser.add_argument("--radius", "-r", type=float, default=1.0, help="搜索半径(公里)")
    parser.add_argument("--limit", "-l", type=int, default=20, help="返回结果数量")
    parser.add_argument("--export", "-e", help="导出到GeoJSON文件")
    parser.add_argument("--stats", action="store_true", help="显示统计信息")

    args = parser.parse_args()

    try:
        db = POIDatabase(args.db)
    except FileNotFoundError as e:
        print(f"错误: {e}")
        print("请先运行 collector.py 采集数据")
        return

    if args.stats:
        print(f"POI总数: {db.get_total_count()}")
        print("\n分类统计:")
        for cat, cat_id, count in db.get_all_categories():
            print(f"  {cat} ({cat_id}): {count}")

    elif args.search:
        mode = MatchMode(args.mode)
        results = db.search(args.search, mode, args.limit, args.category)

        if results:
            print(f"\n找到 {len(results)} 个结果 (模式: {args.mode}):")
            for i, poi in enumerate(results, 1):
                print(f"\n  {i}. {poi.name}")
                print(f"     坐标: ({poi.lon:.6f}, {poi.lat:.6f})")
                print(f"     分类: {poi.category}")
                print(f"     得分: {poi.score:.3f}")
                if poi.address:
                    print(f"     地址: {poi.address}")
        else:
            print("未找到匹配的地点")

    elif args.nearby:
        lon, lat = args.nearby
        results = db.search_nearby(lon, lat, args.radius, args.limit, args.category)
        print(f"\n在 ({lon}, {lat}) 附近 {args.radius}km 内找到 {len(results)} 个地点:")
        for poi in results:
            print(f"  {poi.name} - {poi.distance:.0f}m [{poi.category}]")

    elif args.export:
        db.export_geojson(args.export, args.category)

    elif args.category:
        results = db.search_by_category(args.category, args.limit)
        print(f"\n找到 {len(results)} 个 [{args.category}] 类别的地点:")
        for poi in results[:20]:
            print(f"  {poi}")
        if len(results) > 20:
            print(f"  ... 还有 {len(results) - 20} 个")

    else:
        # 交互模式
        print("=" * 50)
        print("阜宁县POI查询系统（支持多种模糊匹配）")
        print(f"数据库: {args.db}")
        print(f"POI总数: {db.get_total_count()}")
        print("=" * 50)
        print("命令:")
        print("  直接输入名称 - 智能搜索")
        print("  :exact 名称 - 精确匹配")
        print("  :prefix 名称 - 前缀匹配")
        print("  :fuzzy 模式 - 模糊匹配 (支持 * 和 ? 通配符)")
        print("  q - 退出")
        print()

        while True:
            query = input("查询> ").strip()
            if query.lower() == 'q':
                break
            if not query:
                continue

            # 解析命令
            mode = MatchMode.SMART
            if query.startswith(":"):
                parts = query.split(" ", 1)
                if len(parts) == 2:
                    cmd, query = parts
                    cmd = cmd[1:].lower()
                    if cmd in ["exact", "prefix", "contains", "fuzzy", "fulltext"]:
                        mode = MatchMode(cmd)
                else:
                    print("格式: :命令 关键词")
                    continue

            results = db.search(query, mode, 10)
            if results:
                print(f"\n找到 {len(results)} 个结果 (模式: {mode.value}):")
                for i, poi in enumerate(results, 1):
                    print(f"  {i}. {poi.name}")
                    print(f"     坐标: ({poi.lon:.6f}, {poi.lat:.6f})")
                    print(f"     分类: {poi.category} | 得分: {poi.score:.3f}")
                print()
            else:
                print("未找到匹配的地点\n")


if __name__ == "__main__":
    main()
