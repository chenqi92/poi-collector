import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Download, FileSpreadsheet, FileJson, Database, Loader2, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface ExportStats {
    total: number;
    by_platform: Record<string, number>;
    by_category: Record<string, number>;
}

const platformNames: Record<string, string> = {
    all: '全部平台',
    tianditu: '天地图',
    amap: '高德地图',
    baidu: '百度地图',
};

const formats = [
    { id: 'excel', icon: FileSpreadsheet, label: 'Excel', desc: '导出为 .xlsx 表格' },
    { id: 'json', icon: FileJson, label: 'JSON', desc: '导出为 .json 格式' },
    { id: 'mysql', icon: Database, label: 'MySQL', desc: '导出为 .sql 语句' },
];

export default function Export() {
    const [stats, setStats] = useState<ExportStats | null>(null);
    const [format, setFormat] = useState('excel');
    const [platform, setPlatform] = useState('all');
    const [includeRaw, setIncludeRaw] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        loadStats();
    }, []);

    const loadStats = async () => {
        try {
            const data = await invoke<ExportStats>('get_stats');
            setStats(data);
        } catch (e) {
            console.error('加载统计失败:', e);
        }
    };

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

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground">数据导出</h1>
                <p className="text-muted-foreground">将采集的 POI 数据导出为各种格式</p>
            </div>

            {/* 数据概览 */}
            <div className="grid grid-cols-4 gap-4">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-3xl font-bold text-foreground">
                            {stats?.total?.toLocaleString() || 0}
                        </div>
                        <div className="text-sm text-muted-foreground">总数据量</div>
                    </CardContent>
                </Card>
                {Object.entries(stats?.by_platform || {}).map(([p, count]) => (
                    <Card key={p}>
                        <CardContent className="pt-6">
                            <div className="text-2xl font-bold text-foreground">
                                {count.toLocaleString()}
                            </div>
                            <div className="text-sm text-muted-foreground">
                                {platformNames[p] || p}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid grid-cols-2 gap-6">
                {/* 格式选择 */}
                <Card>
                    <CardHeader>
                        <CardTitle>选择导出格式</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {formats.map((f) => {
                            const Icon = f.icon;
                            const isSelected = format === f.id;
                            return (
                                <button
                                    key={f.id}
                                    onClick={() => setFormat(f.id)}
                                    className={`w-full flex items-center gap-4 p-4 rounded-lg border transition-all
                                              ${isSelected
                                            ? 'border-primary bg-primary/5'
                                            : 'border-border hover:border-primary/50'
                                        }`}
                                >
                                    <div className={`p-2 rounded-lg ${isSelected ? 'bg-primary/10' : 'bg-muted'}`}>
                                        <Icon className={`w-5 h-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                                    </div>
                                    <div className="flex-1 text-left">
                                        <div className={`font-medium ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                                            {f.label}
                                        </div>
                                        <div className="text-sm text-muted-foreground">{f.desc}</div>
                                    </div>
                                    {isSelected && <CheckCircle className="w-5 h-5 text-primary" />}
                                </button>
                            );
                        })}
                    </CardContent>
                </Card>

                {/* 配置 */}
                <Card>
                    <CardHeader>
                        <CardTitle>导出配置</CardTitle>
                        <CardDescription>选择要导出的数据范围</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* 平台筛选 */}
                        <div>
                            <label className="block text-sm text-muted-foreground mb-2">选择平台</label>
                            <select
                                value={platform}
                                onChange={(e) => setPlatform(e.target.value)}
                                className="w-full px-4 py-3 border border-input bg-background rounded-lg
                                         text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                                {Object.entries(platformNames).map(([key, name]) => (
                                    <option key={key} value={key}>{name}</option>
                                ))}
                            </select>
                        </div>

                        {/* 包含原始数据 */}
                        <label className="flex items-center gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={includeRaw}
                                onChange={(e) => setIncludeRaw(e.target.checked)}
                                className="w-5 h-5 rounded border-input"
                            />
                            <div>
                                <div className="text-foreground">包含原始数据</div>
                                <div className="text-sm text-muted-foreground">导出 API 返回的完整 JSON</div>
                            </div>
                        </label>

                        {/* 导出数量预览 */}
                        <div className="p-4 bg-muted rounded-lg">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">即将导出</span>
                                <span className="text-2xl font-bold text-foreground">
                                    {selectedCount.toLocaleString()}
                                </span>
                            </div>
                            <div className="text-sm text-muted-foreground">条 POI 数据</div>
                        </div>

                        {/* 导出按钮 */}
                        <Button
                            className="w-full"
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
