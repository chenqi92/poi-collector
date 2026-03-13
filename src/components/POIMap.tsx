import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { invoke } from '@tauri-apps/api/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// 修复 Leaflet 默认图标问题
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// @ts-expect-error - Leaflet icon fix
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconUrl: markerIcon,
    iconRetinaUrl: markerIcon2x,
    shadowUrl: markerShadow,
});

export interface POI {
    id: number;
    name: string;
    lon: number;
    lat: number;
    address?: string;
    category?: string;
    platform: string;
}

export interface POIMapProps {
    pois: POI[];
    center?: [number, number];
    zoom?: number;
    selectedId?: number | null;
    onMarkerClick?: (poi: POI) => void;
    showChartOverlay?: boolean;
    chartTilePath?: string;
    /** [south, west, north, east] */
    chartBounds?: [number, number, number, number];
}

// 自动调整地图视野以包含所有标记
function FitBounds({ pois }: { pois: POI[] }) {
    const map = useMap();

    useEffect(() => {
        if (pois.length === 0) return;

        if (pois.length === 1) {
            map.setView([pois[0].lat, pois[0].lon], 15);
        } else {
            const bounds = L.latLngBounds(pois.map(p => [p.lat, p.lon]));
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }, [pois, map]);

    return null;
}

// 监听容器大小变化，自动调用 invalidateSize
function ResizeHandler() {
    const map = useMap();

    useEffect(() => {
        // 窗口 resize 事件
        const handleResize = () => {
            setTimeout(() => {
                map.invalidateSize();
            }, 100);
        };

        window.addEventListener('resize', handleResize);

        // 使用 ResizeObserver 监听容器变化
        const container = map.getContainer();
        const resizeObserver = new ResizeObserver(() => {
            map.invalidateSize();
        });
        resizeObserver.observe(container);

        // 初始化时也调用一次
        setTimeout(() => map.invalidateSize(), 200);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
        };
    }, [map]);

    return null;
}

// 平台颜色配置
const platformColors: Record<string, string> = {
    tianditu: '#06b6d4', // cyan
    amap: '#6366f1', // indigo
    baidu: '#ef4444', // red
};

// 创建自定义彩色图标
function createColoredIcon(color: string) {
    return L.divIcon({
        className: 'custom-marker',
        html: `
            <svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
                <path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="${color}"/>
                <circle cx="12.5" cy="12.5" r="5" fill="white"/>
            </svg>
        `,
        iconSize: [25, 41],
        iconAnchor: [12.5, 41],
        popupAnchor: [0, -41],
    });
}

// 选中标记时居中显示
function CenterOnSelected({ selectedId, pois }: { selectedId: number | null | undefined; pois: POI[] }) {
    const map = useMap();

    useEffect(() => {
        if (selectedId == null) return;
        const poi = pois.find(p => p.id === selectedId);
        if (poi) {
            map.setView([poi.lat, poi.lon], Math.max(map.getZoom(), 14), { animate: true });
        }
    }, [selectedId, pois, map]);

    return null;
}

// 航道图覆盖层（ArcGIS EPSG:4326 自定义切片方案）
const CJ_RESOLUTIONS = [
    0.023794610058302794, 0.009517844023321119, 0.004758922011660559,
    0.0023794610058302797, 0.0011897305029151398, 0.0005948652514575699,
    0.00029743262572878496, 0.00014871631286439248, 0.00007435815643219624,
    0.00003717907821609812, 0.000018590728838551974, 0.000009294174688773071,
    0.000004647087344386536, 0.0000023794610058302796
];
const CJ_ORIGIN = [-400, 400];
const TILE_SIZE = 256;


