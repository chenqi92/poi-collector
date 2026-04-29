import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type BaseMapType =
    | 'street'
    | 'terrain'
    | 'satellite'
    | 'tianditu_vec'
    | 'tianditu_img'
    | 'tianditu_ter';

export interface BaseMapOption {
    key: BaseMapType;
    label: string;
    url: string;
    attr: string;
    subdomains?: string[];
    requiresKey?: 'tianditu';
}

export const TIANDITU_SUBDOMAINS = ['0', '1', '2', '3', '4', '5', '6', '7'];

export const BASE_MAP_OPTIONS: BaseMapOption[] = [
    {
        key: 'street',
        label: '街道',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; OSM',
    },
    {
        key: 'terrain',
        label: '地形',
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attr: '&copy; OpenTopoMap',
    },
    {
        key: 'satellite',
        label: '卫星',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attr: '&copy; Esri',
    },
    {
        key: 'tianditu_vec',
        label: '天地图',
        url: 'https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk={tk}',
        attr: '&copy; 天地图',
        subdomains: TIANDITU_SUBDOMAINS,
        requiresKey: 'tianditu',
    },
    {
        key: 'tianditu_img',
        label: '天地图卫星',
        url: 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk={tk}',
        attr: '&copy; 天地图',
        subdomains: TIANDITU_SUBDOMAINS,
        requiresKey: 'tianditu',
    },
    {
        key: 'tianditu_ter',
        label: '天地图地形',
        url: 'https://t{s}.tianditu.gov.cn/ter_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ter&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk={tk}',
        attr: '&copy; 天地图',
        subdomains: TIANDITU_SUBDOMAINS,
        requiresKey: 'tianditu',
    },
];

export const TIANDITU_ANNOTATION_URL =
    'https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk={tk}';

export function filterAvailableBaseMaps(tiandituKey: string): BaseMapOption[] {
    return BASE_MAP_OPTIONS.filter(
        (o) => !o.requiresKey || (o.requiresKey === 'tianditu' && !!tiandituKey)
    );
}

export function resolveBaseMap(
    type: BaseMapType,
    options: BaseMapOption[]
): BaseMapOption | undefined {
    return options.find((o) => o.key === type) || options[0];
}

// ---- 天地图 API Key 模块级缓存 ----
// undefined: 未加载；string（含空字符串）: 已加载完成
let cachedTiandituKey: string | undefined;
let inflightFetch: Promise<string> | null = null;
const subscribers = new Set<(key: string) => void>();

function fetchTiandituKey(): Promise<string> {
    if (cachedTiandituKey !== undefined) return Promise.resolve(cachedTiandituKey);
    if (inflightFetch) return inflightFetch;
    inflightFetch = invoke<Record<string, { id: number; api_key: string }[]>>('get_api_keys')
        .then((keys) => keys?.tianditu?.[0]?.api_key ?? '')
        .catch((e) => {
            console.error('加载天地图 Key 失败:', e);
            return '';
        })
        .then((k) => {
            cachedTiandituKey = k;
            subscribers.forEach((fn) => fn(k));
            return k;
        })
        .finally(() => {
            inflightFetch = null;
        });
    return inflightFetch;
}

/** 在 Settings 添加/删除天地图 Key 后调用，刷新所有使用方的缓存 */
export function refreshTiandituKey(): Promise<string> {
    cachedTiandituKey = undefined;
    return fetchTiandituKey();
}

/** 加载天地图 API Key（与兴趣点共用同一套配置）；进程内全局缓存，仅首次实际请求 */
export function useTiandituKey(): string {
    const [key, setKey] = useState<string>(cachedTiandituKey ?? '');
    useEffect(() => {
        // 已有缓存时同步到本地 state；尚未加载时触发加载
        if (cachedTiandituKey !== undefined) {
            setKey(cachedTiandituKey);
        } else {
            fetchTiandituKey();
        }
        subscribers.add(setKey);
        return () => {
            subscribers.delete(setKey);
        };
    }, []);
    return key;
}

/** 给定天地图 Key 计算可用底图列表（稳定引用） */
export function useAvailableBaseMaps(tiandituKey: string): BaseMapOption[] {
    return useMemo(() => filterAvailableBaseMaps(tiandituKey), [tiandituKey]);
}
