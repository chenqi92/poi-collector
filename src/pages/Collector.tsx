import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Play, Pause, Square, RotateCcw, Loader2, MapPin, Settings2, Globe, Map, Navigation, MapPinned, Terminal, Anchor, Ship } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SettingsDialog } from '@/components/SettingsDialog';
import { CategoryConfigDialog } from '@/components/CategoryConfigDialog';
import { useToast } from '@/components/ui/toast';
import SimpleBar from 'simplebar-react';

interface SelectedRegion {
    code: string;
    name: string;
    level: string;
}

interface CollectorStatus {
    platform: string;
    status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
    total_collected: number;
    completed_categories: string[];
    current_category_id: string;
    error_message?: string;
}

interface Category {
    id: string;
    name: string;
    keywords: string[];
}

// Platform configuration with metadata
const platforms = [
    { id: 'tianditu', name: '天地图', needsApiKey: true, icon: MapPinned, gradient: 'from-cyan-500 to-cyan-600', bgGradient: 'from-cyan-500/10 to-cyan-600/5' },
    { id: 'amap', name: '高德地图', needsApiKey: true, icon: Map, gradient: 'from-indigo-500 to-indigo-600', bgGradient: 'from-indigo-500/10 to-indigo-600/5' },
    { id: 'baidu', name: '百度地图', needsApiKey: true, icon: Navigation, gradient: 'from-red-500 to-red-600', bgGradient: 'from-red-500/10 to-red-600/5' },
    { id: 'osm', name: 'OpenStreetMap', needsApiKey: false, icon: Globe, gradient: 'from-emerald-500 to-emerald-600', bgGradient: 'from-emerald-500/10 to-emerald-600/5' },
];

const platformNames: Record<string, string> = Object.fromEntries(
    platforms.map(p => [p.id, p.name])
);

