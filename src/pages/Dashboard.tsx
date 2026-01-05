import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, MapPin, Globe, BarChart3, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Stats {
    total: number;
    by_platform: {
        tianditu?: number;
        amap?: number;
        baidu?: number;
    };
    by_category: Record<string, number>;
}

export default function Dashboard() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadStats();
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

    const statCards = [
        { label: '总数据量', value: stats?.total || 0, icon: Database },
        { label: '天地图', value: stats?.by_platform?.tianditu || 0, icon: MapPin },
        { label: '高德地图', value: stats?.by_platform?.amap || 0, icon: Globe },
        { label: '百度地图', value: stats?.by_platform?.baidu || 0, icon: BarChart3 },
    ];

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground">数据概览</h1>
                <p className="text-muted-foreground">查看已采集的 POI 数据统计</p>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {statCards.map((card) => (
                    <Card key={card.label}>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium text-muted-foreground">
                                {card.label}
                            </CardTitle>
                            <card.icon className="w-4 h-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-3xl font-bold text-foreground">
                                {card.value.toLocaleString()}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Category Chart */}
            <Card>
                <CardHeader>
                    <CardTitle>分类统计</CardTitle>
                </CardHeader>
                <CardContent>
                    {stats?.by_category && Object.keys(stats.by_category).length > 0 ? (
                        <div className="space-y-3">
                            {Object.entries(stats.by_category)
                                .sort(([, a], [, b]) => b - a)
                                .slice(0, 10)
                                .map(([name, count]) => {
                                    const maxCount = Math.max(...Object.values(stats.by_category));
                                    const percent = (count / maxCount) * 100;
                                    return (
                                        <div key={name} className="flex items-center gap-4">
                                            <span className="w-24 text-sm text-muted-foreground truncate">
                                                {name}
                                            </span>
                                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-primary rounded-full transition-all duration-500"
                                                    style={{ width: `${percent}%` }}
                                                />
                                            </div>
                                            <span className="w-16 text-right text-sm font-medium text-foreground">
                                                {count.toLocaleString()}
                                            </span>
                                        </div>
                                    );
                                })}
                        </div>
                    ) : (
                        <div className="text-muted-foreground text-center py-8">
                            暂无数据，请先采集 POI
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
