import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search as SearchIcon, MapPin, List, Columns, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import POIMap, { POI } from '@/components/POIMap';

type ViewMode = 'list' | 'map' | 'split';

const platformNames: Record<string, string> = {
    all: '全部平台',
    tianditu: '天地图',
    amap: '高德',
    baidu: '百度',
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
        <div className="h-full flex flex-col gap-4">
            {/* 搜索栏 */}
            <Card className="shrink-0">
                <CardContent className="py-4">
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                placeholder="输入名称搜索 POI..."
                                className="w-full pl-10 pr-4 py-2.5 border border-input bg-background rounded-lg
                                         text-foreground placeholder:text-muted-foreground focus:outline-none
                                         focus:ring-2 focus:ring-ring"
                            />
                        </div>

                        <select
                            value={platform}
                            onChange={(e) => setPlatform(e.target.value)}
                            className="px-4 py-2.5 border border-input bg-background rounded-lg text-foreground
                                     focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                            {Object.entries(platformNames).map(([key, name]) => (
                                <option key={key} value={key}>{name}</option>
                            ))}
                        </select>

                        <select
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                            className="px-4 py-2.5 border border-input bg-background rounded-lg text-foreground
                                     focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                            {modeOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>

                        <Button onClick={handleSearch} disabled={loading}>
                            {loading ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                '搜索'
                            )}
                        </Button>

                        <div className="flex border border-input rounded-lg overflow-hidden">
                            <button
                                onClick={() => setViewMode('list')}
                                className={`p-2.5 transition-colors ${viewMode === 'list'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-background text-muted-foreground hover:bg-accent'
                                    }`}
                                title="列表视图"
                            >
                                <List className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setViewMode('split')}
                                className={`p-2.5 border-x border-input transition-colors ${viewMode === 'split'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-background text-muted-foreground hover:bg-accent'
                                    }`}
                                title="分屏视图"
                            >
                                <Columns className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setViewMode('map')}
                                className={`p-2.5 transition-colors ${viewMode === 'map'
                                    ? 'bg-primary text-primary-foreground'
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
                            找到 <span className="font-medium text-foreground">{results.length}</span> 条结果
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* 结果区域 - 修复地图铺满问题 */}
            <div className={`flex-1 min-h-0 grid gap-4 ${showList && showMap ? 'grid-cols-2' : 'grid-cols-1'
                }`}>
                {/* 列表 */}
                {showList && (
                    <Card className="overflow-hidden h-full">
                        <CardContent className="p-0 h-full">
                            {results.length > 0 ? (
                                <div className="h-full overflow-y-auto">
                                    {results.map((poi) => (
                                        <div
                                            key={poi.id}
                                            onClick={() => setSelectedId(poi.id)}
                                            className={`p-4 border-b border-border cursor-pointer transition-colors ${selectedId === poi.id
                                                    ? 'bg-primary/10 border-l-2 border-l-primary'
                                                    : 'hover:bg-accent'
                                                }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <MapPin className={`w-4 h-4 mt-1 ${selectedId === poi.id ? 'text-primary' : 'text-muted-foreground'
                                                    }`} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-medium text-foreground truncate">{poi.name}</div>
                                                    <div className="text-sm text-muted-foreground truncate">
                                                        {poi.address || '无地址'}
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <span className="text-xs bg-muted px-2 py-0.5 rounded">
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
                                </div>
                            ) : (
                                <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                                    <SearchIcon className="w-12 h-12 mb-4 opacity-20" />
                                    <p>输入关键词搜索 POI</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* 地图 - 使用 h-full 确保铺满 */}
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
