import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Download, FileSpreadsheet, FileJson, Database, Loader2, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface ExportStats {
    total: number;
    by_platform: Record<string, number>;
    by_category: Record<string, number>;
}

interface POI {
    id: number;
    platform: string;
    name: string;
    lon: number;
    lat: number;
    address?: string;
    category?: string;
}

interface Region {
    code: string;
    name: string;
    level: number;
    parent_code: string | null;
}

const platformNames: Record<string, string> = {
    all: '全部平台',
    tianditu: '天地图',
    amap: '高德地图',
    baidu: '百度地图',
};

const formats = [
    { id: 'excel', icon: FileSpreadsheet, label: 'Excel', desc: '.xlsx' },
    { id: 'json', icon: FileJson, label: 'JSON', desc: '.json' },
    { id: 'mysql', icon: Database, label: 'MySQL', desc: '.sql' },
];

export default function Export() {
    const [stats, setStats] = useState<ExportStats | null>(null);
    const [format, setFormat] = useState('excel');
    const [platform, setPlatform] = useState('all');
    const [exporting, setExporting] = useState(false);
    const [success, setSuccess] = useState(false);

    // 地区筛选
    const [provinces, setProvinces] = useState<Region[]>([]);
    const [children, setChildren] = useState<Record<string, Region[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selectedRegions, setSelectedRegions] = useState<string[]>([]);

    // 数据预览
    const [previewData, setPreviewData] = useState<POI[]>([]);
    const [loadingPreview, setLoadingPreview] = useState(false);

    useEffect(() => {
        loadStats();
        loadProvinces();
    }, []);

    const loadStats = async () => {
        try {
            const data = await invoke<ExportStats>('get_stats');
            setStats(data);
        } catch (e) {
            console.error('加载统计失败:', e);
        }
    };

    const loadProvinces = async () => {
        try {
            const data = await invoke<Region[]>('get_provinces');
            setProvinces(data);
        } catch (e) {
            console.error('加载省份失败:', e);
        }
    };

    const loadChildren = async (parentCode: string) => {
        if (children[parentCode]) return;
        try {
            const data = await invoke<Region[]>('get_region_children', { parentCode });
            setChildren(prev => ({ ...prev, [parentCode]: data }));
        } catch (e) {
            console.error('加载子区域失败:', e);
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

    const toggleSelectRegion = (code: string) => {
        setSelectedRegions(prev =>
            prev.includes(code)
                ? prev.filter(c => c !== code)
                : [...prev, code]
        );
    };

    const loadPreview = async () => {
        setLoadingPreview(true);
        try {
            // 模拟加载预览数据
            const data = await invoke<POI[]>('search_poi', {
                query: '',
                platform: platform === 'all' ? null : platform,
                mode: 'contains',
            });
            setPreviewData(data.slice(0, 50));
        } catch (e) {
            console.error('加载预览失败:', e);
        } finally {
            setLoadingPreview(false);
        }
    };

    useEffect(() => {
        loadPreview();
    }, [platform]);

    const handleExport = async () => {
        setExporting(true);
        setSuccess(false);
        try {
            await new Promise(resolve => setTimeout(resolve, 2000));
            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
        } finally {
            setExporting(false);
        }
    };

    const selectedCount = platform === 'all'
        ? stats?.total || 0
        : stats?.by_platform[platform] || 0;

    const renderRegion = (region: Region, indent: number = 0) => {
        const hasChildren = region.level < 3;
        const isExpanded = expanded.has(region.code);
        const isSelected = selectedRegions.includes(region.code);
        const regionChildren = children[region.code] || [];

        return (
            <div key={region.code}>
                <div
                    className={`flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-sm transition-colors
                              ${isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
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
                    <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectRegion(region.code)}
                        className="w-3.5 h-3.5"
                    />
                    <span className="flex-1" onClick={() => toggleSelectRegion(region.code)}>{region.name}</span>
                </div>
                {isExpanded && regionChildren.map(child => renderRegion(child, indent + 1))}
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col gap-4">
            <div>
                <h1 className="text-2xl font-bold text-foreground">数据导出</h1>
                <p className="text-muted-foreground">选择数据范围并导出为各种格式</p>
            </div>

            {/* 统计概览 */}
            <div className="grid grid-cols-4 gap-4 shrink-0">
                <Card>
                    <CardContent className="pt-4">
                        <div className="text-2xl font-bold text-foreground">
                            {stats?.total?.toLocaleString() || 0}
                        </div>
                        <div className="text-sm text-muted-foreground">总数据量</div>
                    </CardContent>
                </Card>
                {Object.entries(stats?.by_platform || {}).map(([p, count]) => (
                    <Card key={p}>
                        <CardContent className="pt-4">
                            <div className="text-xl font-bold text-foreground">
                                {count.toLocaleString()}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                {platformNames[p] || p}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-3 gap-4">
                {/* 左侧: 地区筛选 */}
                <Card className="overflow-hidden flex flex-col">
                    <CardHeader className="pb-2 shrink-0">
                        <CardTitle className="text-base">按地区筛选</CardTitle>
                        <CardDescription>选择要导出的地区</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-2">
                        {provinces.map(p => renderRegion(p))}
                    </CardContent>
                    {selectedRegions.length > 0 && (
                        <div className="p-2 border-t text-xs text-muted-foreground">
                            已选择 {selectedRegions.length} 个地区
                            <Button variant="link" size="sm" className="ml-2 h-auto p-0 text-xs" onClick={() => setSelectedRegions([])}>
                                清空
                            </Button>
                        </div>
                    )}
                </Card>

                {/* 中间: 数据预览表格 */}
                <Card className="overflow-hidden flex flex-col">
                    <CardHeader className="pb-2 shrink-0">
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="text-base">数据预览</CardTitle>
                                <CardDescription>前 50 条记录</CardDescription>
                            </div>
                            <select
                                value={platform}
                                onChange={(e) => setPlatform(e.target.value)}
                                className="px-2 py-1 text-sm border border-input bg-background rounded"
                            >
                                {Object.entries(platformNames).map(([key, name]) => (
                                    <option key={key} value={key}>{name}</option>
                                ))}
                            </select>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-auto p-0">
                        {loadingPreview ? (
                            <div className="flex items-center justify-center h-32">
                                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : previewData.length > 0 ? (
                            <table className="w-full text-sm">
                                <thead className="bg-muted sticky top-0">
                                    <tr>
                                        <th className="text-left p-2 font-medium">名称</th>
                                        <th className="text-left p-2 font-medium">地址</th>
                                        <th className="text-left p-2 font-medium">平台</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewData.map((poi) => (
                                        <tr key={poi.id} className="border-b border-border hover:bg-accent/50">
                                            <td className="p-2 truncate max-w-[150px]" title={poi.name}>{poi.name}</td>
                                            <td className="p-2 truncate max-w-[150px] text-muted-foreground" title={poi.address}>
                                                {poi.address || '-'}
                                            </td>
                                            <td className="p-2">
                                                <span className="px-1.5 py-0.5 bg-muted rounded text-xs">
                                                    {platformNames[poi.platform] || poi.platform}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="flex items-center justify-center h-32 text-muted-foreground">
                                暂无数据
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* 右侧: 导出配置 */}
                <Card className="flex flex-col">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">导出设置</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 space-y-4">
                        {/* 格式选择 */}
                        <div>
                            <label className="block text-sm text-muted-foreground mb-2">选择格式</label>
                            <div className="space-y-2">
                                {formats.map((f) => {
                                    const Icon = f.icon;
                                    return (
                                        <button
                                            key={f.id}
                                            onClick={() => setFormat(f.id)}
                                            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all
                                                      ${format === f.id
                                                    ? 'border-primary bg-primary/5'
                                                    : 'border-border hover:border-primary/50'
                                                }`}
                                        >
                                            <Icon className={`w-5 h-5 ${format === f.id ? 'text-primary' : 'text-muted-foreground'}`} />
                                            <span className={format === f.id ? 'text-foreground font-medium' : 'text-muted-foreground'}>
                                                {f.label}
                                            </span>
                                            <span className="ml-auto text-xs text-muted-foreground">{f.desc}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 导出数量 */}
                        <div className="p-3 bg-muted rounded-lg">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">即将导出</span>
                                <span className="text-xl font-bold text-foreground">
                                    {selectedCount.toLocaleString()} 条
                                </span>
                            </div>
                        </div>

                        {/* 导出按钮 */}
                        <Button
                            className="w-full"
                            size="lg"
                            onClick={handleExport}
                            disabled={exporting || selectedCount === 0}
                        >
                            {exporting ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                    导出中...
                                </>
                            ) : success ? (
                                <>
                                    <CheckCircle className="w-4 h-4 mr-2" />
                                    导出成功！
                                </>
                            ) : (
                                <>
                                    <Download className="w-4 h-4 mr-2" />
                                    开始导出
                                </>
                            )}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
