#!/usr/bin/env python3
"""
无人机导航客户端
演示如何使用POI查询服务获取目标位置坐标
"""
import requests
import math
from typing import Optional, Tuple, List, Dict


class DroneNavigator:
    """无人机导航器 - POI查询客户端"""

    def __init__(self, service_url: str = "http://localhost:8080"):
        """
        初始化导航器

        Args:
            service_url: POI查询服务地址
        """
        self.service_url = service_url.rstrip("/")
        self.session = requests.Session()
        self.timeout = 10

    def get_coordinates(self, location_name: str,
                        mode: str = "smart") -> Optional[Tuple[float, float]]:
        """
        根据地点名称获取目标坐标

        Args:
            location_name: 地点名称，如 "清华名仕园"、"金沙湖小区"
            mode: 匹配模式 [smart|exact|prefix|contains|fuzzy]

        Returns:
            (经度, 纬度) 元组，未找到返回 None
        """
        try:
            response = self.session.get(
                f"{self.service_url}/coordinates",
                params={"name": location_name},
                timeout=self.timeout
            )
            data = response.json()

            if data.get("success"):
                coords = data["coordinates"]
                print(f"找到: {data['matched_name']} (匹配度: {data.get('score', 0):.2f})")
                return (coords["lon"], coords["lat"])
            else:
                print(f"未找到: {location_name}")
                if data.get("suggestions"):
                    print(f"您是否要找: {', '.join(data['suggestions'][:5])}")
                return None

        except requests.RequestException as e:
            print(f"查询服务错误: {e}")
            return None

    def search(self, keyword: str, mode: str = "smart",
               limit: int = 10) -> List[Dict]:
        """
        搜索地点

        Args:
            keyword: 搜索关键词
            mode: 匹配模式
            limit: 返回数量

        Returns:
            地点列表
        """
        try:
            response = self.session.get(
                f"{self.service_url}/search",
                params={"q": keyword, "mode": mode, "limit": limit},
                timeout=self.timeout
            )
            data = response.json()
            return data.get("results", [])
        except requests.RequestException as e:
            print(f"搜索错误: {e}")
            return []

    def find_nearby(self, lon: float, lat: float,
                    radius_km: float = 1.0,
                    category: str = None) -> List[Dict]:
        """
        搜索当前位置附近的地点

        Args:
            lon: 当前经度
            lat: 当前纬度
            radius_km: 搜索半径(公里)
            category: 分类过滤

        Returns:
            附近地点列表（按距离排序）
        """
        try:
            params = {"lon": lon, "lat": lat, "radius": radius_km}
            if category:
                params["category"] = category

            response = self.session.get(
                f"{self.service_url}/nearby",
                params=params,
                timeout=self.timeout
            )
            data = response.json()
            return data.get("results", [])
        except requests.RequestException as e:
            print(f"附近搜索错误: {e}")
            return []

    def check_service(self) -> bool:
        """检查服务是否可用"""
        try:
            response = self.session.get(
                f"{self.service_url}/health",
                timeout=5
            )
            return response.json().get("success", False)
        except:
            return False


