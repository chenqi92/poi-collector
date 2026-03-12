import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search as SearchIcon, MapPin, List, Columns, Loader2, Anchor, Map as MapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import POIMap, { POI } from '@/components/POIMap';
import SimpleBar from 'simplebar-react';

type ViewMode = 'list' | 'map' | 'split';
type SearchTab = 'poi' | 'buoy' | 'chart';

interface CjhyTask {
    id: string;
    name: string;
    output_path: string;
    total_tiles: number;
    completed_tiles: number;
    failed_tiles: number;
    bounds_north: number;
    bounds_south: number;
    bounds_east: number;
    bounds_west: number;
    zoom_levels: number[];
}

const platformNames: Record<string, string> = {
    all: '全部平台',
    tianditu: '天地图',
    amap: '高德',
    baidu: '百度',
};

const platformColors: Record<string, string> = {
    tianditu: 'bg-cyan-500/20 text-cyan-500',
    amap: 'bg-indigo-500/20 text-indigo-500',
    baidu: 'bg-red-500/20 text-red-500',
    osm: 'bg-emerald-500/20 text-emerald-500',
};

const modeOptions = [
    { value: 'contains', label: '包含' },
    { value: 'exact', label: '精确' },
    { value: 'prefix', label: '前缀' },
];

interface BuoyInfo {
    id: string;
    name: string | null;
    lon_84: number | null;
    lat_84: number | null;
    buoy_type: string | null;
    icon_url: string | null;
    organization_id: string | null;
    color: string | null;
    waterway: string | null;
    shape: string | null;
    light_info: string | null;
    region: string | null;
    raw_json: string;
}

