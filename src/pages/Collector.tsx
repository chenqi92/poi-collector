import { useEffect, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Play, Square, RotateCcw, Loader2, MapPin, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsDialog } from '@/components/SettingsDialog';

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

const platformNames: Record<string, string> = {
    tianditu: '天地图',
    amap: '高德地图',
    baidu: '百度地图',
};

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
    const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
    const [showSettings, setShowSettings] = useState(false);

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
            const [statusData, categoriesData] = await Promise.all([
                invoke<Record<string, CollectorStatus>>('get_collector_statuses'),
                invoke<Category[]>('get_categories'),
            ]);
            setStatuses(statusData);
            setCategories(categoriesData);
            const initial: Record<string, string[]> = {};
            ['tianditu', 'amap', 'baidu'].forEach(p => {
                initial[p] = categoriesData.map(c => c.id);
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
        if (selectedRegions.length === 0) {
            alert('请先在"地区"页面选择要采集的地区');
            return;
        }
        try {
            await invoke('start_collector', {
                platform,
                categories: selectedCategories[platform],
                regions: selectedRegions.map(r => r.code),
            });
            loadStatuses();
        } catch (e: unknown) {
            alert(String(e));
        }
    };

    const stopCollector = async (platform: string) => {
        try {
            await invoke('stop_collector', { platform });
            loadStatuses();
        } catch (e) { console.error(e); }
    };

    const resetCollector = async (platform: string) => {
        if (!confirm('确定要重置采集进度吗？')) return;
        try {
            await invoke('reset_collector', { platform });
            loadStatuses();
        } catch (e) { console.error(e); }
    };

    const toggleCategory = (platform: string, categoryId: string) => {
        setSelectedCategories(prev => {
            const current = prev[platform] || [];
            if (current.includes(categoryId)) {
                return { ...prev, [platform]: current.filter(id => id !== categoryId) };
            } else {
                return { ...prev, [platform]: [...current, categoryId] };
            }
        });
    };

    const toggleAllCategories = (platform: string, selectAll: boolean) => {
        setSelectedCategories(prev => ({
            ...prev,
            [platform]: selectAll ? categories.map(c => c.id) : [],
        }));
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
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {['tianditu', 'amap', 'baidu'].map((platform) => {
                    const status = statuses[platform] || { status: 'idle', total_collected: 0, completed_categories: [] };
                    const config = statusConfig[status.status] || statusConfig.idle;
                    // 使用选中的类别数量计算进度，而非全部类别数量
                    const selectedCount = selectedCategories[platform]?.length || 0;
                    const progress = selectedCount > 0
                        ? (status.completed_categories?.length || 0) / selectedCount * 100
                        : 0;
                    const isExpanded = expandedPlatform === platform;

                    return (
                        <Card key={platform}>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-lg">{platformNames[platform]}</CardTitle>
                                    <span className={`px-2 py-1 rounded text-xs font-medium 
                                        ${status.status === 'running' ? 'bg-primary/10 text-primary' :
                                            status.status === 'error' ? 'bg-destructive/10 text-destructive' :
                                                'bg-muted text-muted-foreground'}`}>
                                        {config.text}
                                    </span>
                                </div>
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
                                <div className="border rounded-lg">
                                    <button
                                        onClick={() => setExpandedPlatform(isExpanded ? null : platform)}
                                        className="w-full flex items-center justify-between p-3 hover:bg-accent transition-colors"
                                    >
                                        <span className="flex items-center gap-2 text-sm">
                                            <Settings2 className="w-4 h-4" />
                                            类别配置
                                            <span className="text-muted-foreground">
                                                ({selectedCategories[platform]?.length || 0}/{categories.length})
                                            </span>
                                        </span>
                                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </button>

                                    {isExpanded && (
                                        <div className="p-3 border-t bg-muted/30">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-xs text-muted-foreground">选择采集类别</span>
                                                <label className="flex items-center gap-1 text-xs text-primary cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedCategories[platform]?.length === categories.length}
                                                        onChange={(e) => toggleAllCategories(platform, e.target.checked)}
                                                        className="rounded"
                                                    />
                                                    全选
                                                </label>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                                                {categories.map((cat) => (
                                                    <label
                                                        key={cat.id}
                                                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs 
                                                                  cursor-pointer transition-colors border ${selectedCategories[platform]?.includes(cat.id)
                                                                ? 'bg-primary/10 text-primary border-primary/30'
                                                                : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                                                            }`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            className="hidden"
                                                            checked={selectedCategories[platform]?.includes(cat.id)}
                                                            onChange={() => toggleCategory(platform, cat.id)}
                                                        />
                                                        {cat.name}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* 操作按钮 */}
                                <div className="flex gap-2">
                                    <Button
                                        className="flex-1"
                                        onClick={() => startCollector(platform)}
                                        disabled={status.status === 'running'}
                                    >
                                        {status.status === 'running' ? (
                                            <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                        ) : (
                                            <Play className="w-4 h-4 mr-2" />
                                        )}
                                        {status.status === 'running' ? '采集中' : '开始'}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        onClick={() => stopCollector(platform)}
                                        disabled={status.status !== 'running'}
                                    >
                                        <Square className="w-4 h-4" />
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        size="icon"
                                        onClick={() => resetCollector(platform)}
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                    </Button>
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
        </div>
    );
}
