import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Key, Plus, Trash2, Eye, EyeOff, Loader2, ExternalLink, Search, ChevronRight, ChevronDown, X, Check, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface ApiKey {
    id: number;
    name: string;
    api_key: string;
    is_active: boolean;
    quota_exhausted: boolean;
}

interface Region {
    code: string;
    name: string;
    level: number;
    parent_code: string | null;
}

interface SelectedRegion {
    code: string;
    name: string;
    level: number;
}

const platforms = [
    { id: 'tianditu', name: '天地图', url: 'https://console.tianditu.gov.cn' },
    { id: 'amap', name: '高德地图', url: 'https://console.amap.com' },
    { id: 'baidu', name: '百度地图', url: 'https://lbsyun.baidu.com' },
];

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
    // API Key State
    const [keys, setKeys] = useState<Record<string, ApiKey[]>>({});
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
    const [newKey, setNewKey] = useState<Record<string, { name: string; key: string }>>({});
    const [addingKey, setAddingKey] = useState<string | null>(null);

    // Region State
    const [provinces, setProvinces] = useState<Region[]>([]);
    const [children, setChildren] = useState<Record<string, Region[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selectedRegions, setSelectedRegions] = useState<SelectedRegion[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Region[]>([]);
    const [savingRegions, setSavingRegions] = useState(false);

    useEffect(() => {
        if (open) {
            loadApiKeys();
            loadProvinces();
            loadSavedRegions();
        }
    }, [open]);

    // API Key Functions
    const loadApiKeys = async () => {
        try {
            const data = await invoke<Record<string, ApiKey[]>>('get_api_keys');
            setKeys(data);
        } catch (e) {
            console.error('加载API Key失败:', e);
        }
    };

    const addKey = async (platform: string) => {
        const data = newKey[platform];
        if (!data?.key) return;

        setAddingKey(platform);
        try {
            await invoke('add_api_key', {
                platform,
                apiKey: data.key,
                name: data.name || undefined
            });
            setNewKey({ ...newKey, [platform]: { name: '', key: '' } });
            loadApiKeys();
        } catch (e) {
            console.error('添加Key失败:', e);
        } finally {
            setAddingKey(null);
        }
    };

    const deleteKey = async (platform: string, keyId: number) => {
        if (!confirm('确定要删除这个 API Key 吗？')) return;
        try {
            await invoke('delete_api_key', { platform, keyId });
            loadApiKeys();
        } catch (e) {
            console.error('删除失败:', e);
        }
    };

    const openPlatformUrl = (url: string) => {
        window.open(url, '_blank');
    };

    // Region Functions
    const loadProvinces = async () => {
        try {
            const data = await invoke<Region[]>('get_provinces');
            setProvinces(data);
        } catch (e) {
            console.error('Failed to load provinces:', e);
        }
    };

    const loadSavedRegions = () => {
        try {
            const saved = localStorage.getItem('poi_selected_regions');
            if (saved) setSelectedRegions(JSON.parse(saved));
        } catch (e) {
            console.error('Failed to load saved regions:', e);
        }
    };

    const loadChildren = async (parentCode: string) => {
        if (children[parentCode]) return;
        try {
            const data = await invoke<Region[]>('get_region_children', { parentCode });
            setChildren(prev => ({ ...prev, [parentCode]: data }));
        } catch (e) {
            console.error('Failed to load children:', e);
        }
    };

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

    const handleSearch = useCallback(async () => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }
        try {
            const results = await invoke<Region[]>('search_regions', { query: searchQuery });
            setSearchResults(results.slice(0, 20));
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

    const saveRegions = async () => {
        setSavingRegions(true);
        try {
            localStorage.setItem('poi_selected_regions', JSON.stringify(selectedRegions));
            await new Promise(r => setTimeout(r, 300));
        } finally {
            setSavingRegions(false);
        }
    };

    const renderRegion = (region: Region, indent: number = 0) => {
        const hasChildren = region.level < 3;
        const isExpanded = expanded.has(region.code);
        const selected = isSelected(region.code);
        const regionChildren = children[region.code] || [];

        return (
            <div key={region.code}>
                <div
                    className={`flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer text-sm transition-colors
                              ${selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
                    style={{ paddingLeft: `${indent * 16 + 8}px` }}
                >
                    {hasChildren ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); toggleExpand(region.code); }}
                            className="p-0.5"
                        >
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                    ) : (
                        <span className="w-4" />
                    )}
                    <span className="flex-1" onClick={() => toggleSelect(region)}>{region.name}</span>
                    {selected && <Check className="w-3.5 h-3.5 text-primary" />}
                </div>
                {isExpanded && regionChildren.map(child => renderRegion(child, indent + 1))}
            </div>
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle>设置</DialogTitle>
                </DialogHeader>

                <Tabs defaultValue="apikeys" className="flex-1 flex flex-col overflow-hidden">
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="apikeys">
                            <Key className="w-4 h-4 mr-2" />
                            API Key
                        </TabsTrigger>
                        <TabsTrigger value="regions">
                            <MapPin className="w-4 h-4 mr-2" />
                            地区管理
                        </TabsTrigger>
                    </TabsList>

                    {/* API Keys Tab */}
                    <TabsContent value="apikeys" className="flex-1 overflow-y-auto">
                        <div className="space-y-4 py-2">
                            {platforms.map((platform) => {
                                const platformKeys = keys[platform.id] || [];
                                const isAdding = addingKey === platform.id;

                                return (
                                    <div key={platform.id} className="border rounded-lg p-4">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <Key className="w-4 h-4 text-primary" />
                                                <span className="font-medium">{platform.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    ({platformKeys.length} 个)
                                                </span>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => openPlatformUrl(platform.url)}
                                                className="text-primary"
                                            >
                                                申请 Key
                                                <ExternalLink className="w-3.5 h-3.5 ml-1" />
                                            </Button>
                                        </div>

                                        {/* Key List */}
                                        <div className="space-y-2 mb-3">
                                            {platformKeys.map((k) => (
                                                <div key={k.id} className="flex items-center gap-2 p-2 bg-muted rounded">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium truncate">{k.name || `Key ${k.id}`}</div>
                                                        <div className="text-xs text-muted-foreground font-mono truncate">
                                                            {showKeys[`${platform.id}-${k.id}`] ? k.api_key : '••••••••••••'}
                                                        </div>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        onClick={() => setShowKeys({
                                                            ...showKeys,
                                                            [`${platform.id}-${k.id}`]: !showKeys[`${platform.id}-${k.id}`]
                                                        })}
                                                    >
                                                        {showKeys[`${platform.id}-${k.id}`] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 text-destructive hover:text-destructive"
                                                        onClick={() => deleteKey(platform.id, k.id)}
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Add Key */}
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                placeholder="备注（可选）"
                                                className="w-24 px-2 py-1.5 border border-input bg-background rounded text-sm"
                                                value={newKey[platform.id]?.name || ''}
                                                onChange={(e) => setNewKey({
                                                    ...newKey,
                                                    [platform.id]: { ...newKey[platform.id], name: e.target.value }
                                                })}
                                            />
                                            <input
                                                type="text"
                                                placeholder="API Key"
                                                className="flex-1 px-2 py-1.5 border border-input bg-background rounded text-sm font-mono"
                                                value={newKey[platform.id]?.key || ''}
                                                onChange={(e) => setNewKey({
                                                    ...newKey,
                                                    [platform.id]: { ...newKey[platform.id], key: e.target.value }
                                                })}
                                                onKeyDown={(e) => e.key === 'Enter' && addKey(platform.id)}
                                            />
                                            <Button
                                                size="sm"
                                                onClick={() => addKey(platform.id)}
                                                disabled={isAdding || !newKey[platform.id]?.key}
                                            >
                                                {isAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </TabsContent>

                    {/* Regions Tab */}
                    <TabsContent value="regions" className="flex-1 overflow-hidden flex flex-col">
                        {/* Selected Tags */}
                        {selectedRegions.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 p-2 border-b mb-2">
                                {selectedRegions.map(r => (
                                    <span
                                        key={r.code}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs"
                                    >
                                        {r.name}
                                        <button
                                            onClick={() => setSelectedRegions(prev => prev.filter(s => s.code !== r.code))}
                                            className="hover:bg-primary/20 rounded"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}

                        <div className="flex-1 grid grid-cols-2 gap-4 overflow-hidden">
                            {/* Search */}
                            <div className="flex flex-col overflow-hidden">
                                <div className="relative mb-2">
                                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="搜索地区..."
                                        className="w-full pl-8 pr-3 py-1.5 border border-input bg-background rounded text-sm"
                                    />
                                </div>
                                <div className="flex-1 overflow-y-auto border rounded p-1">
                                    {searchResults.length > 0 ? (
                                        searchResults.map(r => (
                                            <div
                                                key={r.code}
                                                onClick={() => toggleSelect(r)}
                                                className={`flex items-center justify-between py-1.5 px-2 rounded cursor-pointer text-sm
                                                          ${isSelected(r.code) ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
                                            >
                                                <span>{r.name}</span>
                                                {isSelected(r.code) && <Check className="w-3.5 h-3.5" />}
                                            </div>
                                        ))
                                    ) : searchQuery ? (
                                        <div className="text-center text-muted-foreground py-4 text-sm">无结果</div>
                                    ) : (
                                        <div className="text-center text-muted-foreground py-4 text-sm">输入关键词搜索</div>
                                    )}
                                </div>
                            </div>

                            {/* Browse */}
                            <div className="flex flex-col overflow-hidden">
                                <div className="text-sm font-medium mb-2">浏览地区</div>
                                <div className="flex-1 overflow-y-auto border rounded p-1">
                                    {provinces.map(p => renderRegion(p))}
                                </div>
                            </div>
                        </div>

                        {/* Save Button */}
                        <div className="flex items-center justify-between pt-3 border-t mt-2">
                            <span className="text-sm text-muted-foreground">
                                已选择 {selectedRegions.length} 个地区
                            </span>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => setSelectedRegions([])}>
                                    清空
                                </Button>
                                <Button size="sm" onClick={saveRegions} disabled={savingRegions}>
                                    {savingRegions ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                                    保存
                                </Button>
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
