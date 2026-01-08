import { useState, useRef, useEffect, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import { Search, MapPin, Loader2, X } from 'lucide-react';

interface SearchResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string]; // [south, north, west, east]
}

interface MapSearchBoxProps {
    onLocationSelect?: (lat: number, lon: number, bounds?: [number, number, number, number]) => void;
    placeholder?: string;
}

export function MapSearchBox({
    onLocationSelect,
    placeholder = '搜索地点...',
}: MapSearchBoxProps) {
    const map = useMap();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 搜索地点 (Nominatim API)
    const searchLocation = useCallback(async (searchQuery: string) => {
        if (!searchQuery.trim() || searchQuery.length < 2) {
            setResults([]);
            setShowDropdown(false);
            return;
        }

        setLoading(true);
        try {
            const params = new URLSearchParams({
                q: searchQuery,
                format: 'json',
                limit: '6',
                'accept-language': 'zh-CN',
                addressdetails: '1',
            });

            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?${params}`,
                {
                    headers: {
                        'User-Agent': 'POI-Collector-App/1.0',
                    },
                }
            );

            if (response.ok) {
                const data: SearchResult[] = await response.json();
                setResults(data);
                setShowDropdown(data.length > 0);
                setSelectedIndex(-1);
            }
        } catch (error) {
            console.error('搜索失败:', error);
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);

    // 防抖搜索
    useEffect(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }

        if (query.trim()) {
            debounceRef.current = setTimeout(() => {
                searchLocation(query);
            }, 300);
        } else {
            setResults([]);
            setShowDropdown(false);
        }

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        };
    }, [query, searchLocation]);

    // 点击外部关闭下拉框
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(e.target as Node) &&
                inputRef.current &&
                !inputRef.current.contains(e.target as Node)
            ) {
                setShowDropdown(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // 选择搜索结果
    const handleSelect = (result: SearchResult) => {
        const lat = parseFloat(result.lat);
        const lon = parseFloat(result.lon);

        // 解析 bounding box: [south, north, west, east]
        const bounds: [number, number, number, number] = [
            parseFloat(result.boundingbox[0]), // south
            parseFloat(result.boundingbox[1]), // north
            parseFloat(result.boundingbox[2]), // west
            parseFloat(result.boundingbox[3]), // east
        ];

        // 飞到该位置
        if (bounds[1] > bounds[0] && bounds[3] > bounds[2]) {
            map.flyToBounds(
                [
                    [bounds[0], bounds[2]], // southwest
                    [bounds[1], bounds[3]], // northeast
                ],
                { padding: [20, 20], maxZoom: 14 }
            );
        } else {
            map.flyTo([lat, lon], 12);
        }

        onLocationSelect?.(lat, lon, bounds);
        setQuery(result.display_name.split(',')[0]); // 只显示第一部分
        setShowDropdown(false);
    };

    // 键盘导航
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!showDropdown || results.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex((prev) => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < results.length) {
                    handleSelect(results[selectedIndex]);
                }
                break;
            case 'Escape':
                setShowDropdown(false);
                break;
        }
    };

    // 清除输入
    const handleClear = () => {
        setQuery('');
        setResults([]);
        setShowDropdown(false);
        inputRef.current?.focus();
    };

    return (
        <div className="relative">
            {/* 搜索输入框 */}
            <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => results.length > 0 && setShowDropdown(true)}
                    placeholder={placeholder}
                    className="w-full pl-8 pr-8 py-1.5 text-sm border border-input bg-background rounded-lg
                             focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                             placeholder:text-muted-foreground transition-all"
                />
                {loading ? (
                    <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                ) : query ? (
                    <button
                        onClick={handleClear}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                ) : null}
            </div>

            {/* 搜索结果下拉框 */}
            {showDropdown && results.length > 0 && (
                <div
                    ref={dropdownRef}
                    className="absolute z-[1000] top-full left-0 right-0 mt-1 py-1 bg-popover border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto"
                >
                    {results.map((result, index) => (
                        <button
                            key={result.place_id}
                            onClick={() => handleSelect(result)}
                            className={`w-full flex items-start gap-2 px-3 py-2 text-left text-sm transition-colors
                                      ${index === selectedIndex
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-accent/50'
                                }`}
                        >
                            <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                            <span className="line-clamp-2">{result.display_name}</span>
                        </button>
                    ))}
                </div>
            )}

            {/* 无结果提示 */}
            {showDropdown && results.length === 0 && !loading && query.length >= 2 && (
                <div className="absolute z-[1000] top-full left-0 right-0 mt-1 py-3 px-4 bg-popover border border-border rounded-lg shadow-lg text-sm text-muted-foreground text-center">
                    未找到相关地点
                </div>
            )}
        </div>
    );
}

export default MapSearchBox;
