import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { Database, Trash2, AlertTriangle, FolderTree, RefreshCw, HardDrive, Shield, Ship, Anchor, FileJson, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import SimpleBar from 'simplebar-react';

interface Region {
    code: string;
    name: string;
    level: string;
    parent_code: string | null;
}


export default function DataManagement() {
    const { success, error: showError } = useToast();
    const [loading, setLoading] = useState(false);
    const [stats, setStats] = useState<[string, number][]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [regionNames, setRegionNames] = useState<Map<string, string>>(new Map());
    const [buoyCount, setBuoyCount] = useState(0);

    useEffect(() => {
        loadStats();
        loadRegionNames();
        loadBuoyData();
    }, []);

    const loadBuoyData = async () => {
        try {
            const count = await invoke<number>('chart_get_buoy_count');
            setBuoyCount(count);
        } catch (e) {
            console.error('加载航标数据失败:', e);
        }
    };

    const loadRegionNames = async () => {
        try {
            const provinces = await invoke<Region[]>('get_provinces');
            const names = new Map<string, string>();
            provinces.forEach(p => names.set(p.code, p.name));

            for (const province of provinces) {
                try {
                    const cities = await invoke<Region[]>('get_region_children', { parentCode: province.code });
                    cities.forEach(c => names.set(c.code, c.name));
                    for (const city of cities) {
                        try {
                            const districts = await invoke<Region[]>('get_region_children', { parentCode: city.code });
                            districts.forEach(d => names.set(d.code, d.name));
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            setRegionNames(names);
        } catch (e) {
            console.error('加载区域名称失败:', e);
        }
    };

    const loadStats = async () => {
        setLoading(true);
        try {
            await invoke<[number, number]>('fix_region_codes');
            const data = await invoke<[string, number][]>('get_poi_stats_by_region');
            setStats(data);
        } catch (e) {
            console.error('加载统计失败:', e);
        } finally {
            setLoading(false);
        }
    };

    const toggleSelect = (code: string) => {
        const newSelected = new Set(selected);
        if (newSelected.has(code)) {
            newSelected.delete(code);
        } else {
            newSelected.add(code);
        }
        setSelected(newSelected);
    };

    const deleteSelected = async () => {
        if (selected.size === 0) return;
        const codes = Array.from(selected);
        const names = codes.map(c => regionNames.get(c) || c).join(', ');
        if (!confirm(`确定要删除以下地区的所有数据吗？\n\n${names}\n\n此操作不可撤销！`)) return;
        try {
            const count = await invoke<number>('delete_poi_by_regions', { codes });
            success('删除成功', `已删除 ${count.toLocaleString()} 条数据`);
            setSelected(new Set());
            loadStats();
        } catch (e) {
            showError('删除失败', String(e));
        }
    };

    const deleteRegion = async (code: string) => {
        const name = regionNames.get(code) || code;
        if (!confirm(`确定要删除 ${name} 的所有数据吗？\n\n此操作不可撤销！`)) return;
        try {
            const count = await invoke<number>('delete_poi_by_regions', { codes: [code] });
            success('删除成功', `已删除 ${count.toLocaleString()} 条数据`);
            loadStats();
        } catch (e) {
            showError('删除失败', String(e));
        }
    };

    const clearAll = async () => {
        if (!confirm('⚠️ 危险操作！\n\n确定要清空所有 POI 数据吗？\n\n此操作将删除所有已采集的数据，不可撤销！')) return;
        if (!confirm('再次确认：您真的要删除全部数据吗？')) return;
        try {
            const count = await invoke<number>('clear_all_poi');
            success('清空成功', `已删除 ${count.toLocaleString()} 条数据`);
            loadStats();
        } catch (e) {
            showError('清空失败', String(e));
        }
    };

    const totalCount = stats.reduce((sum, [, count]) => sum + count, 0);
    const gradients = [
        'from-cyan-500 to-cyan-400',
        'from-indigo-500 to-indigo-400',
        'from-violet-500 to-violet-400',
        'from-pink-500 to-pink-400',
        'from-orange-500 to-orange-400'
    ];



    return (
        <div className="h-full flex flex-col gap-4">
            <div className="flex items-center justify-between shrink-0">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据管理</h1>
                    <p className="text-muted-foreground">管理已采集的 POI 和航标数据</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20">
                        <HardDrive className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium text-primary">POI {totalCount.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
                        <Anchor className="w-4 h-4 text-blue-500" />
                        <span className="text-sm font-medium text-blue-500">航标 {buoyCount.toLocaleString()}</span>
                    </div>
                    <Button variant="outline" onClick={() => { loadStats(); loadBuoyData(); }} disabled={loading} className="hover-lift">
                        <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        刷新
                    </Button>
                </div>
            </div>

            {/* 上半部分: POI + 操作 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 shrink-0" style={{ maxHeight: '45%' }}>
                {/* POI 数据统计 */}
                <Card className="overflow-hidden flex flex-col lg:col-span-2">
                    <CardHeader className="shrink-0 border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent py-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
                                    <Database className="w-3.5 h-3.5 text-primary" />
                                </div>
                                <CardTitle className="text-sm">POI 数据</CardTitle>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">{stats.length} 个地区</span>
                                {selected.size > 0 && (
                                    <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={deleteSelected}>
                                        <Trash2 className="w-3 h-3 mr-1" />
                                        删除 ({selected.size})
                                    </Button>
                                )}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-0 p-0">
                        <SimpleBar className="h-full p-3">
                            {stats.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                                    <FolderTree className="w-8 h-8 opacity-30 mb-2" />
                                    <p className="text-sm">暂无 POI 数据</p>
                                </div>
                            ) : (
                                <div className="space-y-1.5">
                                    {stats.map(([code, count], index) => {
                                        const isSelected = selected.has(code);
                                        const percent = totalCount > 0 ? (count / totalCount) * 100 : 0;
                                        return (
                                            <div
                                                key={code}
                                                className={`p-2.5 rounded-lg border transition-all cursor-pointer
                                                      ${isSelected ? 'bg-primary/10 border-primary/30' : 'border-border/50 hover:bg-accent/50'}`}
                                                onClick={() => toggleSelect(code)}
                                            >
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <div className="flex items-center gap-2">
                                                        <input type="checkbox" checked={isSelected} onChange={() => { }} className="w-3.5 h-3.5 accent-primary" />
                                                        <span className="text-sm font-medium">{regionNames.get(code) || code}</span>
                                                        <span className="text-xs text-muted-foreground">{count.toLocaleString()} 条</span>
                                                    </div>
                                                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                                        onClick={(e) => { e.stopPropagation(); deleteRegion(code); }}>
                                                        <Trash2 className="w-3 h-3" />
                                                    </Button>
                                                </div>
                                                <div className="h-1 bg-muted rounded-full overflow-hidden">
                                                    <div className={`h-full rounded-full bg-gradient-to-r ${gradients[index % gradients.length]}`}
                                                        style={{ width: `${percent}%` }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </SimpleBar>
                    </CardContent>
                </Card>

                {/* 操作面板 */}
                <Card className="overflow-hidden flex flex-col">
                    <CardHeader className="shrink-0 border-b border-border/50 bg-gradient-to-r from-amber-500/10 to-transparent py-3">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center">
                                <Shield className="w-3.5 h-3.5 text-amber-500" />
                            </div>
                            <CardTitle className="text-sm">数据操作</CardTitle>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
                        <SimpleBar className="h-full p-4">
                            <div className="space-y-4">
                                {/* 清空 POI */}
                                <div className="p-3 border border-destructive/30 bg-destructive/5 rounded-xl">
                                    <h3 className="font-medium text-destructive mb-2 flex items-center gap-2 text-sm">
                                        <AlertTriangle className="w-3.5 h-3.5" /> 清空 POI
                                    </h3>
                                    <Button variant="destructive" size="sm" onClick={clearAll} disabled={totalCount === 0} className="w-full">
                                        <Trash2 className="w-3 h-3 mr-1" /> 清空全部 POI ({totalCount.toLocaleString()})
                                    </Button>
                                </div>

                                {/* 航标操作 */}
                                <div className="p-3 border border-blue-500/30 bg-blue-500/5 rounded-xl">
                                    <h3 className="font-medium mb-2 flex items-center gap-2 text-sm">
                                        <Ship className="w-3.5 h-3.5 text-blue-500" /> 航标操作
                                    </h3>
                                    <div className="space-y-2">
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" className="flex-1" disabled={buoyCount === 0}
                                                onClick={async () => {
                                                    try {
                                                        const filePath = await save({ defaultPath: 'buoys.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
                                                        if (!filePath) return;
                                                        const result = await invoke<string>('chart_export_buoys', { format: 'json', outputPath: filePath });
                                                        success('导出成功', result);
                                                    } catch (e) { showError('导出失败', String(e)); }
                                                }}>
                                                <FileJson className="w-3 h-3 mr-1" /> JSON
                                            </Button>
                                            <Button variant="outline" size="sm" className="flex-1" disabled={buoyCount === 0}
                                                onClick={async () => {
                                                    try {
                                                        const filePath = await save({ defaultPath: 'buoys.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
                                                        if (!filePath) return;
                                                        const result = await invoke<string>('chart_export_buoys', { format: 'csv', outputPath: filePath });
                                                        success('导出成功', result);
                                                    } catch (e) { showError('导出失败', String(e)); }
                                                }}>
                                                <FileSpreadsheet className="w-3 h-3 mr-1" /> CSV
                                            </Button>
                                        </div>
                                        <Button variant="destructive" size="sm" className="w-full" disabled={buoyCount === 0}
                                            onClick={async () => {
                                                if (!confirm('确定要清空所有航标数据吗？\n\n此操作不可撤销！')) return;
                                                try {
                                                    await invoke('chart_clear_buoys');
                                                    success('清空成功', '航标数据已清空');
                                                    loadBuoyData();
                                                } catch (e) { showError('清空失败', String(e)); }
                                            }}>
                                            <Trash2 className="w-3 h-3 mr-1" /> 清空航标 ({buoyCount.toLocaleString()})
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </SimpleBar>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
