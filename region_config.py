#!/usr/bin/env python3
"""
区域配置管理模块
支持动态选择不同的行政区域进行POI数据采集
"""
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict, field

# 配置文件路径
SCRIPT_DIR = Path(__file__).parent.absolute()
CONFIG_FILE = SCRIPT_DIR / "region_config.json"


@dataclass
class RegionConfig:
    """区域配置数据结构"""
    name: str                      # 区域名称，如"阜宁县"
    admin_code: str               # 行政区划代码
    city_code: str                # 城市代码（用于高德API）
    bounds: Dict[str, float]      # 边界范围 {min_lon, max_lon, min_lat, max_lat}
    center: Tuple[float, float]   # 中心点坐标 (lon, lat)
    
    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "admin_code": self.admin_code,
            "city_code": self.city_code,
            "bounds": self.bounds,
            "center": list(self.center)
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'RegionConfig':
        center = data.get("center", [0, 0])
        if isinstance(center, list):
            center = tuple(center)
        return cls(
            name=data.get("name", ""),
            admin_code=data.get("admin_code", ""),
            city_code=data.get("city_code", ""),
            bounds=data.get("bounds", {}),
            center=center
        )


# ============ 预设区域配置 ============
# 包含江苏省盐城市下辖各县市区

PRESET_REGIONS: Dict[str, RegionConfig] = {
    "funing": RegionConfig(
        name="阜宁县",
        admin_code="320923",
        city_code="320900",
        bounds={
            "min_lon": 119.45,
            "max_lon": 119.95,
            "min_lat": 33.55,
            "max_lat": 34.05
        },
        center=(119.5536, 33.7825)
    ),
    "sheyang": RegionConfig(
        name="射阳县",
        admin_code="320924",
        city_code="320900",
        bounds={
            "min_lon": 119.75,
            "max_lon": 120.55,
            "min_lat": 33.55,
            "max_lat": 34.05
        },
        center=(120.2294, 33.7758)
    ),
    "jianhu": RegionConfig(
        name="建湖县",
        admin_code="320925",
        city_code="320900",
        bounds={
            "min_lon": 119.60,
            "max_lon": 120.00,
            "min_lat": 33.30,
            "max_lat": 33.65
        },
        center=(119.7985, 33.4646)
    ),
    "binhai": RegionConfig(
        name="滨海县",
        admin_code="320922",
        city_code="320900",
        bounds={
            "min_lon": 119.70,
            "max_lon": 120.35,
            "min_lat": 33.90,
            "max_lat": 34.35
        },
        center=(119.8206, 34.0964)
    ),
    "xiangshui": RegionConfig(
        name="响水县",
        admin_code="320921",
        city_code="320900",
        bounds={
            "min_lon": 119.50,
            "max_lon": 120.00,
            "min_lat": 34.10,
            "max_lat": 34.50
        },
        center=(119.5784, 34.1991)
    ),
    "tinghu": RegionConfig(
        name="亭湖区",
        admin_code="320902",
        city_code="320900",
        bounds={
            "min_lon": 119.90,
            "max_lon": 120.35,
            "min_lat": 33.30,
            "max_lat": 33.55
        },
        center=(120.1975, 33.3908)
    ),
    "yancheng": RegionConfig(
        name="盐城市",
        admin_code="320900",
        city_code="320900",
        bounds={
            "min_lon": 119.27,
            "max_lon": 120.95,
            "min_lat": 32.85,
            "max_lat": 34.50
        },
        center=(120.1394, 33.3776)
    ),
    "donghai": RegionConfig(
        name="东海县",
        admin_code="320722",
        city_code="320700",
        bounds={
            "min_lon": 118.45,
            "max_lon": 119.10,
            "min_lat": 34.30,
            "max_lat": 34.80
        },
        center=(118.7524, 34.5424)
    ),
    "nanjing": RegionConfig(
        name="南京市",
        admin_code="320100",
        city_code="320100",
        bounds={
            "min_lon": 118.35,
            "max_lon": 119.25,
            "min_lat": 31.20,
            "max_lat": 32.60
        },
        center=(118.7969, 32.0603)
    ),
    "suzhou": RegionConfig(
        name="苏州市",
        admin_code="320500",
        city_code="320500",
        bounds={
            "min_lon": 120.05,
            "max_lon": 121.35,
            "min_lat": 30.75,
            "max_lat": 32.05
        },
        center=(120.6195, 31.2993)
    ),
}


def get_current_region() -> RegionConfig:
    """
    获取当前配置的区域
    如果配置文件不存在，返回默认的阜宁县配置
    """
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return RegionConfig.from_dict(data)
        except (json.JSONDecodeError, KeyError) as e:
            print(f"加载区域配置失败: {e}，使用默认配置")
    
    # 返回默认配置（阜宁县）
    return PRESET_REGIONS["funing"]


def set_region(region: RegionConfig) -> bool:
    """
    设置当前区域配置
    
    Args:
        region: 区域配置对象
        
    Returns:
        是否保存成功
    """
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(region.to_dict(), f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存区域配置失败: {e}")
        return False


def set_region_by_preset(preset_id: str) -> Optional[RegionConfig]:
    """
    通过预设ID设置区域
    
    Args:
        preset_id: 预设区域ID，如 "funing", "sheyang" 等
        
    Returns:
        设置的区域配置，如果预设不存在返回None
    """
    if preset_id not in PRESET_REGIONS:
        return None
    
    region = PRESET_REGIONS[preset_id]
    if set_region(region):
        return region
    return None


def get_preset_list() -> List[Dict]:
    """
    获取预设区域列表
    
    Returns:
        预设区域列表，包含id和基本信息
    """
    return [
        {
            "id": preset_id,
            "name": region.name,
            "admin_code": region.admin_code,
            "city_code": region.city_code
        }
        for preset_id, region in PRESET_REGIONS.items()
    ]


def create_custom_region(
    name: str,
    admin_code: str,
    city_code: str,
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    center_lon: Optional[float] = None,
    center_lat: Optional[float] = None
) -> RegionConfig:
    """
    创建自定义区域配置
    
    Args:
        name: 区域名称
        admin_code: 行政区划代码
        city_code: 城市代码
        min_lon, max_lon: 经度范围
        min_lat, max_lat: 纬度范围
        center_lon, center_lat: 中心点坐标（可选，默认计算边界中心）
        
    Returns:
        区域配置对象
    """
    if center_lon is None:
        center_lon = (min_lon + max_lon) / 2
    if center_lat is None:
        center_lat = (min_lat + max_lat) / 2
    
    return RegionConfig(
        name=name,
        admin_code=admin_code,
        city_code=city_code,
        bounds={
            "min_lon": min_lon,
            "max_lon": max_lon,
            "min_lat": min_lat,
            "max_lat": max_lat
        },
        center=(center_lon, center_lat)
    )


# 兼容旧代码的全局配置（建议使用 get_current_region() 代替）
def get_funing_config() -> Dict:
    """获取当前区域配置（兼容旧接口）"""
    region = get_current_region()
    return {
        "name": region.name,
        "admin_code": region.admin_code,
        "city_code": region.city_code,
        "bounds": region.bounds,
        "center": region.center
    }


if __name__ == "__main__":
    # 测试代码
    print("当前区域配置:")
    current = get_current_region()
    print(f"  名称: {current.name}")
    print(f"  行政区划代码: {current.admin_code}")
    print(f"  边界: {current.bounds}")
    print(f"  中心: {current.center}")
    
    print("\n预设区域列表:")
    for preset in get_preset_list():
        print(f"  - {preset['id']}: {preset['name']} ({preset['admin_code']})")
