import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Play, Square, RotateCcw, Loader2 } from 'lucide-react';

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
    idle: { text: '未开始', bg: 'bg-slate-100', color: 'text-slate-600' },
    running: { text: '采集中', bg: 'bg-blue-100', color: 'text-blue-600' },
    paused: { text: '已暂停', bg: 'bg-yellow-100', color: 'text-yellow-600' },
    completed: { text: '已完成', bg: 'bg-green-100', color: 'text-green-600' },
    error: { text: '出错', bg: 'bg-red-100', color: 'text-red-600' },
};

export default function Collector() {
    const [statuses, setStatuses] = useState<Record<string, CollectorStatus>>({});
    const [categories, setCategories] = useState<Category[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<Record<string, string[]>>({});
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        loadData();
        const interval = setInterval(loadStatuses, 2000);

        // Listen for log events
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

            // Initialize selected categories
            const initial: Record<string, string[]> = {};
            ['tianditu', 'amap', 'baidu'].forEach(p => {
                initial[p] = categoriesData.map(c => c.id);
            });
            setSelectedCategories(initial);
        } catch (e) {
            console.error('加载数据失败:', e);
        }
    };

    const loadStatuses = async () => {
        try {
            const data = await invoke<Record<string, CollectorStatus>>('get_collector_statuses');
            setStatuses(data);
        } catch (e) {
            console.error('加载状态失败:', e);
        }
    };

    const startCollector = async (platform: string) => {
        try {
            await invoke('start_collector', {
                platform,
                categories: selectedCategories[platform]
            });
            loadStatuses();
        } catch (e: any) {
            alert(e.toString());
        }
    };

    const stopCollector = async (platform: string) => {
        try {
            await invoke('stop_collector', { platform });
            loadStatuses();
        } catch (e) {
            console.error('停止失败:', e);
        }
    };

    const resetCollector = async (platform: string) => {
        if (!confirm('确定要重置采集进度吗？')) return;
        try {
            await invoke('reset_collector', { platform });
            loadStatuses();
        } catch (e) {
            console.error('重置失败:', e);
        }
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

    return (
        <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">数据采集</h1>
            <p className="text-slate-500 mb-8">从各平台采集POI数据，支持断点续采</p>

            {/* Collector Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                {['tianditu', 'amap', 'baidu'].map((platform) => {
                    const status = statuses[platform] || { status: 'idle', total_collected: 0, completed_categories: [] };
                    const config = statusConfig[status.status] || statusConfig.idle;
                    const progress = categories.length > 0
                        ? (status.completed_categories?.length || 0) / categories.length * 100
                        : 0;

                    return (
                        <div key={platform} className="card">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-semibold">{platformNames[platform]}</h3>
                                <span className={`px-3 py-1 rounded-full text-xs font-medium ${config.bg} ${config.color}`}>
                                    {config.text}
                                </span>
                            </div>

                            {/* Categories */}
                            <div className="mb-4 p-3 bg-slate-50 rounded-lg max-h-32 overflow-y-auto">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs text-slate-500">选择类别</span>
                                    <label className="flex items-center gap-1 text-xs text-primary-600 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedCategories[platform]?.length === categories.length}
                                            onChange={(e) => toggleAllCategories(platform, e.target.checked)}
                                        />
                                        全选
                                    </label>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {categories.map((cat) => (
                                        <label
                                            key={cat.id}
                                            className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs cursor-pointer transition-colors ${selectedCategories[platform]?.includes(cat.id)
                                                ? 'bg-primary-100 text-primary-700'
                                                : 'bg-white text-slate-500 border'
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

                            {/* Progress */}
                            <div className="mb-4">
                                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-primary-500 to-green-500 transition-all duration-300"
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                                <div className="flex justify-between mt-2 text-xs text-slate-500">
                                    <span>{status.completed_categories?.length || 0} / {categories.length} 类别</span>
                                    <span>已采集: {status.total_collected?.toLocaleString() || 0}</span>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex gap-2">
                                <button
                                    className="btn btn-primary flex-1 flex items-center justify-center gap-2"
                                    onClick={() => startCollector(platform)}
                                    disabled={status.status === 'running'}
                                >
                                    {status.status === 'running' ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Play className="w-4 h-4" />
                                    )}
                                    {status.status === 'running' ? '采集中' : status.status === 'paused' ? '继续' : '开始'}
                                </button>
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => stopCollector(platform)}
                                    disabled={status.status !== 'running'}
                                >
                                    <Square className="w-4 h-4" />
                                </button>
                                <button
                                    className="btn btn-danger"
                                    onClick={() => resetCollector(platform)}
                                >
                                    <RotateCcw className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Logs */}
            <div className="card">
                <h3 className="font-semibold mb-4">采集日志</h3>
                <div className="bg-slate-900 rounded-lg p-4 h-64 overflow-y-auto font-mono text-sm">
                    {logs.length > 0 ? (
                        logs.map((log, i) => (
                            <div key={i} className="text-slate-300 py-0.5">{log}</div>
                        ))
                    ) : (
                        <div className="text-slate-500">等待采集开始...</div>
                    )}
                </div>
            </div>
        </div>
    );
}