function ChartOverlayLayer({ basePath, visible }: { basePath: string; visible: boolean }) {
    const map = useMap();
    const tilesRef = useRef<Record<string, L.ImageOverlay>>({});
    const currentZRef = useRef(-1);
    const visibleRef = useRef(visible);

    // 切换显隐：只改 opacity，不卸载
    useEffect(() => {
        visibleRef.current = visible;
        const tiles = tilesRef.current;
        for (const key in tiles) {
            if (tiles[key]) tiles[key].setOpacity(visible ? 0.9 : 0);
        }
    }, [visible]);

    useEffect(() => {
        const tiles = tilesRef.current;
        let mounted = true;

        function clearTiles() {
            for (const key in tiles) {
                if (tiles[key]) tiles[key].remove();
                delete tiles[key];
            }
            currentZRef.current = -1;
        }

        function update() {
            if (!mounted) return;
            const bounds = map.getBounds();
            const zoom = map.getZoom();
            const mapZoom = Math.round(zoom) + 1;
            const customZ = mapZoom - 7;

            if (customZ < 4 || customZ > 10) {
                clearTiles();
                return;
            }

            const res = CJ_RESOLUTIONS[customZ];
            if (!res) { clearTiles(); return; }

            if (currentZRef.current !== customZ) {
                clearTiles();
                currentZRef.current = customZ;
            }

            const nw = bounds.getNorthWest();
            const se = bounds.getSouthEast();
            const startX = Math.floor((nw.lng - CJ_ORIGIN[0]) / (res * TILE_SIZE));
            const startY = Math.floor((CJ_ORIGIN[1] - nw.lat) / (res * TILE_SIZE));
            const endX = Math.floor((se.lng - CJ_ORIGIN[0]) / (res * TILE_SIZE));
            const endY = Math.floor((CJ_ORIGIN[1] - se.lat) / (res * TILE_SIZE));

            // 移除视口外的瓦片
            for (const key in tiles) {
                const [, tx, ty] = key.split(':').map(Number);
                if (tx < startX - 1 || tx > endX + 1 || ty < startY - 1 || ty > endY + 1) {
                    if (tiles[key]) tiles[key].remove();
                    delete tiles[key];
                }
            }

            // 加载视口内的新瓦片
            for (let x = startX; x <= endX; x++) {
                for (let y = startY; y <= endY; y++) {
                    const tileKey = `${customZ}:${x}:${y}`;
                    if (tiles[tileKey]) continue;

                    // 占位标记，避免重复请求
                    tiles[tileKey] = null as unknown as L.ImageOverlay;

                    const nwLng = CJ_ORIGIN[0] + x * res * TILE_SIZE;
                    const nwLat = CJ_ORIGIN[1] - y * res * TILE_SIZE;
                    const seLng = nwLng + res * TILE_SIZE;
                    const seLat = nwLat - res * TILE_SIZE;
                    const tileBounds: L.LatLngBoundsExpression = [[seLat, nwLng], [nwLat, seLng]];

                    invoke<string>('serve_local_tile', { basePath, z: customZ, x, y })
                        .then((b64: string) => {
                            if (!mounted) return; // 组件已卸载，忽略回调
                            if (b64 && tiles[tileKey] !== undefined) {
                                const overlay = L.imageOverlay(
                                    `data:image/png;base64,${b64}`,
                                    tileBounds,
                                    { opacity: visibleRef.current ? 0.9 : 0, interactive: false, zIndex: 9 }
                                );
                                overlay.addTo(map);
                                tiles[tileKey] = overlay;
                            } else {
                                delete tiles[tileKey];
                            }
                        })
                        .catch(() => {
                            delete tiles[tileKey];
                        });
                }
            }
        }

        map.on('moveend', update);
        map.on('zoomend', update);
        update();

        return () => {
            mounted = false; // 阻止后续IPC回调添加瓦片
            map.off('moveend', update);
            map.off('zoomend', update);
            clearTiles();
            // 兜底：遍历地图上所有图层，移除残留的ImageOverlay
            map.eachLayer((layer) => {
                if (layer instanceof L.ImageOverlay && layer.options.interactive === false) {
                    map.removeLayer(layer);
                }
            });
        };
    }, [map, basePath]);

    return null;
}

// 航道图自动定位 + 层级指示器
function FitChartBounds({ bounds }: { bounds?: [number, number, number, number] }) {
    const map = useMap();
    const prevBoundsRef = useRef<string>('');
    useEffect(() => {
        if (!bounds) return;
        const boundsKey = bounds.join(',');
        if (boundsKey === prevBoundsRef.current) return;
        prevBoundsRef.current = boundsKey;
        const [south, west, north, east] = bounds;
        map.fitBounds([[south, west], [north, east]], { padding: [30, 30], maxZoom: 14 });
    }, [bounds, map]);
    return null;
}

