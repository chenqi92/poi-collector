import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, ChevronRight, ChevronDown, X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface Region {
    code: string;
    name: string;
    level: number;
    parent_code: string | null;
}

export interface SelectedRegion {
    code: string;
    name: string;
    level: number;
}

export default function Regions() {
    const [provinces, setProvinces] = useState<Region[]>([]);
    const [children, setChildren] = useState<Record<string, Region[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selectedRegions, setSelectedRegions] = useState<SelectedRegion[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Region[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // 加载省份
    useEffect(() => {
        loadProvinces();
        loadSavedRegions();
    }, []);

    const loadProvinces = async () => {
        try {
            const data = await invoke<Region[]>('get_provinces');
            setProvinces(data);
        } catch (e) {
            console.error('Failed to load provinces:', e);
        } finally {
            setLoading(false);
        }
    };

    const loadSavedRegions = () => {
        try {
            const saved = localStorage.getItem('poi_selected_regions');
            if (saved) {
                setSelectedRegions(JSON.parse(saved));
            }
        } catch (e) {
            console.error('Failed to load saved regions:', e);
        }
    };

    // 加载子区域
    const loadChildren = async (parentCode: string) => {
        if (children[parentCode]) return;
        try {
            const data = await invoke<Region[]>('get_region_children', { parentCode });
            setChildren(prev => ({ ...prev, [parentCode]: data }));
        } catch (e) {
            console.error('Failed to load children:', e);
        }
    };

    // 展开/折叠
    const toggleExpand = async (code: string) => {
        const newExpanded = new Set(expanded);
        if (newExpanded.has(code)) {
            newExpanded.delete(code);
        } else {
            newExpanded.add(code);
            await loadChildren(code);
        }
        setExpanded(newExpanded);
    };

    // 选择/取消选择
    const toggleSelect = (region: Region) => {
        setSelectedRegions(prev => {
            const exists = prev.find(r => r.code === region.code);
            if (exists) {
                return prev.filter(r => r.code !== region.code);
            } else {
                return [...prev, { code: region.code, name: region.name, level: region.level }];
            }
        });
    };

    const isSelected = (code: string) => selectedRegions.some(r => r.code === code);

    // 搜索
    const handleSearch = useCallback(async () => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }
        try {
            const results = await invoke<Region[]>('search_regions', { query: searchQuery });
            setSearchResults(results);
        } catch (e) {
            console.error('Search failed:', e);
        }
    }, [searchQuery]);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery) handleSearch();
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery, handleSearch]);

    // 保存
    const saveRegions = async () => {
        setSaving(true);
        try {
            localStorage.setItem('poi_selected_regions', JSON.stringify(selectedRegions));
            await new Promise(r => setTimeout(r, 500));
        } finally {
            setSaving(false);
        }
    };

    // 清空
    const clearAll = () => {
        setSelectedRegions([]);
    };

    // 渲染区域项
    const renderRegion = (region: Region, indent: number = 0) => {
        const hasChildren = region.level < 3;
        const isExpanded = expanded.has(region.code);
        const selected = isSelected(region.code);
        const regionChildren = children[region.code] || [];

        return (
            <div key={region.code}>
                <div
                    className={`flex items-center gap-2 py-2 px-3 rounded-md cursor-pointer transition-colors
                              ${selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
                    style={{ paddingLeft: `${indent * 20 + 12}px` }}
                >
                    {hasChildren ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); toggleExpand(region.code); }}
                            className="p-0.5"
                        >
                            {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                            ) : (
                                <ChevronRight className="w-4 h-4" />
                            )}
                        </button>
                    ) : (
                        <span className="w-5" />
                    )}
                    <span
                        className="flex-1 text-sm"
                        onClick={() => toggleSelect(region)}
                    >
                        {region.name}
                    </span>
                    {selected && <Check className="w-4 h-4 text-primary" />}
                </div>
                {isExpanded && regionChildren.map(child => renderRegion(child, indent + 1))}
            </div>
        );
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">地区管理</h1>
                    <p className="text-muted-foreground">选择要采集数据的地区</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={clearAll} disabled={selectedRegions.length === 0}>
                        清空
                    </Button>
                    <Button onClick={saveRegions} disabled={saving}>
                        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                        保存 ({selectedRegions.length})
                    </Button>
                </div>
            </div>

            {/* 已选择标签 */}
            {selectedRegions.length > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm">已选择的地区</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap gap-2">
                            {selectedRegions.map(r => (
                                <span
                                    key={r.code}
                                    className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 
                                             text-primary rounded-md text-sm"
                                >
                                    {r.name}
                                    <button
                                        onClick={() => setSelectedRegions(prev =>
                                            prev.filter(s => s.code !== r.code)
                                        )}
                                        className="hover:bg-primary/20 rounded p-0.5"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className="grid grid-cols-2 gap-6">
                {/* 搜索 */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">搜索地区</CardTitle>
                        <CardDescription>输入名称快速查找</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="输入地区名称..."
                                className="w-full pl-10 pr-4 py-2 border border-input bg-background rounded-md 
                                         text-foreground placeholder:text-muted-foreground focus:outline-none 
                                         focus:ring-2 focus:ring-ring"
                            />
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                            {searchResults.length > 0 ? (
                                searchResults.map(r => (
                                    <div
                                        key={r.code}
                                        onClick={() => toggleSelect(r)}
                                        className={`flex items-center justify-between py-2 px-3 rounded-md 
                                                  cursor-pointer transition-colors
                                                  ${isSelected(r.code) ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
                                    >
                                        <span className="text-sm">{r.name}</span>
                                        {isSelected(r.code) && <Check className="w-4 h-4" />}
                                    </div>
                                ))
                            ) : searchQuery ? (
                                <div className="text-center text-muted-foreground py-4">无结果</div>
                            ) : null}
                        </div>
                    </CardContent>
                </Card>

                {/* 浏览 */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">浏览地区</CardTitle>
                        <CardDescription>按层级选择</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="max-h-80 overflow-y-auto">
                            {provinces.map(p => renderRegion(p))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
