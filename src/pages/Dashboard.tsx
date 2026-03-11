import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, MapPin, Globe, BarChart3, Loader2, Map, TrendingUp, Anchor, Ship, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import SimpleBar from 'simplebar-react';

interface Stats {
    total: number;
    by_platform: Record<string, number>;
    by_category: Record<string, number>;
}

interface Region {
    code: string;
    name: string;
    level: string;
    parent_code: string | null;
}

interface TileStats {
    total: number;
    by_layer: [string, number][];
}

export default function Dashboard() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [regionStats, setRegionStats] = useState<[string, number][]>([]);
    const [regionNames, setRegionNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [buoyCount, setBuoyCount] = useState(0);
    const [buoyStats, setBuoyStats] = useState<[string, number][]>([]);
    const [tileStats, setTileStats] = useState<TileStats>({ total: 0, by_layer: [] });

    useEffect(() => {
        loadStats();
        loadRegionStats();
        loadBuoyStats();
    }, []);

    const loadStats = async () => {
        try {
            const data = await invoke<Stats>('get_stats');
            setStats(data);
        } catch (e) {
            console.error('加载统计失败:', e);
        } finally {
            setLoading(false);
        }
    };

    const loadBuoyStats = async () => {
        try {
            const count = await invoke<number>('chart_get_buoy_count');
            setBuoyCount(count);
            const typeStats = await invoke<[string, number][]>('chart_get_buoy_stats');
            setBuoyStats(typeStats);

            // 合并航道图瓦片 + 地图下载器瓦片
            let totalTiles = 0;
            const layerBreakdown: [string, number][] = [];

            // 1) 航道图瓦片（chart_collector 文件系统）
            try {
                const chartTiles = await invoke<TileStats>('chart_get_tile_count');
                totalTiles += chartTiles.total;
                layerBreakdown.push(...chartTiles.by_layer);
            } catch { /* chart_tiles 目录可能不存在 */ }

            // 2) 地图下载器任务已完成的瓦片
            try {
                const tasks = await invoke<{ name: string; platform: string; completed_tiles: number; total_tiles: number; status: string }[]>('get_tile_tasks');
                for (const task of tasks) {
                    if (task.completed_tiles > 0) {
                        totalTiles += task.completed_tiles;
                        layerBreakdown.push([`${task.name} (${task.platform})`, task.completed_tiles]);
                    }
                }
            } catch { /* 可能无下载任务 */ }

            setTileStats({ total: totalTiles, by_layer: layerBreakdown });
        } catch (e) {
            console.error('加载航标统计失败:', e);
        }
    };

    const loadRegionStats = async () => {
        try {
            // 先修复 region_code
            await invoke<[number, number]>('fix_region_codes');
            const data = await invoke<[string, number][]>('get_poi_stats_by_region');
            setRegionStats(data);

            // 加载区域名称
            const provinces = await invoke<Region[]>('get_provinces');
            const names: Record<string, string> = {};
            for (const p of provinces) {
                names[p.code] = p.name;
                try {
                    const cities = await invoke<Region[]>('get_region_children', { parentCode: p.code });
                    for (const c of cities) {
                        names[c.code] = c.name;
                        try {
                            const districts = await invoke<Region[]>('get_region_children', { parentCode: c.code });
                            for (const d of districts) {
                                names[d.code] = d.name;
                            }
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            setRegionNames(names);
        } catch (e) {
            console.error('加载区域统计失败:', e);
        }
    };

    const statCards = [
        { label: '总数据量', value: stats?.total || 0, icon: Database, gradient: 'from-primary to-indigo-600', iconBg: 'bg-primary/20' },
        { label: '天地图', value: stats?.by_platform?.tianditu || 0, icon: MapPin, gradient: 'from-cyan-500 to-cyan-600', iconBg: 'bg-cyan-500/20' },
        { label: '高德地图', value: stats?.by_platform?.amap || 0, icon: Globe, gradient: 'from-indigo-500 to-indigo-600', iconBg: 'bg-indigo-500/20' },
        { label: '百度地图', value: stats?.by_platform?.baidu || 0, icon: BarChart3, gradient: 'from-red-500 to-red-600', iconBg: 'bg-red-500/20' },
        { label: 'OSM', value: stats?.by_platform?.osm || 0, icon: Map, gradient: 'from-emerald-500 to-emerald-600', iconBg: 'bg-emerald-500/20' },
    ];

    const totalRegionCount = regionStats.reduce((sum, [, count]) => sum + count, 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">加载统计数据...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col gap-6">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between">
                <div className="space-y-1">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">数据概览</h1>
                    <p className="text-sm text-muted-foreground">洞察采集数据分布与整体进度</p>
                </div>
                {stats && stats.total > 0 && (
                    <div className="flex items-center gap-3 px-5 py-2.5 rounded-2xl bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20 shadow-sm transition-transform hover:scale-[1.02]">
                        <div className="p-2 rounded-full bg-primary/20 text-primary">
                            <TrendingUp className="w-4 h-4" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-primary/70">总数据量</span>
                            <span className="text-base font-bold text-primary leading-none mt-0.5">
                                {stats.total.toLocaleString()} <span className="text-xs font-normal opacity-70">条</span>
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Scrollable content */}
            <SimpleBar className="flex-1 min-h-0 -mx-6 px-6">
                <div className="space-y-6 pb-6">
                    {/* Stat Cards (Top Row) */}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                        {statCards.map((card) => (
                            <Card key={card.label} className="overflow-hidden hover-lift cursor-pointer group relative border-border/50 bg-gradient-to-br from-card to-card/50 shadow-sm transition-all duration-300">
                                {/* Decorative Glow */}
                                <div className={`absolute -right-8 -top-8 w-32 h-32 rounded-full blur-[40px] opacity-20 pointer-events-none transition-all duration-500 group-hover:opacity-40 bg-gradient-to-br ${card.gradient}`} />
                                <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b ${card.gradient} opacity-60`} />

                                <CardHeader className="flex flex-row items-center justify-between pb-2 pt-5 pl-5 z-10 relative">
                                    <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                        {card.label}
                                    </CardTitle>
                                    <div className={`w-9 h-9 rounded-xl ${card.iconBg} flex items-center justify-center shadow-sm transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-3`}>
                                        <card.icon className={`w-4 h-4 bg-gradient-to-br ${card.gradient} bg-clip-text`} style={{ color: 'inherit' }} />
                                    </div>
                                </CardHeader>
                                <CardContent className="pb-5 pl-5 z-10 relative">
                                    <div className="text-3xl font-bold tracking-tighter text-foreground transition-all">
                                        {card.value.toLocaleString()}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>

                    {/* Main Analytics Grid: 3 Columns */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                        {/* Column 1: Regions */}
                        <Card className="overflow-hidden flex flex-col border-border/50 shadow-sm">
                            <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 rounded-lg bg-primary/10 text-primary">
                                        <MapPin className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <CardTitle className="text-base">已采集地区</CardTitle>
                                        <CardDescription className="text-xs mt-0.5">
                                            涉及 {regionStats.length} 个地区，占据 {totalRegionCount.toLocaleString()} 条数据
                                        </CardDescription>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0 flex-1 relative">
                                {regionStats.length > 0 ? (
                                    <SimpleBar className="h-full min-h-[320px] max-h-[400px] p-5">
                                        <div className="space-y-4">
                                            {regionStats.map(([code, count], index) => {
                                                const percent = totalRegionCount > 0 ? (count / totalRegionCount) * 100 : 0;
                                                const gradients = ['from-cyan-500 to-blue-500', 'from-indigo-500 to-purple-500', 'from-violet-500 to-pink-500', 'from-pink-500 to-rose-500', 'from-orange-500 to-amber-500'];
                                                const color = gradients[index % gradients.length];
                                                return (
                                                    <div key={code} className="group relative">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <div className="flex items-center gap-2">
                                                                <div className={`w-2 h-2 rounded-full bg-gradient-to-r ${color} shadow-sm`} />
                                                                <span className="font-medium text-sm text-foreground group-hover:text-primary transition-colors">
                                                                    {regionNames[code] || code}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-baseline gap-2">
                                                                <span className="text-sm font-bold tracking-tight">
                                                                    {count.toLocaleString()}
                                                                </span>
                                                                <span className="text-[10px] font-medium text-muted-foreground w-10 text-right">
                                                                    {percent.toFixed(1)}%
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full rounded-full bg-gradient-to-r ${color} transition-all duration-1000 ease-out`}
                                                                style={{ width: `${percent}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </SimpleBar>
                                ) : (
                                    <div className="flex flex-col items-center justify-center p-12 text-muted-foreground h-[320px]">
                                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                            <MapPin className="w-8 h-8 opacity-20" />
                                        </div>
                                        <p className="font-medium">暂无采集数据</p>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Column 2: Categories */}
                        <Card className="overflow-hidden flex flex-col border-border/50 shadow-sm">
                            <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                        <BarChart3 className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <CardTitle className="text-base">分类排行</CardTitle>
                                        <CardDescription className="text-xs mt-0.5">Top 10 POI 类别分布</CardDescription>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0 flex-1 relative">
                                {stats?.by_category && Object.keys(stats.by_category).length > 0 ? (
                                    <SimpleBar className="h-full min-h-[320px] max-h-[400px] p-5">
                                        <div className="space-y-4">
                                            {Object.entries(stats.by_category)
                                                .sort(([, a], [, b]) => b - a)
                                                .slice(0, 10)
                                                .map(([name, count]) => {
                                                    const maxCount = Math.max(...Object.values(stats.by_category));
                                                    const percent = (count / maxCount) * 100;
                                                    return (
                                                        <div key={name} className="group">
                                                            <div className="flex items-center justify-between mb-2">
                                                                <span className="text-sm font-medium truncate flex-1 mr-3 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                                                    {name}
                                                                </span>
                                                                <span className="text-sm font-bold tracking-tight">
                                                                    {count.toLocaleString()}
                                                                </span>
                                                            </div>
                                                            <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-1000 ease-out"
                                                                    style={{ width: `${percent}%` }}
                                                                />
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                        </div>
                                    </SimpleBar>
                                ) : (
                                    <div className="flex flex-col items-center justify-center p-12 text-muted-foreground h-[320px]">
                                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                            <BarChart3 className="w-8 h-8 opacity-20" />
                                        </div>
                                        <p className="font-medium">暂无分类数据</p>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Column 3: Chart Data (Buoys + Tiles) */}
                        <Card className={cn(
                            "overflow-hidden flex flex-col shadow-sm transition-all",
                            (buoyCount > 0 || tileStats.total > 0) ? "border-blue-500/20" : "border-border/50"
                        )}>
                            <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                        <Ship className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <CardTitle className="text-base text-foreground">航道图数据</CardTitle>
                                        <CardDescription className="text-xs mt-0.5">航标与瓦片采集概况</CardDescription>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0 flex-1 relative">
                                {(buoyCount > 0 || tileStats.total > 0) ? (
                                    <SimpleBar className="h-full min-h-[320px] max-h-[400px]">
                                        {/* Hero Stats Banner */}
                                        <div className="p-5 pb-0">
                                            <div className="grid grid-cols-3 gap-3">
                                                <div className="rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-600/5 border border-blue-500/10 p-3.5">
                                                    <div className="flex items-center gap-1.5 mb-1.5">
                                                        <Anchor className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                                                        <span className="text-[10px] uppercase font-bold tracking-wider text-blue-600/70 dark:text-blue-400/70">航标</span>
                                                    </div>
                                                    <div className="text-xl font-bold tracking-tighter text-blue-600 dark:text-blue-400">
                                                        {buoyCount.toLocaleString()}
                                                    </div>
                                                </div>
                                                <div className="rounded-xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/10 p-3.5">
                                                    <div className="flex items-center gap-1.5 mb-1.5">
                                                        <Layers className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                                        <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-600/70 dark:text-emerald-400/70">瓦片</span>
                                                    </div>
                                                    <div className="text-xl font-bold tracking-tighter text-emerald-600 dark:text-emerald-400">
                                                        {tileStats.total.toLocaleString()}
                                                    </div>
                                                </div>
                                                <div className="rounded-xl bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border border-cyan-500/10 p-3.5">
                                                    <div className="flex items-center gap-1.5 mb-1.5">
                                                        <BarChart3 className="w-3 h-3 text-cyan-600 dark:text-cyan-400" />
                                                        <span className="text-[10px] uppercase font-bold tracking-wider text-cyan-600/70 dark:text-cyan-400/70">类型</span>
                                                    </div>
                                                    <div className="text-xl font-bold tracking-tighter text-cyan-600 dark:text-cyan-400">
                                                        {buoyStats.length}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Type Distribution List */}
                                        {buoyStats.length > 0 && (
                                            <div className="p-5 space-y-3.5">
                                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">航标形状</div>
                                                {buoyStats.map(([type_name, count], index) => {
                                                    const maxCount = buoyStats[0]?.[1] || 1;
                                                    const percent = (count / maxCount) * 100;
                                                    const sharePercent = buoyCount > 0 ? (count / buoyCount) * 100 : 0;
                                                    const colors = [
                                                        'from-blue-600 to-blue-400',
                                                        'from-cyan-600 to-cyan-400',
                                                        'from-sky-600 to-sky-400',
                                                        'from-indigo-600 to-indigo-400',
                                                        'from-teal-600 to-teal-400',
                                                    ];
                                                    const color = colors[index % colors.length];
                                                    return (
                                                        <div key={type_name} className="group">
                                                            <div className="flex items-center justify-between mb-1.5">
                                                                <div className="flex items-center gap-2">
                                                                    <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${color}`} />
                                                                    <span className="text-sm font-medium truncate flex-1 mr-2 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                                                        {type_name}
                                                                    </span>
                                                                </div>
                                                                <div className="flex items-baseline gap-2">
                                                                    <span className="text-sm font-bold tracking-tight">
                                                                        {count.toLocaleString()}
                                                                    </span>
                                                                    <span className="text-[10px] font-medium text-muted-foreground w-10 text-right">
                                                                        {sharePercent.toFixed(1)}%
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="h-1.5 bg-blue-500/10 dark:bg-blue-500/15 rounded-full overflow-hidden">
                                                                <div
                                                                    className={`h-full bg-gradient-to-r ${color} rounded-full transition-all duration-1000 ease-out`}
                                                                    style={{ width: `${percent}%` }}
                                                                />
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {/* Tile Layer Breakdown */}
                                        {tileStats.by_layer.length > 0 && (
                                            <div className="p-5 pt-0 space-y-3.5">
                                                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">图层瓦片</div>
                                                {tileStats.by_layer.map(([layer_name, count]) => {
                                                    const maxCount = tileStats.by_layer[0]?.[1] || 1;
                                                    const percent = (count / maxCount) * 100;
                                                    return (
                                                        <div key={layer_name} className="group">
                                                            <div className="flex items-center justify-between mb-1.5">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="w-1.5 h-1.5 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400" />
                                                                    <span className="text-sm font-medium truncate flex-1 mr-2 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                                                        {layer_name}
                                                                    </span>
                                                                </div>
                                                                <span className="text-sm font-bold tracking-tight">
                                                                    {count.toLocaleString()}
                                                                </span>
                                                            </div>
                                                            <div className="h-1.5 bg-emerald-500/10 dark:bg-emerald-500/15 rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-1000 ease-out"
                                                                    style={{ width: `${percent}%` }}
                                                                />
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </SimpleBar>
                                ) : (
                                    <div className="flex flex-col items-center justify-center p-12 text-muted-foreground h-[320px]">
                                        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                            <Anchor className="w-8 h-8 opacity-20" />
                                        </div>
                                        <p className="font-medium">暂无航道图数据</p>
                                        <p className="text-xs mt-1 text-muted-foreground">完成航标或瓦片采集后将在此展示</p>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </SimpleBar>
        </div>
    );
}
