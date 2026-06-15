# AIS 水域面过滤开发文档

## 背景

`poi-collector-app` 目前可以采集长江航道图相关专题要素，其中与 AIS 过滤最相关的是：

- `HYDRO_A` 水域面：面状矢量数据，用于判断 AIS 点是否位于水域范围内。
- `electronic_fence` 电子围栏：点、线、面专题要素，用于卡口、报告线、保护区、管控区等业务判断。

AIS 过滤的核心不是看航道图瓦片，而是使用 `HYDRO_A` 的 GeoJSON 多边形做空间判断：AIS 经纬度点落在水域面内或靠近水域面边界，则认为位置合理；明显落在水域面外，则标记异常。

## 为什么有些航段没有水域面

航道图底图和 `HYDRO_A` 矢量水域面不是同一份数据。底图瓦片上能看到河道，不代表 `HYDRO_A` 图层一定有对应多边形。

常见原因：

1. 数据源本身没有发布该段 `HYDRO_A` 面。
2. 当前航道要素采集范围没有覆盖该航段。
3. 采集时对应网格请求失败、超时或被服务端限制。
4. 服务端分页或复杂区域返回限制导致部分面缺失。
5. `HYDRO_A` 不是完整“可航水域边界”，可能存在空洞、断段、洲滩裁切、支汊拆分。
6. OSM/航道图瓦片和 `HYDRO_A` 更新周期、制图规则不同。

因此过滤 AIS 时必须区分：

- `outside_water`：在已覆盖水域面范围内，明确不在水域面内。
- `unknown_coverage`：附近没有采集到水域面，不能直接判定为错误。

## 数据组成

水域面和电子围栏统一存储在 SQLite 表 `chart_features`。

| 字段 | 说明 |
| --- | --- |
| `id` | 本地唯一 ID。水域面通常为 `cjshoudong:HYDRO_A:<source_id>` |
| `source` | 数据来源。水域面为 `cjshoudong_mapserver` |
| `source_layer` | 来源图层。水域面为 `HYDRO_A`，电子围栏为 `electronic_fence` |
| `source_feature_id` | 原始服务中的要素 ID，如 `OBJECTID`、`FID`、`ID` |
| `name` | 要素名称，可能为空 |
| `feature_type` | 要素类型。水域面缺省为 `HYDRO_A` |
| `geometry_type` | GeoJSON 几何类型，如 `Polygon`、`MultiPolygon` |
| `geometry_json` | GeoJSON Geometry 字符串，包含具体经纬度坐标 |
| `min_lon` / `min_lat` / `max_lon` / `max_lat` | 几何 bbox，用于快速粗筛 |
| `raw_json` | 原始服务返回的 Feature JSON |

坐标约定：

- `HYDRO_A` 请求使用 `inSR=4326` 和 `outSR=4326`。
- 入库坐标是 WGS84 经纬度。
- GeoJSON 坐标顺序是 `[longitude, latitude]`，即 `[经度, 纬度]`。

典型 `geometry_json`：

```json
{
  "type": "Polygon",
  "coordinates": [
    [
      [112.123456, 30.123456],
      [112.124000, 30.124000],
      [112.125000, 30.122000],
      [112.123456, 30.123456]
    ]
  ]
}
```

## AIS 过滤原理

输入 AIS 点：

```json
{
  "mmsi": "413000000",
  "lon": 112.123456,
  "lat": 30.123456,
  "sog": 8.5,
  "time": "2026-06-15T10:00:00Z"
}
```

推荐流程：

1. 坐标合法性校验。

   经度必须在 `[-180, 180]`，纬度必须在 `[-90, 90]`。业务上还可以限制在长江采集范围内。

2. bbox 粗筛。

   ```sql
   SELECT *
   FROM chart_features
   WHERE source_layer = 'HYDRO_A'
     AND min_lon <= :lon
     AND max_lon >= :lon
     AND min_lat <= :lat
     AND max_lat >= :lat;
   ```

3. 点面精判。

   解析候选要素的 `geometry_json`，判断 AIS 点是否在 `Polygon` 或 `MultiPolygon` 内。

4. 边界容差。

   AIS 有定位误差，水域面边界也可能与真实岸线不完全一致。建议设置 `30m - 100m` 容差。点不在面内但距离水域面边界很近时，标记为 `near_water`，不要直接删除。

推荐状态：

| 状态 | 含义 | 处理建议 |
| --- | --- | --- |
| `valid_water` | AIS 点在水域面内 | 保留 |
| `near_water` | AIS 点不在面内，但距离水域面边界小于容差 | 保留或低风险标记 |
| `outside_water` | AIS 点明显在水域面外 | 标记异常或过滤 |
| `unknown_coverage` | 附近没有已采集水域面，可能是覆盖缺失 | 不直接删除，等待补采或复核 |
| `invalid_coord` | 经纬度非法 | 直接过滤 |

