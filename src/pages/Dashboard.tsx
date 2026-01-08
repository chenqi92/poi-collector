import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, MapPin, Globe, BarChart3, Loader2, Map, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

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

const platformConfig: Record<string, { name: string; color: string; gradient: string }> = {
    tianditu: { name: '天地图', color: 'text-cyan-400', gradient: 'from-cyan-500 to-cyan-600' },
    amap: { name: '高德地图', color: 'text-indigo-400', gradient: 'from-indigo-500 to-indigo-600' },
    baidu: { name: '百度地图', color: 'text-red-400', gradient: 'from-red-500 to-red-600' },
    osm: { name: 'OSM', color: 'text-emerald-400', gradient: 'from-emerald-500 to-emerald-600' },
};

export default function Dashboard() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [regionStats, setRegionStats] = useState<[string, number][]>([]);
    const [regionNames, setRegionNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadStats();
        loadRegionStats();
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
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据概览</h1>
                    <p className="text-muted-foreground">查看已采集的 POI 数据统计</p>
                </div>
                {stats && stats.total > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20">
                        <TrendingUp className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium text-primary">
                            共 {stats.total.toLocaleString()} 条数据
                        </span>
                    </div>
                )}
            </div>

            {/* Stat Cards with Gradient Top Border */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                {statCards.map((card) => (
                    <Card key={card.label} className="overflow-hidden hover-lift cursor-pointer group relative">
                        {/* Gradient top border */}
                        <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${card.gradient}`} />

                        <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4">
                            <CardTitle className="text-sm font-medium text-muted-foreground">
                                {card.label}
                            </CardTitle>
                            <div className={`w-8 h-8 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                                <card.icon className={`w-4 h-4 bg-gradient-to-r ${card.gradient} bg-clip-text`} style={{ color: 'inherit' }} />
                            </div>
                        </CardHeader>
                        <CardContent className="pb-4">
                            <div className="text-2xl font-bold text-foreground group-hover:gradient-text transition-all">
                                {card.value.toLocaleString()}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 已采集地区 */}
                <Card className="overflow-hidden">
                    <CardHeader className="border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2">
                                    <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                                        <MapPin className="w-4 h-4 text-primary" />
                                    </div>
                                    已采集地区
                                </CardTitle>
                                <CardDescription className="mt-1">
                                    共 {regionStats.length} 个地区，{totalRegionCount.toLocaleString()} 条数据
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="p-4">
                        {regionStats.length > 0 ? (
                            <div className="space-y-3">
                                {regionStats.map(([code, count], index) => {
                                    const percent = totalRegionCount > 0 ? (count / totalRegionCount) * 100 : 0;
                                    const gradients = [
                                        'from-cyan-500 to-cyan-400',
                                        'from-indigo-500 to-indigo-400',
                                        'from-violet-500 to-violet-400',
                                        'from-pink-500 to-pink-400',
                                        'from-orange-500 to-orange-400'
                                    ];
                                    return (
                                        <div key={code} className="group">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-2 h-2 rounded-full bg-gradient-to-r ${gradients[index % gradients.length]}`} />
                                                    <span className="font-medium text-sm">
                                                        {regionNames[code] || code}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        ({code})
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-semibold">
                                                        {count.toLocaleString()}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground w-12 text-right">
                                                        {percent.toFixed(1)}%
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full bg-gradient-to-r ${gradients[index % gradients.length]} transition-all duration-700`}
                                                    style={{ width: `${percent}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-muted-foreground text-center py-12">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                                    <MapPin className="w-8 h-8 opacity-30" />
                                </div>
                                <p className="font-medium">暂无采集数据</p>
                                <p className="text-sm mt-1">开始采集后将在此显示统计</p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* 分类统计 */}
                <Card className="overflow-hidden">
                    <CardHeader className="border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                        <CardTitle className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                                <BarChart3 className="w-4 h-4 text-primary" />
                            </div>
                            分类统计
                        </CardTitle>
                        <CardDescription>
                            按 POI 类别分组统计
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="p-4">
                        {stats?.by_category && Object.keys(stats.by_category).length > 0 ? (
                            <div className="space-y-3">
                                {Object.entries(stats.by_category)
                                    .sort(([, a], [, b]) => b - a)
                                    .slice(0, 8)
                                    .map(([name, count]) => {
                                        const maxCount = Math.max(...Object.values(stats.by_category));
                                        const percent = (count / maxCount) * 100;
                                        return (
                                            <div key={name}>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="text-sm font-medium truncate flex-1 mr-2">
                                                        {name}
                                                    </span>
                                                    <span className="text-sm font-semibold">
                                                        {count.toLocaleString()}
                                                    </span>
                                                </div>
                                                <div className="h-2 bg-muted rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full bg-gradient-to-r from-primary to-primary/60 rounded-full transition-all duration-700"
                                                        style={{ width: `${percent}%` }}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                            </div>
                        ) : (
                            <div className="text-muted-foreground text-center py-12">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                                    <BarChart3 className="w-8 h-8 opacity-30" />
                                </div>
                                <p className="font-medium">暂无分类数据</p>
                                <p className="text-sm mt-1">采集数据后将显示分类统计</p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* 平台分布 */}
            {stats && stats.total > 0 && (
                <Card className="overflow-hidden">
                    <CardHeader className="border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                        <CardTitle className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                                <Globe className="w-4 h-4 text-primary" />
                            </div>
                            平台分布
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-4">
                        <div className="flex items-center gap-4 flex-wrap">
                            {Object.entries(stats.by_platform).map(([platform, count]) => {
                                if (!count) return null;
                                const config = platformConfig[platform] || { name: platform, color: 'text-gray-400', gradient: 'from-gray-500 to-gray-600' };
                                const percent = stats.total > 0 ? (count / stats.total) * 100 : 0;
                                return (
                                    <div key={platform}
                                        className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-card hover:bg-accent/30 hover-lift cursor-pointer transition-all group"
                                    >
                                        <div className={`w-3 h-3 rounded-full bg-gradient-to-r ${config.gradient}`} />
                                        <div>
                                            <div className="font-medium">{config.name}</div>
                                            <div className="text-sm text-muted-foreground">
                                                {count.toLocaleString()} 条 ({percent.toFixed(1)}%)
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