export default function Search() {
    const [searchTab, setSearchTab] = useState<SearchTab>('poi');

    // POI 搜索状态
    const [query, setQuery] = useState('');
    const [platform, setPlatform] = useState('all');
    const [mode, setMode] = useState('contains');
    const [results, setResults] = useState<POI[]>([]);
    const [loading, setLoading] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('split');
    const [selectedId, setSelectedId] = useState<number | null>(null);

    // 航标搜索状态
    const [buoyQuery, setBuoyQuery] = useState('');
    const [allBuoys, setAllBuoys] = useState<BuoyInfo[]>([]);
    const [buoyLoading, setBuoyLoading] = useState(false);
    const [buoyLoaded, setBuoyLoaded] = useState(false);

    // 航道图状态
    const [cjhyTasks, setCjhyTasks] = useState<CjhyTask[]>([]);
    const [selectedCjhyTask, setSelectedCjhyTask] = useState<string>('');
    const [showChartOverlay, setShowChartOverlay] = useState(false);
    const [cjhyLoaded, setCjhyLoaded] = useState(false);

    // 加载航标数据
    useEffect(() => {
        if (searchTab === 'buoy' && !buoyLoaded) {
            loadBuoys();
        }
    }, [searchTab, buoyLoaded]);

    // 加载航道图任务列表
    useEffect(() => {
        if (searchTab === 'chart' && !cjhyLoaded) {
            loadCjhyTasks();
        }
    }, [searchTab, cjhyLoaded]);

    const loadCjhyTasks = async () => {
        try {
            const data = await invoke<CjhyTask[]>('get_cjhy_tile_tasks');
            setCjhyTasks(data);
            setCjhyLoaded(true);
            // 自动选择第一个
            if (data.length > 0 && !selectedCjhyTask) {
                setSelectedCjhyTask(data[0].id);
                setShowChartOverlay(true);
            }
        } catch (e) {
            console.error('加载航道图任务失败:', e);
        }
    };

    const loadBuoys = async () => {
        setBuoyLoading(true);
        try {
            const data = await invoke<BuoyInfo[]>('chart_get_all_buoys');
            setAllBuoys(data);
            setBuoyLoaded(true);
        } catch (e) {
            console.error('加载航标数据失败:', e);
        } finally {
            setBuoyLoading(false);
        }
    };

    // 航标搜索过滤
    const filteredBuoys = useMemo(() => {
        if (!buoyQuery.trim()) return allBuoys;
        const q = buoyQuery.trim().toLowerCase();
        return allBuoys.filter(b =>
            (b.name && b.name.toLowerCase().includes(q)) ||
            (b.waterway && b.waterway.toLowerCase().includes(q)) ||
            (b.region && b.region.toLowerCase().includes(q)) ||
            (b.id && b.id.toLowerCase().includes(q)) ||
            (b.shape && b.shape.toLowerCase().includes(q)) ||
            (b.buoy_type && b.buoy_type.toLowerCase().includes(q))
        );
    }, [allBuoys, buoyQuery]);

    // 航标数据转换为 POI 格式用于地图展示
    const buoyMapData: POI[] = useMemo(() => {
        return filteredBuoys
            .filter(b => b.lon_84 && b.lat_84)
            .map((b, i) => ({
                id: i,
                name: b.name || b.id,
                lon: b.lon_84!,
                lat: b.lat_84!,
                address: [b.waterway, b.region].filter(Boolean).join(' · ') || '',
                category: b.buoy_type || b.shape || '',
                platform: 'buoy',
            }));
    }, [filteredBuoys]);

    const handleSearch = async () => {
        if (!query.trim()) return;

        setLoading(true);
        try {
            const data = await invoke<POI[]>('search_poi', {
                query: query.trim(),
                platform: platform === 'all' ? null : platform,
                mode,
            });
            setResults(data);
        } catch (e) {
            console.error('搜索失败:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleMarkerClick = (poi: POI) => {
        setSelectedId(poi.id);
    };

    const showList = searchTab !== 'chart' && (viewMode === 'list' || viewMode === 'split');
    const showMap = searchTab === 'chart' || viewMode === 'map' || viewMode === 'split';

    const currentResults = searchTab === 'poi' ? results : searchTab === 'buoy' ? buoyMapData : [];

    // 当前选中的航道图任务
    const selectedTask = cjhyTasks.find(t => t.id === selectedCjhyTask);
    const chartTilePath = selectedTask?.output_path || '';
    const chartBounds: [number, number, number, number] | undefined = selectedTask
        ? [selectedTask.bounds_south, selectedTask.bounds_west, selectedTask.bounds_north, selectedTask.bounds_east]
        : undefined;

    return (
        <div className="h-full flex flex-col gap-4 overflow-hidden">
            {/* 页面标题 */}
            <div className="shrink-0 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据搜索</h1>
                    <p className="text-muted-foreground">从已采集的本地数据中搜索 POI 和航标</p>
                </div>
            </div>

            {/* 搜索栏 */}
            <Card className="shrink-0 overflow-visible relative">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-indigo-500 to-purple-500" />
                <CardContent className="py-4">
                    {/* Tab 切换行 */}
                    <div className={`flex items-center gap-3 ${searchTab !== 'chart' ? 'mb-3' : ''}`}>
                        <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
                            <button
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${searchTab === 'poi'
                                    ? 'bg-background shadow-sm text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                onClick={() => setSearchTab('poi')}
                            >
                                <MapPin className="w-3.5 h-3.5" />
                                POI 搜索
                            </button>
                            <button
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${searchTab === 'buoy'
                                    ? 'bg-background shadow-sm text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                onClick={() => setSearchTab('buoy')}
                            >
                                <Anchor className="w-3.5 h-3.5" />
                                航标搜索
                                {allBuoys.length > 0 && (
                                    <span className="px-1.5 py-0.5 text-[10px] bg-blue-500/20 text-blue-500 rounded-full">
                                        {allBuoys.length}
                                    </span>
                                )}
                            </button>
                            <button
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${searchTab === 'chart'
                                    ? 'bg-background shadow-sm text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                onClick={() => setSearchTab('chart')}
                            >
                                <MapIcon className="w-3.5 h-3.5" />
                                航道图
                                {cjhyTasks.length > 0 && (
                                    <span className="px-1.5 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-500 rounded-full">
                                        {cjhyTasks.length}
                                    </span>
                                )}
                            </button>
                        </div>
                        <div className="flex-1" />

                        {/* 航道图 tab：右侧显示任务选择器；其他 tab：右侧显示视图切换 */}
                        {searchTab === 'chart' ? (
                            <div className="flex items-center gap-2">
                                <select
                                    value={selectedCjhyTask}
                                    onChange={(e) => {
                                        setSelectedCjhyTask(e.target.value);
                                        setShowChartOverlay(!!e.target.value);
                                    }}
                                    className="px-3 py-1.5 border border-input bg-background rounded-lg text-sm text-foreground
                                             focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary cursor-pointer transition-all"
                                >
                                    <option value="">选择航道图...</option>
                                    {cjhyTasks.map(t => (
                                        <option key={t.id} value={t.id}>
                                            {t.name} ({t.completed_tiles.toLocaleString()} 瓦片)
                                        </option>
                                    ))}
                                </select>
                                <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm text-muted-foreground whitespace-nowrap">
                                    <input
                                        type="checkbox"
                                        checked={showChartOverlay}
                                        onChange={(e) => setShowChartOverlay(e.target.checked)}
                                        className="w-3.5 h-3.5 rounded border-input text-primary focus:ring-primary/50"
                                    />
                                    叠加
                                </label>
                            </div>
                        ) : (
                            <div className="flex border border-input rounded-xl overflow-hidden">
                                <button
                                    onClick={() => setViewMode('list')}
                                    className={`p-2.5 transition-all cursor-pointer ${viewMode === 'list'
                                        ? 'gradient-primary text-white'
                                        : 'bg-background text-muted-foreground hover:bg-accent'
                                        }`}
                                    title="列表视图"
                                >
                                    <List className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => setViewMode('split')}
                                    className={`p-2.5 border-x border-input transition-all cursor-pointer ${viewMode === 'split'
                                        ? 'gradient-primary text-white'
                                        : 'bg-background text-muted-foreground hover:bg-accent'
                                        }`}
                                    title="分屏视图"
                                >
                                    <Columns className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => setViewMode('map')}
                                    className={`p-2.5 transition-all cursor-pointer ${viewMode === 'map'
                                        ? 'gradient-primary text-white'
                                        : 'bg-background text-muted-foreground hover:bg-accent'
                                        }`}
                                    title="地图视图"
                                >
                                    <MapPin className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 搜索输入区（航道图 tab 时隐藏） */}
                    {searchTab === 'poi' ? (
                        <div className="flex items-center gap-3">
                            <div className="relative flex-1 group">
                                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                    placeholder="输入名称搜索 POI..."
                                    className="w-full pl-10 pr-4 py-2.5 border border-input bg-background rounded-xl
                                             text-foreground placeholder:text-muted-foreground focus:outline-none
                                             focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
                                />
                            </div>

                            <select
                                value={platform}
                                onChange={(e) => setPlatform(e.target.value)}
                                className="px-4 py-2.5 border border-input bg-background rounded-xl text-foreground
                                         focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary cursor-pointer transition-all"
                            >
                                {Object.entries(platformNames).map(([key, name]) => (
                                    <option key={key} value={key}>{name}</option>
                                ))}
                            </select>

                            <select
                                value={mode}
                                onChange={(e) => setMode(e.target.value)}
                                className="px-4 py-2.5 border border-input bg-background rounded-xl text-foreground
                                         focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary cursor-pointer transition-all"
                            >
                                {modeOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>

                            <Button onClick={handleSearch} disabled={loading} className="gradient-primary text-white border-0 hover:opacity-90 px-6">
                                {loading ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    '搜索'
                                )}
                            </Button>
                        </div>
                    ) : searchTab === 'buoy' ? (
                        <div className="flex items-center gap-3">
                            <div className="relative flex-1 group">
                                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                                <input
                                    type="text"
                                    value={buoyQuery}
                                    onChange={(e) => setBuoyQuery(e.target.value)}
                                    placeholder="搜索航标名称、航道、地区、类型..."
                                    className="w-full pl-10 pr-4 py-2.5 border border-input bg-background rounded-xl
                                             text-foreground placeholder:text-muted-foreground focus:outline-none
                                             focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
                                />
                            </div>
                            {buoyLoading && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
                        </div>
                    ) : null}

                    {currentResults.length > 0 && searchTab !== 'chart' && (
                        <div className="mt-3 text-sm text-muted-foreground">
                            找到 <span className="font-medium text-primary">{currentResults.length}</span> 条结果
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* 结果区域 */}
            <div className={`flex-1 min-h-0 grid gap-4 ${showList && showMap ? 'grid-cols-2' : 'grid-cols-1'
                }`}>
                {/* 列表 */}
                {showList && (
                    <Card className="overflow-hidden h-full flex flex-col">
                        <CardContent className="p-0 flex-1 min-h-0">
                            {searchTab === 'poi' ? (
                                /* POI 列表 */
                                results.length > 0 ? (
                                    <SimpleBar className="h-full">
                                        {results.map((poi) => (
                                            <div
                                                key={poi.id}
                                                onClick={() => setSelectedId(poi.id)}
                                                className={`p-4 border-b border-border/50 cursor-pointer transition-all ${selectedId === poi.id
                                                    ? 'bg-primary/10 border-l-2 border-l-primary'
                                                    : 'hover:bg-accent/50'
                                                    }`}
                                            >
                                                <div className="flex items-start gap-3">
                                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${selectedId === poi.id ? 'bg-primary/20' : 'bg-muted'}`}>
                                                        <MapPin className={`w-4 h-4 ${selectedId === poi.id ? 'text-primary' : 'text-muted-foreground'
                                                            }`} />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium text-foreground truncate">{poi.name}</div>
                                                        <div className="text-sm text-muted-foreground truncate">
                                                            {poi.address || '无地址'}
                                                        </div>
                                                        <div className="flex items-center gap-2 mt-1.5">
                                                            <span className={`text-xs px-2 py-0.5 rounded-full ${platformColors[poi.platform] || 'bg-muted text-muted-foreground'}`}>
                                                                {platformNames[poi.platform] || poi.platform}
                                                            </span>
                                                            {poi.category && (
                                                                <span className="text-xs text-muted-foreground">
                                                                    {poi.category}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </SimpleBar>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                            <SearchIcon className="w-8 h-8 opacity-30" />
                                        </div>
                                        <p className="font-medium">输入关键词搜索 POI</p>
                                        <p className="text-sm mt-1">支持名称模糊搜索</p>
                                    </div>
                                )
                            ) : (
                                /* 航标列表 */
                                filteredBuoys.length > 0 ? (
                                    <SimpleBar className="h-full">
                                        {filteredBuoys.map((buoy, idx) => (
                                            <div
                                                key={buoy.id}
                                                onClick={() => setSelectedId(idx)}
                                                className={`p-3 border-b border-border/50 cursor-pointer transition-all ${selectedId === idx
                                                    ? 'bg-blue-500/10 border-l-2 border-l-blue-500'
                                                    : 'hover:bg-accent/50'
                                                    }`}
                                            >
                                                <div className="flex items-start gap-3">
                                                    <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${selectedId === idx ? 'bg-blue-500/20' : 'bg-muted'}`}>
                                                        <Anchor className={`w-3 h-3 ${selectedId === idx ? 'text-blue-500' : 'text-muted-foreground'}`} />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium text-foreground truncate">{buoy.name || buoy.id}</div>
                                                        <div className="flex items-center gap-2 mt-1">
                                                            {buoy.waterway && (
                                                                <span className="text-xs px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600">{buoy.waterway}</span>
                                                            )}
                                                            {buoy.region && (
                                                                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">{buoy.region}</span>
                                                            )}
                                                            {buoy.shape && (
                                                                <span className="text-xs text-muted-foreground">{buoy.shape}</span>
                                                            )}
                                                        </div>
                                                        {buoy.lon_84 && buoy.lat_84 && (
                                                            <div className="text-xs text-muted-foreground mt-1 font-mono">
                                                                {buoy.lon_84.toFixed(6)}, {buoy.lat_84.toFixed(6)}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </SimpleBar>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                            <Anchor className="w-8 h-8 opacity-30" />
                                        </div>
                                        <p className="font-medium">{buoyLoading ? '加载航标数据中...' : buoyQuery ? '未找到匹配的航标' : '输入关键词搜索航标'}</p>
                                        <p className="text-sm mt-1">支持名称、航道、地区搜索</p>
                                    </div>
                                )
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* 地图 */}
                {showMap && (
                    <Card className="overflow-hidden h-full">
                        <CardContent className="p-0 h-full">
                            <div className="h-full w-full">
                            <POIMap
                                    pois={currentResults}
                                    selectedId={selectedId}
                                    onMarkerClick={handleMarkerClick}
                                    showChartOverlay={searchTab === 'chart' && showChartOverlay}
                                    chartTilePath={chartTilePath}
                                    chartBounds={searchTab === 'chart' ? chartBounds : undefined}
                                />
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