## TypeScript 示例

建议使用 Turf.js，不要手写复杂几何算法。

```ts
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'

type HydroFeature = {
  id: string
  source_layer: 'HYDRO_A'
  geometry_json: string
  min_lon: number
  min_lat: number
  max_lon: number
  max_lat: number
}

type AisPoint = {
  lon: number
  lat: number
}

type FilterResult = {
  status: 'valid_water' | 'outside_water' | 'unknown_coverage' | 'invalid_coord'
  matchedFeatureId?: string
}

function isValidCoord(p: AisPoint) {
  return Number.isFinite(p.lon) &&
    Number.isFinite(p.lat) &&
    p.lon >= -180 &&
    p.lon <= 180 &&
    p.lat >= -90 &&
    p.lat <= 90
}

function bboxContains(f: HydroFeature, p: AisPoint) {
  return f.min_lon <= p.lon &&
    f.max_lon >= p.lon &&
    f.min_lat <= p.lat &&
    f.max_lat >= p.lat
}

export function filterAisByHydro(
  ais: AisPoint,
  hydroFeatures: HydroFeature[],
): FilterResult {
  if (!isValidCoord(ais)) return { status: 'invalid_coord' }

  const candidates = hydroFeatures.filter(f => bboxContains(f, ais))
  if (candidates.length === 0) return { status: 'unknown_coverage' }

  const pt = point([ais.lon, ais.lat])

  for (const f of candidates) {
    const geometry = JSON.parse(f.geometry_json)
    const feature = {
      type: 'Feature',
      properties: {},
      geometry,
    } as GeoJSON.Feature

    if (booleanPointInPolygon(pt, feature as any)) {
      return { status: 'valid_water', matchedFeatureId: f.id }
    }
  }

  return { status: 'outside_water' }
}
```

## PostGIS 示例

大批量 AIS 过滤建议放在数据库侧。

```sql
CREATE TABLE hydro_area (
  id text PRIMARY KEY,
  source_feature_id text,
  geom geometry(MultiPolygon, 4326)
);

CREATE INDEX idx_hydro_area_geom
ON hydro_area
USING GIST (geom);
```

导入：

```sql
INSERT INTO hydro_area (id, source_feature_id, geom)
VALUES (
  :id,
  :source_feature_id,
  ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geometry_json), 4326))
);
```

过滤：

```sql
SELECT a.*,
       CASE
         WHEN a.lon < -180 OR a.lon > 180 OR a.lat < -90 OR a.lat > 90
           THEN 'invalid_coord'
         WHEN EXISTS (
           SELECT 1
           FROM hydro_area h
           WHERE ST_Intersects(h.geom, ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326))
         )
           THEN 'valid_water'
         WHEN EXISTS (
           SELECT 1
           FROM hydro_area h
           WHERE ST_DWithin(
             h.geom::geography,
             ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326)::geography,
             50
           )
         )
           THEN 'near_water'
         ELSE 'outside_water'
       END AS water_status
FROM ais_points a;
```

## 与电子围栏的关系

不要把 `HYDRO_A` 和电子围栏混成一种规则：

- `HYDRO_A`：基础空间合法性规则，用于判断 AIS 是否在水域范围。
- 电子围栏：业务规则，用于判断是否进入卡口、报告线、管控区、禁航区等。

推荐组合：

```text
AIS 在 HYDRO_A 内：
  保留

AIS 不在 HYDRO_A 内，但接近水域面边界：
  保留，标记 near_water

AIS 不在 HYDRO_A 内，且位于已采集覆盖区：
  标记 outside_water，可过滤或复核

AIS 附近没有任何 HYDRO_A 覆盖：
  标记 unknown_coverage，不直接删除

AIS 落入特定电子围栏：
  根据围栏类型追加业务标签或告警
```

## 当前项目相关位置

- 水域面采集：`src-tauri/src/chart_collector/feature_collector.rs`
- 数据结构：`src-tauri/src/chart_collector/types.rs`
- 数据表：`src-tauri/src/chart_collector/database.rs`
- 导出命令：`src-tauri/src/chart_collector/commands.rs`
- 前端图层展示：`src/pages/data-hub/ChartOverlay.tsx`
- 航道图 tab 开关：`src/pages/data-hub/BrowseView.tsx`

## 落地检查清单

- 已采集目标区域的 `HYDRO_A 水域面`。
- AIS 坐标和水域面坐标均为 WGS84。
- GeoJSON 坐标顺序按 `[lon, lat]` 使用。
- 点面判断使用 Turf.js、PostGIS、Shapely 或 JTS 等成熟库。
- 区分 `outside_water` 和 `unknown_coverage`。
- 设置边界容差，建议从 `50m` 开始。
- 保留过滤原因和命中的水域面 ID，便于复核与调优。
