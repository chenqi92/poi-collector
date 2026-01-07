import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import {
    Plus,
    Play,
    Pause,
    Square,
    Trash2,
    FolderOpen,
    RefreshCw,
    MapPin,
    Layers,
    HardDrive,
    FileArchive,
    Search,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

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
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showConvertDialog, setShowConvertDialog] = useState(false);
    const [loading, setLoading] = useState(false);

    // 新建任务表单
    const [taskName, setTaskName] = useState('');
    const [platform, setPlatform] = useState('amap');
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

    // 加载平台列表
    useEffect(() => {
        invoke<PlatformInfo[]>('get_tile_platforms').then(setPlatforms);
    }, []);

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

            setShowCreateDialog(false);
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

    // 调整线程数
    const handleThreadChange = async (taskId: string, count: number) => {
        try {
            await invoke('set_tile_thread_count', { taskId, count });
        } catch (e) {
            console.error('调整线程数失败:', e);
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

    return (
        <div className="h-full flex gap-4">
            {/* 左侧任务列表 */}
            <div className="w-80 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">下载任务</h2>
                    <div className="flex gap-1">
                        <Button size="sm" onClick={() => setShowCreateDialog(true)}>
                            <Plus className="h-4 w-4 mr-1" />
                            新建
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setShowConvertDialog(true)}>
                            <FileArchive className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                    {tasks.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            暂无下载任务
                        </div>
                    ) : (
                        tasks.map((task) => (
                            <Card
                                key={task.id}
                                className={cn(
                                    'cursor-pointer transition-colors',
                                    selectedTask?.id === task.id && 'ring-2 ring-primary'
                                )}
                                onClick={() => setSelectedTask(task)}
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
                                                'text-xs font-medium',
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
                                                    handleStart(task.id);
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
                                                    handlePause(task.id);
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
                                                    handleCancel(task.id);
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
                                                    handleRetry(task.id);
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
                                                handleDelete(task.id, false);
                                            }}
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))
                    )}
                </div>
            </div>

            {/* 右侧详情 */}
            <div className="flex-1 flex flex-col gap-4">
                {selectedTask ? (
                    <>
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="flex items-center justify-between">
                                    <span>{selectedTask.name}</span>
                                    <span
                                        className={cn(
                                            'text-sm font-medium',
                                            statusInfo[selectedTask.status]?.color
                                        )}
                                    >
                                        {statusInfo[selectedTask.status]?.name}
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <span className="text-muted-foreground">平台：</span>
                                        {platformNames[selectedTask.platform] || selectedTask.platform}
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground">类型：</span>
                                        {mapTypeNames[selectedTask.map_type] || selectedTask.map_type}
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground">层级：</span>
                                        {selectedTask.zoom_levels.join(', ')}
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground">格式：</span>
                                        {selectedTask.output_format}
                                    </div>
                                    <div className="col-span-2">
                                        <span className="text-muted-foreground">区域：</span>
                                        {selectedTask.bounds.south.toFixed(4)}° ~ {selectedTask.bounds.north.toFixed(4)}°N,{' '}
                                        {selectedTask.bounds.west.toFixed(4)}° ~ {selectedTask.bounds.east.toFixed(4)}°E
                                    </div>
                                    <div className="col-span-2">
                                        <span className="text-muted-foreground">保存路径：</span>
                                        <span className="break-all">{selectedTask.output_path}</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="flex-1">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-base">下载进度</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-4">
                                    <div>
                                        <div className="flex justify-between text-sm mb-1">
                                            <span>
                                                已完成: {selectedTask.completed_tiles} / {selectedTask.total_tiles}
                                            </span>
                                            <span>
                                                {selectedTask.total_tiles > 0
                                                    ? (
                                                        (selectedTask.completed_tiles / selectedTask.total_tiles) *
                                                        100
                                                    ).toFixed(1)
                                                    : 0}
                                                %
                                            </span>
                                        </div>
                                        <Progress
                                            value={
                                                selectedTask.total_tiles > 0
                                                    ? (selectedTask.completed_tiles / selectedTask.total_tiles) * 100
                                                    : 0
                                            }
                                            className="h-2"
                                        />
                                    </div>

                                    {selectedTask.failed_tiles > 0 && (
                                        <div className="text-sm text-red-500">
                                            失败: {selectedTask.failed_tiles} 个瓦片
                                        </div>
                                    )}

                                    {selectedTask.status === 'downloading' && (
                                        <div className="space-y-2">
                                            <div className="text-sm">
                                                下载速度: {formatSpeed(selectedTask.download_speed)}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm">线程数:</span>
                                                <Slider
                                                    value={[selectedTask.thread_count]}
                                                    min={1}
                                                    max={32}
                                                    step={1}
                                                    className="flex-1"
                                                    onValueChange={([value]) =>
                                                        handleThreadChange(selectedTask.id, value)
                                                    }
                                                />
                                                <span className="text-sm w-8">{selectedTask.thread_count}</span>
                                            </div>
                                        </div>
                                    )}

                                    {selectedTask.error_message && (
                                        <div className="text-sm text-red-500">
                                            错误: {selectedTask.error_message}
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <div className="text-center">
                            <MapPin className="h-12 w-12 mx-auto mb-4 opacity-50" />
                            <p>选择一个任务查看详情</p>
                            <p className="text-sm mt-2">或点击"新建"创建下载任务</p>
                        </div>
                    </div>
                )}
            </div>

            {/* 新建任务对话框 */}
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>新建下载任务</DialogTitle>
                        <DialogDescription>配置瓦片下载参数</DialogDescription>
                    </DialogHeader>

                    <Tabs defaultValue="basic" className="mt-4">
                        <TabsList className="grid w-full grid-cols-3">
                            <TabsTrigger value="basic">基本设置</TabsTrigger>
                            <TabsTrigger value="region">区域选择</TabsTrigger>
                            <TabsTrigger value="advanced">高级设置</TabsTrigger>
                        </TabsList>

                        <TabsContent value="basic" className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <Label>任务名称</Label>
                                <Input
                                    value={taskName}
                                    onChange={(e) => setTaskName(e.target.value)}
                                    placeholder="输入任务名称"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>地图平台</Label>
                                    <Select value={platform} onValueChange={setPlatform}>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {platforms.map((p) => (
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
                                        <SelectTrigger>
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

                            <div className="space-y-2">
                                <Label>输出格式</Label>
                                <Select value={outputFormat} onValueChange={setOutputFormat}>
                                    <SelectTrigger>
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

                            {currentPlatform?.requires_key && (
                                <div className="space-y-2">
                                    <Label>API Key <span className="text-red-500">*</span></Label>
                                    <Input
                                        value={apiKey}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        placeholder={`输入 ${currentPlatform.name} API Key`}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        此平台需要 API Key 才能下载瓦片
                                    </p>
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="region" className="space-y-4 mt-4">
                            {/* 地图和区域选择 */}
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                {/* 地图区域 */}
                                <div className="lg:col-span-2 h-[350px]">
                                    <TileBoundsMap
                                        platform={platform}
                                        mapType={mapType}
                                        apiKey={apiKey || undefined}
                                        bounds={bounds}
                                        onBoundsChange={setBounds}
                                        selectedRegionCode={selectedRegionCode}
                                        selectionMode={selectionMode}
                                        onSelectionModeChange={setSelectionMode}
                                    />
                                </div>

                                {/* 行政区域搜索（仅在行政区模式下显示） */}
                                {selectionMode === 'region' && (
                                    <div className="h-[350px] border rounded-lg overflow-hidden flex flex-col">
                                        <div className="p-2 border-b">
                                            <div className="relative">
                                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                                <Input
                                                    value={regionSearchQuery}
                                                    onChange={(e) => handleRegionSearch(e.target.value)}
                                                    placeholder="搜索行政区域..."
                                                    className="pl-8 h-8"
                                                />
                                            </div>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-2">
                                            {regionSearchResults.length > 0 ? (
                                                <div className="space-y-1">
                                                    {regionSearchResults.map((region) => (
                                                        <Button
                                                            key={region.code}
                                                            variant={selectedRegionCode === region.code ? 'default' : 'ghost'}
                                                            size="sm"
                                                            className="w-full justify-start h-auto py-2"
                                                            onClick={() => setSelectedRegionCode(region.code)}
                                                        >
                                                            <MapPin className="h-3 w-3 mr-2 flex-shrink-0" />
                                                            <span className="truncate">{region.name}</span>
                                                            <span className="ml-auto text-xs text-muted-foreground">
                                                                {region.level === 'province' ? '省' :
                                                                 region.level === 'city' ? '市' : '区/县'}
                                                            </span>
                                                        </Button>
                                                    ))}
                                                </div>
                                            ) : regionSearchQuery ? (
                                                <div className="text-center text-muted-foreground py-8 text-sm">
                                                    未找到匹配的行政区域
                                                </div>
                                            ) : (
                                                <div className="text-center text-muted-foreground py-8 text-sm">
                                                    输入名称搜索行政区域
                                                    <br />
                                                    如：阜宁、盐城、江苏
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* 层级选择 */}
                            <div className="space-y-2">
                                <Label>层级选择 (当前: {zoomLevels.join(', ')})</Label>
                                <div className="flex flex-wrap gap-1">
                                    {Array.from({ length: 19 }, (_, i) => i + 1).map((z) => (
                                        <Button
                                            key={z}
                                            size="sm"
                                            variant={zoomLevels.includes(z) ? 'default' : 'outline'}
                                            className="w-9 h-9"
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
                                    <CardContent className="p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Layers className="h-4 w-4" />
                                            <span className="font-medium">预估信息</span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-sm">
                                            <div>
                                                瓦片总数: <strong>{estimate.total_tiles.toLocaleString()}</strong>
                                            </div>
                                            <div>
                                                预估大小: <strong>{formatSize(estimate.estimated_size_mb)}</strong>
                                            </div>
                                        </div>
                                        <div className="mt-2 text-xs text-muted-foreground">
                                            {estimate.tiles_per_level.map(([z, count]) => (
                                                <span key={z} className="mr-2">
                                                    L{z}: {count.toLocaleString()}
                                                </span>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </TabsContent>

                        <TabsContent value="advanced" className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <Label>下载线程数: {threadCount}</Label>
                                <Slider
                                    value={[threadCount]}
                                    min={1}
                                    max={32}
                                    step={1}
                                    onValueChange={([value]) => setThreadCount(value)}
                                />
                            </div>

                            <div className="text-sm text-muted-foreground">
                                <p>更多线程可以加快下载速度，但可能会触发服务器限流。</p>
                                <p>建议值：8-16</p>
                            </div>
                        </TabsContent>
                    </Tabs>

                    <DialogFooter className="mt-4">
                        <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                            取消
                        </Button>
                        <Button onClick={handleCreateTask} disabled={loading}>
                            {loading ? '创建中...' : '创建任务'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 转换对话框 */}
            <ConvertDialog open={showConvertDialog} onOpenChange={setShowConvertDialog} />
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
            <DialogContent>
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
