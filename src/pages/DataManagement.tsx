import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Database, Trash2, AlertTriangle, FolderTree, RefreshCw, HardDrive, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';

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

    useEffect(() => {
        loadStats();
        loadRegionNames();
    }, []);

    const loadRegionNames = async () => {
        try {
            const provinces = await invoke<Region[]>('get_provinces');
            const names = new Map<string, string>();
            provinces.forEach(p => names.set(p.code, p.name));

            // 加载所有市县的名称
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
            // 先修复 region_code
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

        if (!confirm(`确定要删除以下地区的所有数据吗？\n\n${names}\n\n此操作不可撤销！`)) {
            return;
        }

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
        if (!confirm(`确定要删除 ${name} 的所有数据吗？\n\n此操作不可撤销！`)) {
            return;
        }

        try {
            const count = await invoke<number>('delete_poi_by_regions', { codes: [code] });
            success('删除成功', `已删除 ${count.toLocaleString()} 条数据`);
            loadStats();
        } catch (e) {
            showError('删除失败', String(e));
        }
    };

    const clearAll = async () => {
        if (!confirm('⚠️ 危险操作！\n\n确定要清空所有 POI 数据吗？\n\n此操作将删除所有已采集的数据，不可撤销！')) {
            return;
        }
        if (!confirm('再次确认：您真的要删除全部数据吗？')) {
            return;
        }

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
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">数据管理</h1>
                    <p className="text-muted-foreground">管理已采集的 POI 数据</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20">
                        <HardDrive className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium text-primary">{totalCount.toLocaleString()} 条记录</span>
                    </div>
                    <Button variant="outline" onClick={loadStats} disabled={loading} className="hover-lift">
                        <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        刷新
                    </Button>
                </div>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* POI 数据统计 */}
                <Card className="overflow-hidden flex flex-col">
                    <CardHeader className="shrink-0 border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                                    <Database className="w-4 h-4 text-primary" />
                                </div>
                                <CardTitle>POI 数据</CardTitle>
                            </div>
                            <span className="text-sm text-muted-foreground">
                                共 <span className="font-medium text-primary">{stats.length}</span> 个地区
                            </span>
                        </div>
                        <CardDescription>按采集地区分组显示</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-4">
                        {stats.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                    <FolderTree className="w-8 h-8 opacity-30" />
                                </div>
                                <p className="font-medium">暂无采集数据</p>
                                <p className="text-sm mt-1">开始采集后将在此显示</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {stats.map(([code, count], index) => {
                                    const isSelected = selected.has(code);
                                    const percent = totalCount > 0 ? (count / totalCount) * 100 : 0;
                                    return (
                                        <div
                                            key={code}
                                            className={`p-3 rounded-xl border transition-all cursor-pointer hover-lift
                                                      ${isSelected ? 'bg-primary/10 border-primary/30' : 'border-border/50 hover:bg-accent/50'}`}
                                            onClick={() => toggleSelect(code)}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-3">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => { }}
                                                        className="w-4 h-4 cursor-pointer accent-primary"
                                                    />
                                                    <div>
                                                        <div className="font-medium">
                                                            {regionNames.get(code) || code}
                                                        </div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {code} · {count.toLocaleString()} 条 ({percent.toFixed(1)}%)
                                                        </div>
                                                    </div>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        deleteRegion(code);
                                                    }}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full bg-gradient-to-r ${gradients[index % gradients.length]} transition-all duration-500`}
                                                    style={{ width: `${percent}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* 操作面板 */}
                <Card className="overflow-hidden flex flex-col">
                    <CardHeader className="shrink-0 border-b border-border/50 bg-gradient-to-r from-amber-500/10 to-transparent">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                                <Shield className="w-4 h-4 text-amber-500" />
                            </div>
                            <CardTitle>数据操作</CardTitle>
                        </div>
                        <CardDescription>批量删除和清空操作</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 p-4 space-y-6">
                        {/* 批量删除 */}
                        <div className="p-4 border border-border/50 rounded-xl bg-muted/20">
                            <h3 className="font-medium mb-2 flex items-center gap-2">
                                <Trash2 className="w-4 h-4 text-muted-foreground" />
                                批量删除
                            </h3>
                            <p className="text-sm text-muted-foreground mb-4">
                                在左侧勾选要删除的地区，然后点击删除按钮
                            </p>
                            <Button
                                variant="destructive"
                                disabled={selected.size === 0}
                                onClick={deleteSelected}
                                className="w-full"
                            >
                                <Trash2 className="w-4 h-4 mr-2" />
                                删除选中 ({selected.size})
                            </Button>
                        </div>

                        {/* 清空全部 */}
                        <div className="p-4 border border-destructive/30 bg-destructive/5 rounded-xl">
                            <h3 className="font-medium text-destructive mb-2 flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4" />
                                危险区域
                            </h3>
                            <p className="text-sm text-muted-foreground mb-4">
                                清空所有 POI 数据。此操作不可撤销，请谨慎操作！
                            </p>
                            <Button
                                variant="destructive"
                                onClick={clearAll}
                                disabled={totalCount === 0}
                                className="w-full"
                            >
                                <Trash2 className="w-4 h-4 mr-2" />
                                清空全部数据
                            </Button>
                        </div>

                        {/* 预留: 瓦片管理 */}
                        <div className="p-4 border border-dashed border-border rounded-xl bg-muted/10">
                            <h3 className="font-medium text-muted-foreground mb-2 flex items-center gap-2">
                                🗺️ 地图瓦片管理
                            </h3>
                            <p className="text-sm text-muted-foreground">
                                功能开发中，敬请期待...
                            </p>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
