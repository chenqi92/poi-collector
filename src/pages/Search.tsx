import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search as SearchIcon, MapPin, Copy, ExternalLink } from 'lucide-react';

interface POI {
    id: number;
    name: string;
    lon: number;
    lat: number;
    address: string;
    category: string;
    platform: string;
}

const platformBadges: Record<string, { bg: string; text: string }> = {
    tianditu: { bg: 'bg-cyan-100', text: 'text-cyan-700' },
    amap: { bg: 'bg-blue-100', text: 'text-blue-700' },
    baidu: { bg: 'bg-red-100', text: 'text-red-700' },
};

const platformNames: Record<string, string> = {
    tianditu: '天地图',
    amap: '高德',
    baidu: '百度',
};

export default function Search() {
    const [query, setQuery] = useState('');
    const [platform, setPlatform] = useState('all');
    const [mode, setMode] = useState('smart');
    const [results, setResults] = useState<POI[]>([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    const doSearch = async () => {
        if (!query.trim()) return;

        setLoading(true);
        setSearched(true);
        try {
            const data = await invoke<POI[]>('search_poi', {
                query: query.trim(),
                platform,
                mode,
                limit: 50
            });
            setResults(data);
        } catch (e) {
            console.error('搜索失败:', e);
            setResults([]);
        } finally {
            setLoading(false);
        }
    };

    const copyCoords = (poi: POI) => {
        navigator.clipboard.writeText(`${poi.lon},${poi.lat}`);
    };

    const openInMap = (poi: POI) => {
        window.open(`https://uri.amap.com/marker?position=${poi.lon},${poi.lat}&name=${encodeURIComponent(poi.name)}`, '_blank');
    };

    return (
        <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">数据查询</h1>
            <p className="text-slate-500 mb-8">搜索已采集的POI数据</p>

            {/* Search Box */}
            <div className="card mb-6">
                <div className="flex flex-wrap gap-4">
                    <div className="flex-1 min-w-[200px]">
                        <div className="relative">
                            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                            <input
                                type="text"
                                className="input pl-10"
                                placeholder="输入地点名称搜索..."
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyPress={(e) => e.key === 'Enter' && doSearch()}
                            />
                        </div>
                    </div>

                    <select
                        className="input w-32"
                        value={platform}
                        onChange={(e) => setPlatform(e.target.value)}
                    >
                        <option value="all">全部平台</option>
                        <option value="tianditu">天地图</option>
                        <option value="amap">高德地图</option>
                        <option value="baidu">百度地图</option>
                    </select>

                    <select
                        className="input w-32"
                        value={mode}
                        onChange={(e) => setMode(e.target.value)}
                    >
                        <option value="smart">智能匹配</option>
                        <option value="exact">精确匹配</option>
                        <option value="prefix">前缀匹配</option>
                        <option value="contains">包含匹配</option>
                        <option value="fuzzy">模糊匹配</option>
                    </select>

                    <button className="btn btn-primary" onClick={doSearch} disabled={loading}>
                        {loading ? '搜索中...' : '搜索'}
                    </button>
                </div>
            </div>

            {/* Results */}
            <div className="card">
                {loading ? (
                    <div className="text-center py-12 text-slate-400">搜索中...</div>
                ) : results.length > 0 ? (
                    <div className="divide-y">
                        {results.map((poi) => {
                            const badge = platformBadges[poi.platform] || platformBadges.tianditu;
                            return (
                                <div key={poi.id} className="py-4 flex items-start justify-between gap-4 group">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-medium text-slate-900 truncate">{poi.name}</span>
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.text}`}>
                                                {platformNames[poi.platform]}
                                            </span>
                                        </div>
                                        <div className="text-sm text-slate-500 flex items-center gap-2">
                                            <span>{poi.category || '未分类'}</span>
                                            {poi.address && (
                                                <>
                                                    <span>·</span>
                                                    <span className="truncate">{poi.address}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <div className="text-xs text-slate-400 font-mono bg-slate-100 px-2 py-1 rounded">
                                            {poi.lon.toFixed(6)}, {poi.lat.toFixed(6)}
                                        </div>
                                        <button
                                            className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={() => copyCoords(poi)}
                                            title="复制坐标"
                                        >
                                            <Copy className="w-4 h-4" />
                                        </button>
                                        <button
                                            className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={() => openInMap(poi)}
                                            title="在地图中查看"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : searched ? (
                    <div className="text-center py-12">
                        <MapPin className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                        <div className="text-slate-400">未找到匹配结果</div>
                    </div>
                ) : (
                    <div className="text-center py-12">
                        <SearchIcon className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                        <div className="text-slate-400">输入关键词开始搜索</div>
                    </div>
                )}
            </div>
        </div>
    );
}
