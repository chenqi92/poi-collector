import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search as SearchIcon, MapPin, List, Columns, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import POIMap, { POI } from '@/components/POIMap';
import SimpleBar from 'simplebar-react';

type ViewMode = 'list' | 'map' | 'split';

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

export default function Search() {
    const [query, setQuery] = useState('');
    const [platform, setPlatform] = useState('all');
    const [mode, setMode] = useState('contains');
    const [results, setResults] = useState<POI[]>([]);
    const [loading, setLoading] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('split');
    const [selectedId, setSelectedId] = useState<number | null>(null);

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

    const showList = viewMode === 'list' || viewMode === 'split';
    const showMap = viewMode === 'map' || viewMode === 'split';

    return (
        <div className="h-full flex flex-col gap-4 overflow-hidden">
            {/* 页面标题 */}
            <div className="shrink-0 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">POI 搜索</h1>
                    <p className="text-muted-foreground">从已采集的本地数据中搜索兴趣点</p>
                </div>
            </div>

            {/* 搜索栏 */}
            <Card className="shrink-0 overflow-visible relative">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-indigo-500 to-purple-500" />
                <CardContent className="py-4">
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
                    </div>

                    {results.length > 0 && (
                        <div className="mt-3 text-sm text-muted-foreground">
                            找到 <span className="font-medium text-primary">{results.length}</span> 条结果
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
                            {results.length > 0 ? (
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
                                    pois={results}
                                    selectedId={selectedId}
                                    onMarkerClick={handleMarkerClick}
                                />
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
