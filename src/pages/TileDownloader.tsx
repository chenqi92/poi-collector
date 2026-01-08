import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
// HMR trigger: 2026-01-07T21:57:00
import { listen } from '@tauri-apps/api/event';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import {
    Play,
    Pause,
    Square,
    Trash2,
    FolderOpen,
    RefreshCw,
    Layers,
    HardDrive,
    FileArchive,
    Search,
    Download,
    History,
} from 'lucide-react';
import { TileBoundsMap } from '@/components/TileBoundsMap';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import SimpleBar from 'simplebar-react';

// 类型定义
interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface TaskInfo {
    id: string;
    name: string;
    platform: string;
    map_type: string;
    bounds: Bounds;
    zoom_levels: number[];
    status: string;
    total_tiles: number;
    completed_tiles: number;
    failed_tiles: number;
    output_path: string;
    output_format: string;
    thread_count: number;
    retry_count: number;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    error_message: string | null;
    download_speed: number;
}

interface PlatformInfo {
    id: string;
    name: string;
    enabled: boolean;
    min_zoom: number;
    max_zoom: number;
    map_types: string[];
    requires_key: boolean;
}

interface TileEstimate {
    total_tiles: number;
    tiles_per_level: [number, number][];
    estimated_size_mb: number;
}

interface ProgressEvent {
    task_id: string;
    completed: number;
    failed: number;
    total: number;
    speed: number;
    current_zoom: number;
    status: string;
    message: string | null;
}

// 平台名称映射
const platformNames: Record<string, string> = {
    google: '谷歌地图',
    baidu: '百度地图',
    amap: '高德地图',
    tencent: '腾讯地图',
    tianditu: '天地图',
    osm: 'OpenStreetMap',
    arcgis: 'ArcGIS',
    bing: 'Bing地图',
};

// 地图类型名称映射
const mapTypeNames: Record<string, string> = {
    street: '街道图',
    satellite: '卫星图',
    hybrid: '混合图',
    terrain: '地形图',
    roadnet: '路网图',
    annotation: '注记图',
};

// 状态名称和颜色
const statusInfo: Record<string, { name: string; color: string }> = {
    pending: { name: '等待中', color: 'text-muted-foreground' },
    downloading: { name: '下载中', color: 'text-blue-500' },
    paused: { name: '已暂停', color: 'text-yellow-500' },
    completed: { name: '已完成', color: 'text-green-500' },
    failed: { name: '失败', color: 'text-red-500' },
    cancelled: { name: '已取消', color: 'text-muted-foreground' },
};