function ZoomIndicator({ showChart }: { showChart: boolean }) {
    const map = useMap();
    const [zoom, setZoom] = useState(map.getZoom());
    useEffect(() => {
        const onZoom = () => setZoom(map.getZoom());
        map.on('zoomend', onZoom);
        return () => { map.off('zoomend', onZoom); };
    }, [map]);

    if (!showChart) return null;
    const mapZoom = Math.round(zoom) + 1;
    const chartZ = mapZoom - 7;
    const inRange = chartZ >= 4 && chartZ <= 10;

    return (
        <div className="leaflet-bottom leaflet-right" style={{ pointerEvents: 'none' }}>
            <div className="leaflet-control" style={{
                pointerEvents: 'auto',
                background: 'rgba(0,0,0,0.65)',
                color: '#fff',
                padding: '6px 10px',
                borderRadius: '8px',
                fontSize: '12px',
                fontFamily: 'monospace',
                lineHeight: '1.6',
                margin: '10px',
                backdropFilter: 'blur(4px)',
            }}>
                <div>地图层级：<span style={{ fontWeight: 'bold' }}>{Math.round(zoom)}</span></div>
                <div>
                    航道图层级：
                    <span style={{ fontWeight: 'bold', color: inRange ? '#4ade80' : '#f87171' }}>
                        {inRange ? chartZ : '超出范围'}
                    </span>
                    <span style={{ opacity: 0.6, marginLeft: 4 }}>(4-10)</span>
                </div>
            </div>
        </div>
    );
}

// 选中状态的高亮颜色
const SELECTED_COLOR = '#f97316'; // orange-500

export function POIMap({
    pois,
    center = [33.78, 119.8], // 默认中心：阜宁
    zoom = 10,
    selectedId,
    onMarkerClick,
    showChartOverlay,
    chartTilePath,
    chartBounds
}: POIMapProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
        <div ref={containerRef} className="w-full h-full" style={{ minHeight: '300px' }}>
            <MapContainer
                center={center}
                zoom={zoom}
                className="w-full h-full rounded-lg"
                style={{ height: '100%', width: '100%' }}
                attributionControl={false}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <FitBounds pois={pois} />
                <ResizeHandler />
                <CenterOnSelected selectedId={selectedId} pois={pois} />

                {showChartOverlay && chartTilePath && (
                    <ChartOverlayLayer basePath={chartTilePath} visible={true} />
                )}

                <FitChartBounds bounds={chartBounds} />
                <ZoomIndicator showChart={!!showChartOverlay} />

                {pois.map((poi) => {
                    const isSelected = poi.id === selectedId;
                    const color = isSelected ? SELECTED_COLOR : (platformColors[poi.platform] || '#3b82f6');

                    return (
                        <Marker
                            key={poi.id}
                            position={[poi.lat, poi.lon]}
                            icon={createColoredIcon(color)}
                            zIndexOffset={isSelected ? 1000 : 0}
                            eventHandlers={{
                                click: () => onMarkerClick?.(poi),
                            }}
                        >
                            <Popup>
                                <div className="text-sm">
                                    <div className="font-semibold text-gray-900">{poi.name}</div>
                                    <div className="text-gray-500 mt-1">{poi.address || '暂无地址'}</div>
                                    <div className="flex items-center gap-2 mt-2 text-xs">
                                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                                            {poi.category || '未分类'}
                                        </span>
                                        <span
                                            className="px-2 py-0.5 rounded text-white"
                                            style={{ backgroundColor: platformColors[poi.platform] || '#3b82f6' }}
                                        >
                                            {poi.platform}
                                        </span>
                                    </div>
                                    <div className="text-gray-400 mt-1 text-xs">
                                        {poi.lon.toFixed(6)}, {poi.lat.toFixed(6)}
                                    </div>
                                </div>
                            </Popup>
                        </Marker>
                    );
                })}
            </MapContainer>
        </div>
    );
}

export default POIMap;