def calculate_flight_info(start: Tuple[float, float],
                          end: Tuple[float, float]) -> Dict:
    """
    计算飞行信息

    Args:
        start: 起点 (经度, 纬度)
        end: 终点 (经度, 纬度)

    Returns:
        飞行信息字典
    """
    R = 6371000  # 地球半径(米)

    lat1, lat2 = math.radians(start[1]), math.radians(end[1])
    delta_lat = math.radians(end[1] - start[1])
    delta_lon = math.radians(end[0] - start[0])

    # Haversine 距离
    a = math.sin(delta_lat / 2) ** 2 + \
        math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    distance = R * c

    # 方位角
    y = math.sin(delta_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - \
        math.sin(lat1) * math.cos(lat2) * math.cos(delta_lon)
    bearing = math.degrees(math.atan2(y, x))
    bearing = (bearing + 360) % 360

    # 方向描述
    directions = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
    direction = directions[int((bearing + 22.5) / 45) % 8]

    return {
        "distance_m": round(distance, 1),
        "bearing_deg": round(bearing, 1),
        "direction": direction,
        "start": {"lon": start[0], "lat": start[1]},
        "end": {"lon": end[0], "lat": end[1]}
    }


def demo():
    """演示无人机导航流程"""
    print("=" * 60)
    print("无人机导航系统 - POI查询演示")
    print("=" * 60)

    navigator = DroneNavigator("http://localhost:8080")

    # 检查服务
    if not navigator.check_service():
        print("错误: POI查询服务不可用")
        print("请先启动服务: python service.py")
        return

    print("服务连接成功!")

    # 模拟无人机当前位置
    current_pos = (119.5536, 33.7825)
    print(f"\n当前位置: ({current_pos[0]:.6f}, {current_pos[1]:.6f})")

    # 测试搜索
    print("\n" + "-" * 40)
    print("测试搜索功能:")
    print("-" * 40)

    test_cases = [
        ("清华名仕园", "exact"),    # 精确匹配
        ("金沙", "prefix"),         # 前缀匹配
        ("*中学*", "fuzzy"),        # 模糊匹配
        ("阜宁", "smart"),          # 智能匹配
    ]

    for keyword, mode in test_cases:
        print(f"\n搜索 '{keyword}' (模式: {mode}):")
        results = navigator.search(keyword, mode, limit=3)
        for r in results:
            print(f"  - {r['name']} ({r['lon']:.4f}, {r['lat']:.4f}) 得分:{r['score']:.2f}")

    # 测试坐标获取和飞行计算
    print("\n" + "-" * 40)
    print("测试飞行路径计算:")
    print("-" * 40)

    destinations = ["阜宁中学", "阜宁县人民医院", "芦蒲镇"]
    for dest in destinations:
        print(f"\n目标: {dest}")
        coords = navigator.get_coordinates(dest)
        if coords:
            flight = calculate_flight_info(current_pos, coords)
            print(f"  坐标: ({coords[0]:.6f}, {coords[1]:.6f})")
            print(f"  距离: {flight['distance_m']:.0f}m")
            print(f"  航向: {flight['bearing_deg']:.1f}度 ({flight['direction']})")

    # 测试附近搜索
    print("\n" + "-" * 40)
    print("测试附近地点搜索:")
    print("-" * 40)

    nearby = navigator.find_nearby(current_pos[0], current_pos[1], 3.0)
    print(f"当前位置3km内的地点 ({len(nearby)}个):")
    for poi in nearby[:10]:
        print(f"  - {poi['name']}: {poi['distance']:.0f}m [{poi['category']}]")

    print("\n" + "=" * 60)


def interactive():
    """交互式导航"""
    print("=" * 60)
    print("无人机导航系统 - 交互模式")
    print("=" * 60)

    navigator = DroneNavigator("http://localhost:8080")

    if not navigator.check_service():
        print("错误: POI查询服务不可用")
        return

    # 设置当前位置
    current_pos = (119.5536, 33.7825)
    print(f"当前位置: ({current_pos[0]:.6f}, {current_pos[1]:.6f})")
    print("\n命令:")
    print("  go <地点> - 获取飞往该地点的航向信息")
    print("  search <关键词> - 搜索地点")
    print("  nearby - 显示附近地点")
    print("  pos <lon> <lat> - 更新当前位置")
    print("  q - 退出")
    print()

    while True:
        try:
            cmd = input("导航> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not cmd:
            continue

        if cmd.lower() == 'q':
            break

        parts = cmd.split(maxsplit=1)
        action = parts[0].lower()

        if action == "go" and len(parts) > 1:
            dest = parts[1]
            coords = navigator.get_coordinates(dest)
            if coords:
                flight = calculate_flight_info(current_pos, coords)
                print(f"\n飞行指令:")
                print(f"  目标坐标: ({coords[0]:.6f}, {coords[1]:.6f})")
                print(f"  飞行距离: {flight['distance_m']:.0f}m")
                print(f"  飞行航向: {flight['bearing_deg']:.1f}度 ({flight['direction']})")
                print()

        elif action == "search" and len(parts) > 1:
            keyword = parts[1]
            results = navigator.search(keyword)
            if results:
                print(f"\n找到 {len(results)} 个结果:")
                for i, r in enumerate(results, 1):
                    print(f"  {i}. {r['name']} - {r['category']}")
                print()
            else:
                print("未找到匹配的地点\n")

        elif action == "nearby":
            nearby = navigator.find_nearby(current_pos[0], current_pos[1], 2.0)
            print(f"\n附近2km内的地点:")
            for poi in nearby[:10]:
                print(f"  - {poi['name']}: {poi['distance']:.0f}m")
            print()

        elif action == "pos" and len(parts) > 1:
            try:
                lon, lat = map(float, parts[1].split())
                current_pos = (lon, lat)
                print(f"位置已更新: ({lon:.6f}, {lat:.6f})\n")
            except ValueError:
                print("格式错误，使用: pos <经度> <纬度>\n")

        else:
            print("未知命令\n")

    print("导航结束")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "-i":
        interactive()
    else:
        demo()