export default function TileDownloader() {
    const [tasks, setTasks] = useState<TaskInfo[]>([]);
    const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
    const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);
    const [showConvertDialog, setShowConvertDialog] = useState(false);
    const [loading, setLoading] = useState(false);
    const [savedApiKeys, setSavedApiKeys] = useState<Record<string, { id: number; api_key: string }[]>>({});
    const [showTasksDialog, setShowTasksDialog] = useState(false);

    // 新建任务表单
    const [taskName, setTaskName] = useState('');
    const [platform, setPlatform] = useState('osm');
    const [mapType, setMapType] = useState('street');
    const [bounds, setBounds] = useState<Bounds>({
        north: 31.5,
        south: 30.7,
        east: 122.0,
        west: 121.0,
    });
    const [zoomLevels, setZoomLevels] = useState<number[]>([10, 11, 12, 13, 14]);
    const [threadCount, setThreadCount] = useState(8);
    const [outputFormat, setOutputFormat] = useState('folder');
    const [apiKey, setApiKey] = useState('');
    const [estimate, setEstimate] = useState<TileEstimate | null>(null);
    const [selectionMode, setSelectionMode] = useState<'draw' | 'region'>('draw');
    const [selectedRegionCode, setSelectedRegionCode] = useState<string | null>(null);
    const [regionSearchQuery, setRegionSearchQuery] = useState('');
    const [regionSearchResults, setRegionSearchResults] = useState<{ code: string; name: string; level: string }[]>([]);

    // 加载平台列表和已保存的 API Keys
    useEffect(() => {
        const loadData = async () => {
            try {
                const [platformsData, apiKeysData] = await Promise.all([
                    invoke<PlatformInfo[]>('get_tile_platforms'),
                    invoke<Record<string, { id: number; api_key: string }[]>>('get_api_keys'),
                ]);
                setPlatforms(platformsData);
                setSavedApiKeys(apiKeysData);
            } catch (e) {
                console.error('加载数据失败:', e);
            }
        };
        loadData();
    }, []);

    // 当平台切换时，自动调整地图类型和 API Key
    useEffect(() => {
        if (platforms.length === 0) return;
        const selectedPlatform = platforms.find((p) => p.id === platform);
        if (selectedPlatform && !selectedPlatform.map_types.includes(mapType)) {
            // 当前地图类型不被新平台支持，切换到第一个支持的类型
            setMapType(selectedPlatform.map_types[0] || 'street');
        }
        // 自动加载已保存的 API Key
        if (selectedPlatform?.requires_key) {
            const keys = savedApiKeys[platform] || [];
            if (keys.length > 0 && !apiKey) {
                setApiKey(keys[0].api_key);
            }
        }
    }, [platform, platforms, mapType, savedApiKeys]);

    // 加载任务列表
    const loadTasks = useCallback(async () => {
        try {
            const data = await invoke<TaskInfo[]>('get_tile_tasks');
            setTasks(data);
        } catch (e) {
            console.error('加载任务失败:', e);
        }
    }, []);

    useEffect(() => {
        loadTasks();
        const interval = setInterval(loadTasks, 2000);
        return () => clearInterval(interval);
    }, [loadTasks]);

    // 监听进度事件
    useEffect(() => {
        const unlisten = listen<ProgressEvent>('tile-download-progress', (event) => {
            const progress = event.payload;
            setTasks((prev) =>
                prev.map((task) =>
                    task.id === progress.task_id
                        ? {
                            ...task,
                            completed_tiles: progress.completed,
                            failed_tiles: progress.failed,
                            download_speed: progress.speed,
                            status: progress.status,
                        }
                        : task
                )
            );
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    // 计算瓦片估算
    useEffect(() => {
        if (bounds.north > bounds.south && bounds.east > bounds.west && zoomLevels.length > 0) {
            invoke<TileEstimate>('calculate_tiles_count', { bounds, zoomLevels }).then(
                setEstimate
            );
        }
    }, [bounds, zoomLevels]);

    // 创建任务
    const handleCreateTask = async () => {
        if (!taskName.trim()) {
            alert('请输入任务名称');
            return;
        }

        if (currentPlatform?.requires_key && !apiKey.trim()) {
            alert(`${currentPlatform.name} 需要 API Key`);
            return;
        }

        setLoading(true);
        try {
            // 选择保存路径
            let outputPath: string | null = null;

            if (outputFormat === 'folder') {
                outputPath = await save({
                    title: '选择保存位置',
                    defaultPath: `${taskName}`,
                });
            } else {
                const ext = outputFormat === 'mbtiles' ? 'mbtiles' : 'zip';
                outputPath = await save({
                    title: '选择保存位置',
                    defaultPath: `${taskName}.${ext}`,
                    filters: [{ name: '瓦片文件', extensions: [ext] }],
                });
            }

            if (!outputPath) {
                setLoading(false);
                return;
            }

            await invoke('create_tile_task', {
                config: {
                    name: taskName,
                    platform,
                    map_type: mapType,
                    bounds,
                    zoom_levels: zoomLevels,
                    output_path: outputPath,
                    output_format: outputFormat,
                    thread_count: threadCount,
                    retry_count: 3,
                    api_key: apiKey.trim() || null,
                },
            });

            resetForm();
            loadTasks();
        } catch (e) {
            console.error('创建任务失败:', e);
            alert(`创建任务失败: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    // 重置表单
    const resetForm = () => {
        setTaskName('');
        setPlatform('amap');
        setMapType('street');
        setBounds({ north: 31.5, south: 30.7, east: 122.0, west: 121.0 });
        setZoomLevels([10, 11, 12, 13, 14]);
        setThreadCount(8);
        setOutputFormat('folder');
        setApiKey('');
        setSelectionMode('draw');
        setSelectedRegionCode(null);
        setRegionSearchQuery('');
        setRegionSearchResults([]);
    };

    // 搜索行政区域
    const handleRegionSearch = useCallback(async (query: string) => {
        setRegionSearchQuery(query);
        if (!query.trim()) {
            setRegionSearchResults([]);
            return;
        }
        try {
            const results = await invoke<{ code: string; name: string; level: string }[]>(
                'search_regions',
                { query: query.trim() }
            );
            setRegionSearchResults(results);
        } catch (e) {
            console.error('搜索行政区失败:', e);
        }
    }, []);

    // 开始下载
    const handleStart = async (taskId: string) => {
        try {
            await invoke('start_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            console.error('启动下载失败:', e);
            alert(`启动下载失败: ${e}`);
        }
    };

    // 暂停下载
    const handlePause = async (taskId: string) => {
        try {
            await invoke('pause_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            console.error('暂停下载失败:', e);
        }
    };

    // 取消下载
    const handleCancel = async (taskId: string) => {
        try {
            await invoke('cancel_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            console.error('取消下载失败:', e);
        }
    };

    // 删除任务
    const handleDelete = async (taskId: string, deleteFiles: boolean) => {
        if (!confirm(deleteFiles ? '确定删除任务和文件？' : '确定删除任务？')) {
            return;
        }
        try {
            await invoke('delete_tile_task', { taskId, deleteFiles });
            loadTasks();
            if (selectedTask?.id === taskId) {
                setSelectedTask(null);
            }
        } catch (e) {
            console.error('删除任务失败:', e);
        }
    };

    // 重试失败瓦片
    const handleRetry = async (taskId: string) => {
        try {
            const count = await invoke<number>('retry_failed_tiles', { taskId });
            alert(`已重置 ${count} 个失败瓦片`);
            loadTasks();
        } catch (e) {
            console.error('重试失败:', e);
        }
    };

    // 格式化速度
    const formatSpeed = (speed: number) => {
        if (speed < 1) return `${(speed * 60).toFixed(1)}/分`;
        return `${speed.toFixed(1)}/秒`;
    };

    // 格式化大小
    const formatSize = (mb: number) => {
        if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
        if (mb < 1024) return `${mb.toFixed(1)} MB`;
        return `${(mb / 1024).toFixed(2)} GB`;
    };

    // 获取当前平台支持的地图类型
    const currentPlatform = platforms.find((p) => p.id === platform);
    const availableMapTypes = currentPlatform?.map_types || ['street'];

    // 过滤可用平台：不需要 Key 或已配置 Key 的平台
    const availablePlatforms = platforms.filter((p) => {
        if (!p.requires_key) return true;
        const keys = savedApiKeys[p.id] || [];
        return keys.length > 0;
    });

    return (
        <div className="h-full flex flex-col gap-4">
            {/* 页面标题 */}
            <div className="flex items-center justify-between shrink-0">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">瓦片下载</h1>
                    <p className="text-muted-foreground">下载地图瓦片用于离线使用</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setShowTasksDialog(true)}>
                        <History className="h-4 w-4 mr-2" />
                        历史任务
                        {tasks.length > 0 && (
                            <span className="ml-2 px-1.5 py-0.5 text-xs bg-primary/20 text-primary rounded-full">
                                {tasks.length}
                            </span>
                        )}
                    </Button>
                    <Button variant="outline" onClick={() => setShowConvertDialog(true)}>
                        <FileArchive className="h-4 w-4 mr-2" />
                        格式转换
                    </Button>
                </div>
            </div>

            {/* 主内容区 */}
            <div className="flex-1 flex gap-4 min-h-0">
                {/* 左侧面板 - 始终显示创建表单 */}
                <div className="w-80 flex flex-col gap-4 shrink-0">
                    <Card className="flex-1 flex flex-col">
                        <CardHeader className="pb-3 shrink-0">
                            <CardTitle className="text-base">新建下载任务</CardTitle>
                        </CardHeader>
                        <CardContent className="flex-1 overflow-hidden p-0">
                            <SimpleBar className="h-full px-6 pb-6">
                                <div className="space-y-4">
                                    {/* 任务名称 */}
                                    <div className="space-y-2">
                                        <Label>任务名称</Label>
                                        <Input
                                            value={taskName}
                                            onChange={(e) => setTaskName(e.target.value)}
                                            placeholder="输入任务名称"
                                        />
                                    </div>

                                    {/* 平台和类型 */}
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-2">
                                            <Label>地图平台</Label>
                                            <Select value={platform} onValueChange={setPlatform}>
                                                <SelectTrigger className="h-9">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {availablePlatforms.map((p) => (
                                                        <SelectItem key={p.id} value={p.id}>
                                                            {p.name}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>地图类型</Label>
                                            <Select value={mapType} onValueChange={setMapType}>
                                                <SelectTrigger className="h-9">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {availableMapTypes.map((t) => (
                                                        <SelectItem key={t} value={t}>
                                                            {mapTypeNames[t] || t}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {/* 输出格式 */}
                                    <div className="space-y-2">
                                        <Label>输出格式</Label>
                                        <Select value={outputFormat} onValueChange={setOutputFormat}>
                                            <SelectTrigger className="h-9">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="folder">
                                                    <div className="flex items-center gap-2">
                                                        <FolderOpen className="h-4 w-4" />
                                                        文件夹 (Z/X/Y.png)
                                                    </div>
                                                </SelectItem>
                                                <SelectItem value="mbtiles">
                                                    <div className="flex items-center gap-2">
                                                        <HardDrive className="h-4 w-4" />
                                                        MBTiles (SQLite)
                                                    </div>
                                                </SelectItem>
                                                <SelectItem value="zip">
                                                    <div className="flex items-center gap-2">
                                                        <FileArchive className="h-4 w-4" />
                                                        ZIP 压缩包
                                                    </div>
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* API Key */}
                                    {currentPlatform?.requires_key && (
                                        <div className="space-y-2">
                                            <Label>API Key <span className="text-red-500">*</span></Label>
                                            <Input
                                                value={apiKey}
                                                onChange={(e) => setApiKey(e.target.value)}
                                                placeholder={`输入 ${currentPlatform.name} API Key`}
                                                className="h-9"
                                            />
                                        </div>
                                    )}

                                    {/* 行政区搜索（仅在 region 模式） */}
                                    {selectionMode === 'region' && (
                                        <div className="space-y-2">
                                            <Label>行政区域</Label>
                                            <div className="relative">
                                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                                <Input
                                                    value={regionSearchQuery}
                                                    onChange={(e) => handleRegionSearch(e.target.value)}
                                                    placeholder="搜索行政区域..."
                                                    className="pl-8 h-9"
                                                />
                                            </div>
                                            {regionSearchResults.length > 0 && (
                                                <div className="border rounded-md max-h-32 overflow-y-auto">
                                                    {regionSearchResults.map((region) => (
                                                        <button
                                                            key={region.code}
                                                            className={cn(
                                                                'w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between',
                                                                selectedRegionCode === region.code && 'bg-accent'
                                                            )}
                                                            onClick={() => setSelectedRegionCode(region.code)}
                                                        >
                                                            <span className="truncate">{region.name}</span>
                                                            <span className="text-xs text-muted-foreground">
                                                                {region.level === 'province' ? '省' :
                                                                    region.level === 'city' ? '市' : '区/县'}
                                                            </span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* 线程数 */}
                                    <div className="space-y-2">
                                        <Label>下载线程: {threadCount}</Label>
                                        <Slider
                                            value={[threadCount]}
                                            min={1}
                                            max={32}
                                            step={1}
                                            onValueChange={([value]) => setThreadCount(value)}
                                        />
                                    </div>

                                    {/* 层级选择 */}
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <Label>层级选择</Label>
                                            <div className="flex gap-1">
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 text-xs px-2"
                                                    onClick={() => {
                                                        const minZ = currentPlatform?.min_zoom || 1;
                                                        const maxZ = currentPlatform?.max_zoom || 19;
                                                        setZoomLevels(Array.from({ length: maxZ - minZ + 1 }, (_, i) => minZ + i));
                                                    }}
                                                >
                                                    全选
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 text-xs px-2"
                                                    onClick={() => setZoomLevels([])}
                                                >
                                                    清空
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {Array.from(
                                                { length: (currentPlatform?.max_zoom || 19) - (currentPlatform?.min_zoom || 1) + 1 },
                                                (_, i) => (currentPlatform?.min_zoom || 1) + i
                                            ).map((z) => (
                                                <Button
                                                    key={z}
                                                    size="sm"
                                                    variant={zoomLevels.includes(z) ? 'default' : 'outline'}
                                                    className="w-7 h-7 text-xs p-0"
                                                    onClick={() => {
                                                        if (zoomLevels.includes(z)) {
                                                            setZoomLevels(zoomLevels.filter((l) => l !== z));
                                                        } else {
                                                            setZoomLevels([...zoomLevels, z].sort((a, b) => a - b));
                                                        }
                                                    }}
                                                >
                                                    {z}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* 估算信息 */}
                                    {estimate && (
                                        <Card className="bg-muted/50">
                                            <CardContent className="p-3">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Layers className="h-4 w-4" />
                                                    <span className="font-medium text-sm">预估信息</span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-2 text-sm">
                                                    <div>瓦片: <strong>{estimate.total_tiles.toLocaleString()}</strong></div>
                                                    <div>大小: <strong>{formatSize(estimate.estimated_size_mb)}</strong></div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    )}

                                    {/* 创建按钮 */}
                                    <Button className="w-full" onClick={handleCreateTask} disabled={loading}>
                                        <Download className="h-4 w-4 mr-2" />
                                        {loading ? '创建中...' : '创建并选择保存位置'}
                                    </Button>
                                </div>
                            </SimpleBar>
                        </CardContent>
                    </Card>
                </div>

                {/* 右侧主区域：地图 + 详情 */}
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                    {/* 地图区域 - 占据主要空间 */}
                    <div className="flex-1 min-h-0 rounded-lg overflow-hidden border">
                        <TileBoundsMap
                            platform={platform}
                            mapType={mapType}
                            apiKey={apiKey || undefined}
                            bounds={bounds}
                            onBoundsChange={setBounds}
                            selectedRegionCode={selectedRegionCode}
                            onSelectedRegionCodeChange={setSelectedRegionCode}
                            selectionMode={selectionMode}
                            onSelectionModeChange={setSelectionMode}
                        />
                    </div>
                </div>
            </div>

            {/* 转换对话框 */}
            <ConvertDialog open={showConvertDialog} onOpenChange={setShowConvertDialog} />

            {/* 历史任务对话框 */}
            <TasksDialog
                open={showTasksDialog}
                onOpenChange={setShowTasksDialog}
                tasks={tasks}
                selectedTask={selectedTask}
                onSelectTask={setSelectedTask}
                onStart={handleStart}
                onPause={handlePause}
                onCancel={handleCancel}
                onRetry={handleRetry}
                onDelete={handleDelete}
                formatSpeed={formatSpeed}
            />
        </div>
    );
}

// 转换对话框组件
function ConvertDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [inputPath, setInputPath] = useState('');
    const [outputFormat, setOutputFormat] = useState('folder');
    const [loading, setLoading] = useState(false);

    const handleBrowseFile = async () => {
        try {
            const selected = await openDialog({
                title: '选择瓦片文件',
                filters: [
                    { name: '瓦片文件', extensions: ['zip', 'mbtiles'] },
                ],
            });
            if (selected) {
                setInputPath(selected as string);
            }
        } catch (e) {
            console.error('选择文件失败:', e);
        }
    };

    const handleConvert = async () => {
        if (!inputPath) {
            alert('请选择输入文件');
            return;
        }

        setLoading(true);
        try {
            const ext = outputFormat === 'mbtiles' ? 'mbtiles' : outputFormat === 'zip' ? 'zip' : '';
            const outputPath = await save({
                title: '选择输出位置',
                defaultPath: ext ? `output.${ext}` : 'output',
                filters: ext ? [{ name: '输出文件', extensions: [ext] }] : undefined,
            });

            if (!outputPath) {
                setLoading(false);
                return;
            }

            await invoke('convert_tile_file', {
                inputPath,
                outputPath,
                outputFormat,
            });

            alert('转换完成');
            onOpenChange(false);
        } catch (e) {
            console.error('转换失败:', e);
            alert(`转换失败: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="z-[100]">
                <DialogHeader>
                    <DialogTitle>解压/转换瓦片文件</DialogTitle>
                    <DialogDescription>支持 ZIP 和 MBTiles 格式互转</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 mt-4">
                    <div className="space-y-2">
                        <Label>输入文件</Label>
                        <div className="flex gap-2">
                            <Input
                                value={inputPath}
                                onChange={(e) => setInputPath(e.target.value)}
                                placeholder="选择或输入文件路径"
                                className="flex-1"
                            />
                            <Button variant="outline" onClick={handleBrowseFile}>
                                <FolderOpen className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label>输出格式</Label>
                        <Select value={outputFormat} onValueChange={setOutputFormat}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="folder">文件夹</SelectItem>
                                <SelectItem value="mbtiles">MBTiles</SelectItem>
                                <SelectItem value="zip">ZIP</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        取消
                    </Button>
                    <Button onClick={handleConvert} disabled={loading}>
                        {loading ? '转换中...' : '开始转换'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// 历史任务弹框组件
function TasksDialog({
    open,
    onOpenChange,
    tasks,
    selectedTask,
    onSelectTask,
    onStart,
    onPause,
    onCancel,
    onRetry,
    onDelete,
    formatSpeed,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tasks: TaskInfo[];
    selectedTask: TaskInfo | null;
    onSelectTask: (task: TaskInfo | null) => void;
    onStart: (taskId: string) => void;
    onPause: (taskId: string) => void;
    onCancel: (taskId: string) => void;
    onRetry: (taskId: string) => void;
    onDelete: (taskId: string, deleteFiles: boolean) => void;
    formatSpeed: (speed: number) => string;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col z-[100]">
                <DialogHeader>
                    <DialogTitle>历史下载任务</DialogTitle>
                    <DialogDescription>
                        共 {tasks.length} 个任务
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 min-h-0 overflow-hidden">
                    {tasks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                            <History className="h-12 w-12 mb-4 opacity-30" />
                            <p>暂无下载任务</p>
                            <p className="text-sm mt-1">在左侧创建新的下载任务</p>
                        </div>
                    ) : (
                        <SimpleBar className="h-full max-h-[50vh]">
                            <div className="space-y-2 pr-2">
                                {tasks.map((task) => (
                                    <Card
                                        key={task.id}
                                        className={cn(
                                            'cursor-pointer transition-all hover:shadow-md',
                                            selectedTask?.id === task.id && 'ring-2 ring-primary'
                                        )}
                                        onClick={() => onSelectTask(task)}
                                    >
                                        <CardContent className="p-3">
                                            <div className="flex items-start justify-between mb-2">
                                                <div className="flex-1 min-w-0">
                                                    <h3 className="font-medium truncate">{task.name}</h3>
                                                    <p className="text-xs text-muted-foreground">
                                                        {platformNames[task.platform] || task.platform} ·{' '}
                                                        {mapTypeNames[task.map_type] || task.map_type}
                                                    </p>
                                                </div>
                                                <span
                                                    className={cn(
                                                        'text-xs font-medium shrink-0 ml-2',
                                                        statusInfo[task.status]?.color
                                                    )}
                                                >
                                                    {statusInfo[task.status]?.name || task.status}
                                                </span>
                                            </div>

                                            <Progress
                                                value={
                                                    task.total_tiles > 0
                                                        ? ((task.completed_tiles + task.failed_tiles) /
                                                            task.total_tiles) *
                                                        100
                                                        : 0
                                                }
                                                className="h-1.5 mb-2"
                                            />

                                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                                <span>
                                                    {task.completed_tiles}/{task.total_tiles}
                                                    {task.failed_tiles > 0 && (
                                                        <span className="text-red-500 ml-1">
                                                            ({task.failed_tiles} 失败)
                                                        </span>
                                                    )}
                                                </span>
                                                {task.status === 'downloading' && (
                                                    <span>{formatSpeed(task.download_speed)}</span>
                                                )}
                                            </div>

                                            <div className="flex gap-1 mt-2">
                                                {(task.status === 'pending' || task.status === 'paused') && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 px-2"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onStart(task.id);
                                                        }}
                                                    >
                                                        <Play className="h-3 w-3" />
                                                    </Button>
                                                )}
                                                {task.status === 'downloading' && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 px-2"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onPause(task.id);
                                                        }}
                                                    >
                                                        <Pause className="h-3 w-3" />
                                                    </Button>
                                                )}
                                                {(task.status === 'downloading' || task.status === 'paused') && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 px-2"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onCancel(task.id);
                                                        }}
                                                    >
                                                        <Square className="h-3 w-3" />
                                                    </Button>
                                                )}
                                                {task.failed_tiles > 0 && task.status !== 'downloading' && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 px-2"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onRetry(task.id);
                                                        }}
                                                    >
                                                        <RefreshCw className="h-3 w-3" />
                                                    </Button>
                                                )}
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 px-2 text-destructive"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDelete(task.id, false);
                                                    }}
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        </SimpleBar>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        关闭
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