const statusConfig = {
    idle: { text: '未开始', color: 'text-muted-foreground', bg: 'bg-muted' },
    running: { text: '采集中', color: 'text-primary', bg: 'bg-primary/10' },
    paused: { text: '已暂停', color: 'text-amber-500', bg: 'bg-amber-500/10' },
    completed: { text: '已完成', color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    error: { text: '出错', color: 'text-destructive', bg: 'bg-destructive/10' },
};

export default function Collector() {
    const [statuses, setStatuses] = useState<Record<string, CollectorStatus>>({});
    const [categories, setCategories] = useState<Category[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<Record<string, string[]>>({});
    const [logs, setLogs] = useState<string[]>([]);
    const [selectedRegions, setSelectedRegions] = useState<SelectedRegion[]>([]);
    const [categoryDialogPlatform, setCategoryDialogPlatform] = useState<string | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [apiKeys, setApiKeys] = useState<Record<string, { id: number; api_key: string }[]>>({});
    const { warning, error: showError, success } = useToast();

    // 航标采集状态
    const [buoyCount, setBuoyCount] = useState(0);
    const [buoyStatus, setBuoyStatus] = useState<string>('idle');
    const [buoyProgress, setBuoyProgress] = useState({ current: 0, total: 0, message: '' });
    const [buoyGridStep, setBuoyGridStep] = useState(0.1);

    useEffect(() => {
        try {
            const saved = localStorage.getItem('poi_selected_regions');
            if (saved) setSelectedRegions(JSON.parse(saved));
        } catch (e) { console.error(e); }
    }, []);

    useEffect(() => {
        loadData();
        const interval = setInterval(loadStatuses, 2000);
        const unlisten = listen<string>('collector-log', (event) => {
            setLogs(prev => [...prev.slice(-99), event.payload]);
        });
        // 航标采集进度事件
        const unlistenBuoy = listen<{ task_type: string; status: string; current: number; total: number; message: string | null }>('chart-progress', (event) => {
            const p = event.payload;
            if (p.task_type === 'buoy') {
                setBuoyProgress({ current: p.current, total: p.total, message: p.message || '' });
                setBuoyStatus(p.status === 'completed' ? 'idle' : 'running');
                if (p.status === 'completed') {
                    loadBuoyCount();
                }
            }
        });
        // 航标日志事件
        const unlistenBuoyLog = listen<string>('chart-log', (event) => {
            setLogs(prev => [...prev.slice(-99), `[航标] ${event.payload}`]);
        });
        loadBuoyCount();
        return () => {
            clearInterval(interval);
            unlisten.then(fn => fn());
            unlistenBuoy.then(fn => fn());
            unlistenBuoyLog.then(fn => fn());
        };
    }, []);

    const loadData = async () => {
        try {
            const [statusData, categoriesData, apiKeysData] = await Promise.all([
                invoke<Record<string, CollectorStatus>>('get_collector_statuses'),
                invoke<Category[]>('get_categories'),
                invoke<Record<string, { id: number; api_key: string }[]>>('get_api_keys'),
            ]);
            setStatuses(statusData);
            setCategories(categoriesData);
            setApiKeys(apiKeysData);
            const initial: Record<string, string[]> = {};
            platforms.forEach(p => {
                initial[p.id] = categoriesData.map(c => c.id);
            });
            setSelectedCategories(initial);
        } catch (e) { console.error(e); }
    };

    const loadStatuses = async () => {
        try {
            const data = await invoke<Record<string, CollectorStatus>>('get_collector_statuses');
            setStatuses(data);
        } catch (e) { console.error(e); }
    };

    const startCollector = async (platform: string) => {
        // 检查 API Key (OSM 不需要)
        const platformConfig = platforms.find(p => p.id === platform);
        if (platformConfig?.needsApiKey) {
            const platformKeys = apiKeys[platform] || [];
            if (platformKeys.length === 0) {
                warning('未配置 API Key', `请先在设置中配置 ${platformNames[platform]} 的 API Key`);
                setShowSettings(true);
                return;
            }
        }

        // 检查地区
        if (selectedRegions.length === 0) {
            warning('未选择地区', '请先在设置中选择要采集的地区');
            setShowSettings(true);
            return;
        }

        // 检查类别
        if ((selectedCategories[platform]?.length || 0) === 0) {
            warning('未选择类别', '请先选择要采集的类别');
            return;
        }

        try {
            await invoke('start_collector', {
                platform,
                categories: selectedCategories[platform],
                regions: selectedRegions.map(r => r.code),
            });
            success('开始采集', `${platformNames[platform]} 已开始采集`);
            loadStatuses();
        } catch (e: unknown) {
            showError('采集失败', String(e));
        }
    };

    const pauseCollector = async (platform: string) => {
        try {
            await invoke('stop_collector', { platform });
            success('已暂停', `${platformNames[platform]} 采集已暂停，可稍后继续`);
            loadStatuses();
        } catch (e) { console.error(e); }
    };

    const fullStopCollector = async (platform: string) => {
        if (!confirm('停止后需要从头开始采集，确定要停止吗？')) return;
        try {
            await invoke('stop_collector', { platform });
            await invoke('reset_collector', { platform });
            success('已停止', `${platformNames[platform]} 采集已完全停止`);
            loadStatuses();
        } catch (e) { console.error(e); }
    };

    const resetCollector = async (platform: string) => {
        if (!confirm('确定要重置采集进度吗？将清空已采集的类别记录。')) return;
        try {
            await invoke('reset_collector', { platform });
            success('已重置', `${platformNames[platform]} 采集进度已重置`);
            loadStatuses();
        } catch (e) { console.error(e); }
    };

    // === 航标采集 ===
    const loadBuoyCount = async () => {
        try {
            const count = await invoke<number>('chart_get_buoy_count');
            setBuoyCount(count);
        } catch (e) { console.error(e); }
    };

    // 从选中地区推导经纬度范围
    // 长江航道主要覆盖：武汉 → 宜昌 → 荆州 → 岳阳 → 九江
    const REGION_BOUNDS: Record<string, { west: number; south: number; east: number; north: number }> = {
        // 湖北省及其主要城市
        '420000': { west: 108.3, south: 29.0, east: 116.1, north: 33.3 },
        '420100': { west: 113.7, south: 29.97, east: 115.08, north: 31.36 }, // 武汉
        '420500': { west: 110.15, south: 29.56, east: 112.18, north: 31.75 }, // 宜昌
        '421000': { west: 111.15, south: 29.26, east: 114.01, north: 30.65 }, // 荆州
        '420600': { west: 112.31, south: 30.23, east: 113.32, north: 30.71 }, // 襄阳
        '420700': { west: 113.52, south: 30.07, east: 114.87, north: 30.71 }, // 鄂州
        '420200': { west: 114.32, south: 29.71, east: 115.43, north: 30.24 }, // 黄石
        '421200': { west: 114.87, south: 29.83, east: 116.07, north: 31.22 }, // 咸宁
        '421100': { west: 114.25, south: 29.83, east: 116.07, north: 31.06 }, // 黄冈
        // 湖南省及其主要城市
        '430000': { west: 108.8, south: 24.6, east: 114.3, north: 30.1 },
        '430600': { west: 113.08, south: 28.88, east: 113.85, north: 29.69 }, // 岳阳
        '430100': { west: 111.88, south: 27.85, east: 114.26, north: 28.67 }, // 长沙
        // 江西省
        '360000': { west: 113.6, south: 24.5, east: 118.5, north: 30.1 },
        '360400': { west: 115.22, south: 29.03, east: 116.82, north: 29.96 }, // 九江
    };

    const deriveBoundsFromRegions = (): { west: number; south: number; east: number; north: number } | null => {
        if (selectedRegions.length === 0) return null;

        let west = 180, south = 90, east = -180, north = -90;
        let hasMatch = false;

        for (const region of selectedRegions) {
            const b = REGION_BOUNDS[region.code];
            if (b) {
                west = Math.min(west, b.west);
                south = Math.min(south, b.south);
                east = Math.max(east, b.east);
                north = Math.max(north, b.north);
                hasMatch = true;
            }
        }

        // 如果没有精确匹配，使用默认范围（荆州-岳阳航段）
        if (!hasMatch) {
            return { west: 111.37, south: 29.23, east: 114.01, north: 30.37 };
        }

        return { west, south, east, north };
    };

    const startBuoyCollection = async () => {
        const bounds = deriveBoundsFromRegions();
        if (!bounds) {
            warning('未选择地区', '请先在设置中选择要采集的地区');
            setShowSettings(true);
            return;
        }

        try {
            setBuoyStatus('running');
            await invoke('chart_start_buoy_collection', {
                west: bounds.west,
                south: bounds.south,
                east: bounds.east,
                north: bounds.north,
                gridStep: buoyGridStep,
            });
            success('航标采集已启动', `范围: [${bounds.west.toFixed(2)},${bounds.south.toFixed(2)}]-[${bounds.east.toFixed(2)},${bounds.north.toFixed(2)}]`);
        } catch (e: unknown) {
            setBuoyStatus('idle');
            showError('航标采集失败', String(e));
        }
    };

    const stopBuoyCollection = async () => {
        try {
            await invoke('chart_stop_collection');
            setBuoyStatus('idle');
            success('已停止', '航标采集已停止');
            loadBuoyCount();
        } catch (e) { console.error(e); }
    };



    const overallStats = useMemo(() => {
        let totalCollected = 0;
        let runningCount = 0;
        Object.values(statuses).forEach(s => {
            totalCollected += s.total_collected || 0;
            if (s.status === 'running') runningCount++;
        });
        return { totalCollected, runningCount };
    }, [statuses]);
    // 日志面板宽度
    const [logWidth, setLogWidth] = useState(380);
    const isDragging = useRef(false);
    const startX = useRef(0);
    const startWidth = useRef(0);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true;
        startX.current = e.clientX;
        startWidth.current = logWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;
            const delta = startX.current - e.clientX;
            const newWidth = Math.max(280, Math.min(700, startWidth.current + delta));
            setLogWidth(newWidth);
        };
        const handleMouseUp = () => {
            isDragging.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [logWidth]);

    return (
        <div className="h-full flex flex-col gap-3">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据采集</h1>
                    <p className="text-sm text-muted-foreground">多平台 POI / 航标数据采集与管理</p>
                </div>
                <div className="flex items-center gap-4">
                    <div className="text-right">
                        <div className="text-2xl font-bold text-foreground">
                            {overallStats.totalCollected.toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">总采集量</div>
                    </div>
                    {overallStats.runningCount > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-lg border border-primary/20 animate-pulse-glow">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            <span className="text-primary text-xs font-medium">
                                {overallStats.runningCount} 个任务运行中
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* 左右分栏主体 */}
            <div className="flex-1 flex gap-0 min-h-0">
                {/* 左侧：采集配置 */}
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    <SimpleBar className="flex-1 min-h-0">
                        <div className="space-y-3 pr-3">
                            {/* 地区配置提示 - 紧凑版 */}
                            <div className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${selectedRegions.length > 0 ? 'border-primary/30 bg-primary/5' : 'border-destructive/30 bg-destructive/5'}`}>
                                <div className="flex items-center gap-2">
                                    <MapPin className={`w-4 h-4 ${selectedRegions.length > 0 ? 'text-primary' : 'text-destructive'}`} />
                                    <span className={`text-sm font-medium ${selectedRegions.length > 0 ? 'text-foreground' : 'text-destructive'}`}>
                                        {selectedRegions.length > 0
                                            ? `${selectedRegions.slice(0, 3).map(r => r.name).join('、')}${selectedRegions.length > 3 ? ` 等${selectedRegions.length}个` : ''}`
                                            : '未配置采集地区'}
                                    </span>
                                </div>
                                <Button variant="outline" size="sm" onClick={() => setShowSettings(true)} className="h-7 text-xs">
                                    管理地区
                                </Button>
                            </div>

                            {/* 平台采集卡片 - 紧凑版 */}
                            <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
                                {platforms.map((platformConfig) => {
                                    const platform = platformConfig.id;
                                    const PlatformIcon = platformConfig.icon;
                                    const status = statuses[platform] || { status: 'idle', total_collected: 0, completed_categories: [] };
                                    const config = statusConfig[status.status] || statusConfig.idle;
                                    const selectedCount = selectedCategories[platform]?.length || 0;
                                    const hasApiKey = !platformConfig.needsApiKey || (apiKeys[platform]?.length || 0) > 0;
                                    const isRunning = status.status === 'running';
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const st = status as any;
                                    const totalCats = st.total_categories || selectedCount;
                                    const progress = totalCats > 0
                                        ? isRunning
                                            ? ((st.current_category_index || 0) + 0.5) / totalCats * 100
                                            : (status.completed_categories?.length || 0) / totalCats * 100
                                        : 0;

                                    return (
                                        <Card
                                            key={platform}
                                            className={`overflow-hidden relative transition-all duration-300 ${!hasApiKey ? 'opacity-75' : ''} ${isRunning ? 'animate-pulse-glow' : ''}`}
                                        >
                                            <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${platformConfig.gradient}`} />
                                            <div className={`absolute inset-0 bg-gradient-to-br ${platformConfig.bgGradient} pointer-events-none`} />

                                            <div className="p-3 relative space-y-2.5">
                                                {/* 标题行 */}
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-1.5">
                                                        <div className={`w-6 h-6 rounded bg-gradient-to-r ${platformConfig.gradient} flex items-center justify-center`}>
                                                            <PlatformIcon className="w-3.5 h-3.5 text-white" />
                                                        </div>
                                                        <span className="text-sm font-medium">{platformConfig.name}</span>
                                                    </div>
                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${config.bg} ${config.color}`}>
                                                        {config.text}
                                                    </span>
                                                </div>

                                                {/* 进度条 */}
                                                <div>
                                                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                                        <div
                                                            className={`h-full bg-gradient-to-r ${platformConfig.gradient} transition-all duration-300 ${isRunning ? 'progress-bar-striped' : ''}`}
                                                            style={{ width: `${progress}%` }}
                                                        />
                                                    </div>
                                                    <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                                                        <span>{status.completed_categories?.length || 0}/{categories.length} 类</span>
                                                        <span>已采: {status.total_collected?.toLocaleString() || 0}</span>
                                                    </div>
                                                </div>

                                                {/* 类别 + 按钮合并行 */}
                                                <div className="flex items-center gap-1.5">
                                                    <button
                                                        onClick={() => setCategoryDialogPlatform(platform)}
                                                        className="flex items-center gap-1 px-2 py-1 text-[10px] border border-border/50 rounded hover:bg-accent/50 transition-all cursor-pointer"
                                                    >
                                                        <Settings2 className="w-3 h-3" />
                                                        <span className="text-muted-foreground">
                                                            ({selectedCategories[platform]?.length || 0}/{categories.length})
                                                        </span>
                                                    </button>
                                                    <div className="flex-1 flex gap-1 justify-end">
                                                        {status.status === 'running' ? (
                                                            <>
                                                                <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => pauseCollector(platform)}>
                                                                    <Pause className="w-3 h-3 mr-0.5" />暂停
                                                                </Button>
                                                                <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2" onClick={() => fullStopCollector(platform)}>
                                                                    <Square className="w-3 h-3" />
                                                                </Button>
                                                            </>
                                                        ) : status.status === 'paused' ? (
                                                            <>
                                                                <Button size="sm" className="h-6 text-[10px] px-2 gradient-primary text-white border-0" onClick={() => startCollector(platform)}>
                                                                    <Play className="w-3 h-3 mr-0.5" />继续
                                                                </Button>
                                                                <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2" onClick={() => fullStopCollector(platform)}>
                                                                    <Square className="w-3 h-3" />
                                                                </Button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Button size="sm" className="h-6 text-[10px] px-2 gradient-primary text-white border-0" onClick={() => startCollector(platform)}>
                                                                    <Play className="w-3 h-3 mr-0.5" />{status.status === 'completed' ? '重采' : '采集'}
                                                                </Button>
                                                                <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => resetCollector(platform)}
                                                                    disabled={status.status === 'idle' || status.total_collected === 0}>
                                                                    <RotateCcw className="w-3 h-3" />
                                                                </Button>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>

                                                {status.error_message && (
                                                    <div className="p-1.5 bg-destructive/10 border border-destructive/30 rounded text-destructive text-[10px] truncate" title={status.error_message}>
                                                        {status.error_message}
                                                    </div>
                                                )}
                                            </div>
                                        </Card>
                                    );
                                })}
                            </div>

                            {/* 航标采集卡片 - 紧凑版 */}
                            <Card className="overflow-hidden relative">
                                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-cyan-400" />
                                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-cyan-400/5 pointer-events-none" />
                                <div className="p-3 relative space-y-2.5">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5">
                                            <div className="w-6 h-6 rounded bg-gradient-to-r from-blue-500 to-cyan-400 flex items-center justify-center">
                                                <Anchor className="w-3.5 h-3.5 text-white" />
                                            </div>
                                            <span className="text-sm font-medium">航标数据采集</span>
                                            <span className="text-[10px] text-muted-foreground">· 长江航道</span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-500">
                                                {buoyCount.toLocaleString()} 条
                                            </span>
                                            {buoyStatus === 'running' && (
                                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary animate-pulse">
                                                    采集中
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* 范围 + 步长 + 按钮 */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {selectedRegions.length > 0 && (
                                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/50 rounded px-2 py-1">
                                                <Ship className="w-3 h-3" />
                                                <span>{selectedRegions.slice(0, 2).map(r => r.name).join('、')}{selectedRegions.length > 2 ? ' 等' : ''}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-1">
                                            <span className="text-[10px] text-muted-foreground">步长</span>
                                            <select
                                                value={buoyGridStep}
                                                onChange={(e) => setBuoyGridStep(parseFloat(e.target.value))}
                                                disabled={buoyStatus === 'running'}
                                                className="border border-input bg-background rounded px-1.5 py-0.5 text-[10px] h-6"
                                            >
                                                <option value={0.05}>0.05°</option>
                                                <option value={0.1}>0.1°</option>
                                                <option value={0.2}>0.2°</option>
                                                <option value={0.5}>0.5°</option>
                                            </select>
                                        </div>
                                        <div className="flex-1" />
                                        {buoyStatus === 'running' ? (
                                            <Button size="sm" variant="destructive" className="h-6 text-[10px] px-3" onClick={stopBuoyCollection}>
                                                <Square className="w-3 h-3 mr-1" />停止
                                            </Button>
                                        ) : (
                                            <Button size="sm" className="h-6 text-[10px] px-3 gradient-primary text-white border-0" onClick={startBuoyCollection}>
                                                <Play className="w-3 h-3 mr-1" />采集
                                            </Button>
                                        )}
                                    </div>

                                    {/* 进度条 - 始终显示 */}
                                    {buoyProgress.total > 0 && (
                                        <div>
                                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full transition-all duration-300 ${buoyStatus === 'running' ? 'bg-gradient-to-r from-blue-500 to-cyan-400 progress-bar-striped' : 'bg-blue-500/50'}`}
                                                    style={{ width: `${(buoyProgress.current / buoyProgress.total) * 100}%` }}
                                                />
                                            </div>
                                            <div className="flex justify-between mt-0.5 text-[10px] text-muted-foreground">
                                                <span>{buoyProgress.current}/{buoyProgress.total}</span>
                                                <span>{buoyProgress.message}</span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </Card>
                        </div>
                    </SimpleBar>
                </div>

                {/* 可拖动分隔条 */}
                <div
                    className="w-1.5 shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-primary/10 transition-colors rounded"
                    onMouseDown={handleMouseDown}
                >
                    <div className="w-0.5 h-8 bg-border group-hover:bg-primary/50 rounded-full transition-colors" />
                </div>

                {/* 右侧：采集日志 */}
                <div className="shrink-0 flex flex-col min-h-0" style={{ width: logWidth }}>
                    <Card className="flex-1 flex flex-col overflow-hidden min-h-0 bg-[hsl(222,47%,4%)] border-[hsl(222,47%,12%)]">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-[hsl(222,47%,12%)] bg-[hsl(222,47%,6%)] shrink-0">
                            <Terminal className="w-3.5 h-3.5 text-blue-400" />
                            <span className="text-sm font-medium text-gray-200">采集日志</span>
                            {logs.length > 0 && (
                                <span className="text-[10px] text-gray-500 ml-auto">
                                    {logs.length} 条
                                </span>
                            )}
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden bg-[hsl(222,47%,4%)]">
                            <SimpleBar className="h-full">
                                <div className="terminal-bg p-2 font-mono text-[11px] min-h-full select-text cursor-text">
                                    {logs.length > 0 ? (
                                        logs.map((log, i) => (
                                            <div key={i} className="text-gray-400 py-px hover:bg-white/5 px-1.5 -mx-1.5 rounded leading-relaxed">
                                                <span className="text-gray-600 mr-1.5 select-none">{String(i + 1).padStart(3, '0')}</span>
                                                {log}
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-gray-500 flex items-center gap-2 p-2">
                                            <span className="inline-block w-1.5 h-3.5 bg-primary/50 animate-pulse" />
                                            等待采集开始...
                                        </div>
                                    )}
                                </div>
                            </SimpleBar>
                        </div>
                    </Card>
                </div>
            </div>

            {/* Settings Dialog */}
            <SettingsDialog
                open={showSettings}
                onOpenChange={setShowSettings}
                onRegionsChange={setSelectedRegions}
            />

            {/* Category Config Dialog */}
            <CategoryConfigDialog
                open={categoryDialogPlatform !== null}
                platformName={categoryDialogPlatform ? platformNames[categoryDialogPlatform] : ''}
                categories={categories}
                selectedCategories={selectedCategories[categoryDialogPlatform || ''] || []}
                onClose={() => setCategoryDialogPlatform(null)}
                onChange={(ids) => {
                    if (categoryDialogPlatform) {
                        setSelectedCategories(prev => ({
                            ...prev,
                            [categoryDialogPlatform]: ids
                        }));
                    }
                }}
            />
        </div>
    );
}

