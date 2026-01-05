import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, MapPin, Globe, BarChart3 } from 'lucide-react';

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
        {
            label: '总数据量',
            value: stats?.total || 0,
            icon: Database,
            color: 'bg-gradient-to-br from-blue-500 to-blue-600'
        },
        {
            label: '天地图',
            value: stats?.by_platform?.tianditu || 0,
            icon: MapPin,
            color: 'bg-gradient-to-br from-cyan-500 to-cyan-600'
        },
        {
            label: '高德地图',
            value: stats?.by_platform?.amap || 0,
            icon: Globe,
            color: 'bg-gradient-to-br from-indigo-500 to-indigo-600'
        },
        {
            label: '百度地图',
            value: stats?.by_platform?.baidu || 0,
            icon: BarChart3,
            color: 'bg-gradient-to-br from-red-500 to-red-600'
        },
    ];

    return (
        <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-6">数据概览</h1>

            {/* Stat Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                {statCards.map((card) => (
                    <div key={card.label} className={`${card.color} rounded-xl p-6 text-white shadow-lg`}>
                        <div className="flex items-center justify-between mb-4">
                            <card.icon className="w-8 h-8 opacity-80" />
                        </div>
                        <div className="text-3xl font-bold mb-1">
                            {loading ? '...' : card.value.toLocaleString()}
                        </div>
                        <div className="text-white/80 text-sm">{card.label}</div>
                    </div>
                ))}
            </div>

            {/* Category Chart */}
            <div className="card">
                <h2 className="text-lg font-semibold mb-4">分类统计</h2>
                {loading ? (
                    <div className="text-slate-400 text-center py-8">加载中...</div>
                ) : stats?.by_category && Object.keys(stats.by_category).length > 0 ? (
                    <div className="space-y-3">
                        {Object.entries(stats.by_category)
                            .sort(([, a], [, b]) => b - a)
                            .slice(0, 10)
                            .map(([name, count]) => {
                                const maxCount = Math.max(...Object.values(stats.by_category));
                                const percent = (count / maxCount) * 100;
                                return (
                                    <div key={name} className="flex items-center gap-4">
                                        <span className="w-24 text-sm text-slate-600 truncate">{name}</span>
                                        <div className="flex-1 h-6 bg-slate-100 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all duration-500"
                                                style={{ width: `${percent}%` }}
                                            />
                                        </div>
                                        <span className="w-16 text-right text-sm font-medium text-slate-700">
                                            {count.toLocaleString()}
                                        </span>
                                    </div>
                                );
                            })}
                    </div>
                ) : (
                    <div className="text-slate-400 text-center py-8">暂无数据，请先采集POI</div>
                )}
            </div>
        </div>
    );
}
