import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
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

export function POIMap({
    pois,
    center = [33.78, 119.8], // 默认中心：阜宁
    zoom = 10,
    onMarkerClick
}: POIMapProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
        <div ref={containerRef} className="w-full h-full" style={{ minHeight: '300px' }}>
            <MapContainer
                center={center}
                zoom={zoom}
                className="w-full h-full rounded-lg"
                style={{ height: '100%', width: '100%' }}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <FitBounds pois={pois} />
                <ResizeHandler />

                {pois.map((poi) => (
                    <Marker
                        key={poi.id}
                        position={[poi.lat, poi.lon]}
                        icon={createColoredIcon(platformColors[poi.platform] || '#3b82f6')}
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
                ))}
            </MapContainer>
        </div>
    );
}

export default POIMap;
