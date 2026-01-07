import { useEffect, useState, useCallback } from 'react';
import { GeoJSON, useMap } from 'react-leaflet';
import { invoke } from '@tauri-apps/api/core';
import L from 'leaflet';

interface RegionBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface BoundaryResult {
    geojson: GeoJSON.GeoJsonObject;
    bounds: RegionBounds;
}

interface RegionBoundaryProps {
    regionCode: string | null;
    onBoundsExtracted?: (bounds: RegionBounds) => void;
    fitBounds?: boolean;
    color?: string;
}

export function RegionBoundary({
    regionCode,
    onBoundsExtracted,
    fitBounds = true,
    color = '#ef4444',
}: RegionBoundaryProps) {
    const map = useMap();
    const [geoJson, setGeoJson] = useState<GeoJSON.GeoJsonObject | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 加载边界数据
    const loadBoundary = useCallback(async (code: string) => {
        setLoading(true);
        setError(null);

        try {
            const result = await invoke<BoundaryResult>('get_region_boundary', {
                regionCode: code,
            });

            setGeoJson(result.geojson);

            // 适配地图视图
            if (fitBounds && result.bounds) {
                const bounds = L.latLngBounds(
                    [result.bounds.south, result.bounds.west],
                    [result.bounds.north, result.bounds.east]
                );
                map.fitBounds(bounds, { padding: [20, 20] });
            }

            // 回调边界数据
            if (onBoundsExtracted && result.bounds) {
                onBoundsExtracted(result.bounds);
            }
        } catch (err) {
            console.error('加载行政区边界失败:', err);
            setError(err as string);
            setGeoJson(null);
        } finally {
            setLoading(false);
        }
    }, [map, fitBounds, onBoundsExtracted]);

    useEffect(() => {
        if (regionCode) {
            loadBoundary(regionCode);
        } else {
            setGeoJson(null);
            setError(null);
        }
    }, [regionCode, loadBoundary]);

    if (loading) {
        return null;
    }

    if (error) {
        return null;
    }

    if (!geoJson) {
        return null;
    }

    return (
        <GeoJSON
            key={regionCode}
            data={geoJson}
            style={{
                color: color,
                weight: 2,
                fillColor: color,
                fillOpacity: 0.1,
            }}
        />
    );
}
