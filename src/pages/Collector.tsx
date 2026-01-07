import { useEffect, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Play, Pause, Square, RotateCcw, Loader2, MapPin, Settings2, Globe, Map, Navigation, MapPinned } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsDialog } from '@/components/SettingsDialog';
import { CategoryConfigDialog } from '@/components/CategoryConfigDialog';
import { useToast } from '@/components/ui/toast';

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
    { id: 'tianditu', name: '天地图', needsApiKey: true, icon: MapPinned, color: 'text-blue-500' },
    { id: 'amap', name: '高德地图', needsApiKey: true, icon: Map, color: 'text-green-500' },
    { id: 'baidu', name: '百度地图', needsApiKey: true, icon: Navigation, color: 'text-red-500' },
    { id: 'osm', name: 'OpenStreetMap', needsApiKey: false, icon: Globe, color: 'text-emerald-500' },
];

const platformNames: Record<string, string> = Object.fromEntries(
    platforms.map(p => [p.id, p.name])
);

const statusConfig = {
    idle: { text: '未开始', variant: 'secondary' as const },
    running: { text: '采集中', variant: 'default' as const },
    paused: { text: '已暂停', variant: 'outline' as const },
    completed: { text: '已完成', variant: 'secondary' as const },
    error: { text: '出错', variant: 'destructive' as const },
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
        return () => {
            clearInterval(interval);
            unlisten.then(fn => fn());
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



    const overallStats = useMemo(() => {
        let totalCollected = 0;
        let runningCount = 0;
        Object.values(statuses).forEach(s => {
            totalCollected += s.total_collected || 0;
            if (s.status === 'running') runningCount++;
        });
        return { totalCollected, runningCount };
    }, [statuses]);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据采集</h1>
                    <p className="text-muted-foreground">从各平台采集 POI 数据</p>
                </div>
                <div className="flex items-center gap-4">
                    <div className="text-right">
                        <div className="text-2xl font-bold text-foreground">
                            {overallStats.totalCollected.toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">总采集量</div>
                    </div>
                    {overallStats.runningCount > 0 && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 rounded-lg">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            <span className="text-primary text-sm">
                                {overallStats.runningCount} 个任务运行中
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* 地区配置提示 */}
            <Card className={selectedRegions.length > 0 ? 'border-primary/30' : 'border-destructive/30'}>
                <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <MapPin className={`w-5 h-5 ${selectedRegions.length > 0 ? 'text-primary' : 'text-destructive'
                                }`} />
                            <div>
                                <div className={`font-medium ${selectedRegions.length > 0 ? 'text-foreground' : 'text-destructive'
                                    }`}>
                                    {selectedRegions.length > 0
                                        ? `已选择 ${selectedRegions.length} 个地区`
                                        : '未配置采集地区'
                                    }
                                </div>
                                <div className="text-sm text-muted-foreground">
                                    {selectedRegions.length > 0
                                        ? selectedRegions.slice(0, 5).map(r => r.name).join('、') +
                                        (selectedRegions.length > 5 ? ` 等` : '')
                                        : '请先在设置中选择要采集的地区'
                                    }
                                </div>
                            </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
                            管理地区
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* 平台采集卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {platforms.map((platformConfig) => {
                    const platform = platformConfig.id;
                    const PlatformIcon = platformConfig.icon;
                    const status = statuses[platform] || { status: 'idle', total_collected: 0, completed_categories: [] };
                    const config = statusConfig[status.status] || statusConfig.idle;
                    // 使用选中的类别数量计算进度，而非全部类别数量
                    const selectedCount = selectedCategories[platform]?.length || 0;
                    const progress = selectedCount > 0
                        ? (status.completed_categories?.length || 0) / selectedCount * 100
                        : 0;
                    const hasApiKey = !platformConfig.needsApiKey || (apiKeys[platform]?.length || 0) > 0;


                    return (
                        <Card key={platform} className={!hasApiKey ? 'opacity-75' : ''}>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <PlatformIcon className={`w-5 h-5 ${platformConfig.color}`} />
                                        <CardTitle className="text-base">{platformConfig.name}</CardTitle>
                                    </div>
                                    <span className={`px-2 py-1 rounded text-xs font-medium 
                                        ${status.status === 'running' ? 'bg-primary/10 text-primary' :
                                            status.status === 'error' ? 'bg-destructive/10 text-destructive' :
                                                'bg-muted text-muted-foreground'}`}>
                                        {config.text}
                                    </span>
                                </div>
                                {!platformConfig.needsApiKey && (
                                    <span className="text-xs text-emerald-600 dark:text-emerald-400">免费 · 无需 API Key</span>
                                )}
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {/* 进度条 */}
                                <div>
                                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-primary transition-all duration-300"
                                            style={{ width: `${progress}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                                        <span>{status.completed_categories?.length || 0} / {categories.length} 类别</span>
                                        <span>已采集: {status.total_collected?.toLocaleString() || 0}</span>
                                    </div>
                                </div>

                                {/* 类别配置 */}
                                <button
                                    onClick={() => setCategoryDialogPlatform(platform)}
                                    className="w-full flex items-center justify-between p-3 border rounded-lg hover:bg-accent transition-colors"
                                >
                                    <span className="flex items-center gap-2 text-sm">
                                        <Settings2 className="w-4 h-4" />
                                        类别配置
                                        <span className="text-muted-foreground">
                                            ({selectedCategories[platform]?.length || 0}/{categories.length})
                                        </span>
                                    </span>
                                </button>

                                {/* 操作按钮 */}
                                <div className="flex gap-2">
                                    {status.status === 'running' ? (
                                        <>
                                            {/* 采集中：显示暂停和停止 */}
                                            <Button
                                                className="flex-1"
                                                variant="outline"
                                                onClick={() => pauseCollector(platform)}
                                            >
                                                <Pause className="w-4 h-4 mr-2" />
                                                暂停
                                            </Button>
                                            <Button
                                                variant="destructive"
                                                onClick={() => fullStopCollector(platform)}
                                            >
                                                <Square className="w-4 h-4 mr-2" />
                                                停止
                                            </Button>
                                        </>
                                    ) : status.status === 'paused' ? (
                                        <>
                                            {/* 已暂停：显示继续和停止 */}
                                            <Button
                                                className="flex-1"
                                                onClick={() => startCollector(platform)}
                                            >
                                                <Play className="w-4 h-4 mr-2" />
                                                继续
                                            </Button>
                                            <Button
                                                variant="destructive"
                                                onClick={() => fullStopCollector(platform)}
                                            >
                                                <Square className="w-4 h-4 mr-2" />
                                                停止
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            {/* 未开始/已完成/出错：显示开始和重置 */}
                                            <Button
                                                className="flex-1"
                                                onClick={() => startCollector(platform)}
                                            >
                                                <Play className="w-4 h-4 mr-2" />
                                                {status.status === 'completed' ? '重新开始' : '开始采集'}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                onClick={() => resetCollector(platform)}
                                                disabled={status.status === 'idle' || status.total_collected === 0}
                                            >
                                                <RotateCcw className="w-4 h-4 mr-2" />
                                                重置
                                            </Button>
                                        </>
                                    )}
                                </div>

                                {status.error_message && (
                                    <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-destructive text-sm">
                                        {status.error_message}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            {/* 采集日志 */}
            <Card>
                <CardHeader>
                    <CardTitle>采集日志</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="bg-muted rounded-lg p-4 h-48 overflow-y-auto font-mono text-sm">
                        {logs.length > 0 ? (
                            logs.map((log, i) => (
                                <div key={i} className="text-muted-foreground py-0.5 hover:bg-accent/50">
                                    {log}
                                </div>
                            ))
                        ) : (
                            <div className="text-muted-foreground flex items-center gap-2">
                                等待采集开始...
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Settings Dialog */}
            <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

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
