import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { invoke } from '@tauri-apps/api/core';

interface TilePreviewLayerProps {
    platform: string;
    mapType: string;
    apiKey?: string;
}

interface TileRequest {
    platform: string;
    map_type: string;
    z: number;
    x: number;
    y: number;
    api_key: string | null;
}

// 自定义瓦片层，通过 Tauri 代理获取瓦片
class TauriTileLayer extends L.TileLayer {
    private platform: string;
    private mapType: string;
    private apiKey?: string;
    private tileCache: Map<string, string>;

    constructor(
        platform: string,
        mapType: string,
        apiKey?: string,
        options?: L.TileLayerOptions
    ) {
        super('', options);
        this.platform = platform;
        this.mapType = mapType;
        this.apiKey = apiKey;
        this.tileCache = new Map();
    }

    createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');

        const cacheKey = `${this.platform}-${this.mapType}-${coords.z}-${coords.x}-${coords.y}`;

        // 检查缓存
        const cached = this.tileCache.get(cacheKey);
        if (cached) {
            tile.src = cached;
            done(undefined, tile);
            return tile;
        }

        // 通过 Tauri 获取瓦片
        const request: TileRequest = {
            platform: this.platform,
            map_type: this.mapType,
            z: coords.z,
            x: coords.x,
            y: coords.y,
            api_key: this.apiKey || null,
        };

        invoke<number[]>('proxy_tile_request', { request })
            .then((bytes) => {
                const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
                const url = URL.createObjectURL(blob);
                this.tileCache.set(cacheKey, url);
                tile.src = url;
                done(undefined, tile);
            })
            .catch((error) => {
                console.error('瓦片加载失败:', error);
                // 显示错误占位图
                tile.style.background = '#f0f0f0';
                tile.style.border = '1px dashed #ccc';
                done(error as Error, tile);
            });

        return tile;
    }

    updateParams(platform: string, mapType: string, apiKey?: string) {
        if (
            this.platform !== platform ||
            this.mapType !== mapType ||
            this.apiKey !== apiKey
        ) {
            this.platform = platform;
            this.mapType = mapType;
            this.apiKey = apiKey;
            // 清除缓存并重新加载
            this.tileCache.clear();
            this.redraw();
        }
    }
}

export function TilePreviewLayer({ platform, mapType, apiKey }: TilePreviewLayerProps) {
    const map = useMap();
    const layerRef = useRef<TauriTileLayer | null>(null);

    useEffect(() => {
        if (!layerRef.current) {
            layerRef.current = new TauriTileLayer(platform, mapType, apiKey, {
                maxZoom: 19,
                minZoom: 1,
            });
            map.addLayer(layerRef.current);
        } else {
            layerRef.current.updateParams(platform, mapType, apiKey);
        }

        return () => {
            if (layerRef.current) {
                map.removeLayer(layerRef.current);
                layerRef.current = null;
            }
        };
    }, [map, platform, mapType, apiKey]);

    return null;
}
