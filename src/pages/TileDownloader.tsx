import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
// HMR trigger: 2026-01-07T21:57:00
import { listen } from '@tauri-apps/api/event';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { useNavigate } from 'react-router-dom';
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
    AlertTriangle,
    Info,
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
    crs_info: string;
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


// 地图类型名称映射
const mapTypeNames: Record<string, string> = {
    street: '街道图',
    satellite: '卫星图',
    hybrid: '混合图',
    terrain: '地形图',
    roadnet: '路网图',
    annotation: '注记图',
};

// 航道图图层名称映射
const chartLayerNames: Record<string, string> = {
    street: '底图 (一张图)',
    satellite: '水域 (手动)',
    terrain: '水深',
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
    const [showConvertDialog, setShowConvertDialog] = useState(false);
    const [showCurrentTasksDialog, setShowCurrentTasksDialog] = useState(false);
    const [loading, setLoading] = useState(false);
    const [savedApiKeys, setSavedApiKeys] = useState<Record<string, { id: number; api_key: string }[]>>({});
    const navigate = useNavigate();

    // 新建任务表单
    const [taskName, setTaskName] = useState('');
    const [platform, setPlatform] = useState('osm');
    const [mapType, setMapType] = useState('street');
    const [bounds, setBounds] = useState<Bounds>({
        north: 0,
        south: 0,
        east: 0,
        west: 0,
    });
    const [zoomLevels, setZoomLevels] = useState<number[]>([10, 11, 12, 13, 14]);
    const [threadCount, setThreadCount] = useState(8);
    const [outputFormat, setOutputFormat] = useState('folder');
    const [apiKey, setApiKey] = useState('');
    const [estimate, setEstimate] = useState<TileEstimate | null>(null);
    const [selectionMode, setSelectionMode] = useState<'draw' | 'region'>('draw');
    const [selectedRegionCode, setSelectedRegionCode] = useState<string | null>(null);
    const [selectedRegionName, setSelectedRegionName] = useState<string | null>(null);
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
            setMapType(selectedPlatform.map_types[0] || 'street');
        }
        // 航道图平台时调整默认缩放级别
        if (platform === 'cjhy') {
            setZoomLevels([4, 5, 6, 7, 8, 9, 10]);
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
        // 页面不可见时暂停轮询
        let interval: ReturnType<typeof setInterval> | null = null;
        const start = () => { if (!interval) interval = setInterval(loadTasks, 2000); };
        const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
        const onVis = () => document.hidden ? stop() : start();
        document.addEventListener('visibilitychange', onVis);
        start();
        return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
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
            invoke<TileEstimate>('calculate_tiles_count', { bounds, zoomLevels, platform }).then(
                setEstimate
            );
        } else {
            setEstimate(null);
        }
    }, [bounds, zoomLevels, platform]);

    // 创建任务
    const handleCreateTask = async () => {
        if (!taskName.trim()) {
            alert('请输入任务名称');
            return;
        }

        // 验证 bounds 有效性
        if (!(bounds.north > bounds.south && bounds.east > bounds.west)) {
            alert('请先选择下载区域（绘制选区或选择行政区域）');
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

            const taskId = await invoke<string>('create_tile_task', {
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
            await loadTasks();

            // 自动启动下载
            try {
                await invoke('start_tile_download', { taskId });
                loadTasks();
            } catch (startErr) {
                console.error('自动启动下载失败:', startErr);
            }
        } catch (e) {
            console.error('创建任务失败:', e);
            alert(`创建任务失败: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    // 重置表单（保留地图平台和类型选择）
    const resetForm = () => {
        setTaskName('');
        setBounds({ north: 0, south: 0, east: 0, west: 0 });
        setZoomLevels(platform === 'cjhy' ? [4, 5, 6, 7, 8, 9, 10] : [10, 11, 12, 13, 14]);
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

    // 正在操作中的任务ID
    const [operatingTaskId, setOperatingTaskId] = useState<string | null>(null);

    // 开始下载
    const handleStart = async (taskId: string) => {
        setOperatingTaskId(taskId);
        try {
            await invoke('start_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            alert(`启动下载失败: ${e}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 暂停下载
    const handlePause = async (taskId: string) => {
        try {
            await invoke('pause_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            alert(`暂停下载失败: ${e}`);
        }
    };

    // 取消下载
    const handleCancel = async (taskId: string) => {
        try {
            await invoke('cancel_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            alert(`取消下载失败: ${e}`);
        }
    };

    // 删除任务
    const handleDelete = async (taskId: string) => {
        if (!confirm('确定删除该下载任务？')) return;
        try {
            await invoke('delete_tile_task', { taskId, deleteFiles: false });
            await loadTasks();
        } catch (e) {
            alert(`删除任务失败: ${e}`);
        }
    };

    // 重试失败瓦片
    const handleRetry = async (taskId: string) => {
        setOperatingTaskId(taskId);
        try {
            const count = await invoke<number>('retry_failed_tiles', { taskId });
            if (count === 0) {
                alert('没有需要重试的失败瓦片');
                return;
            }
            await invoke('start_tile_download', { taskId });
            loadTasks();
        } catch (e) {
            alert(`重试失败: ${e}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 打开文件夹
    const handleOpenFolder = async (outputPath: string) => {
        try {
            const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
            await revealItemInDir(outputPath);
        } catch (e) {
            alert(`打开文件夹失败: ${e}`);
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
    const isCjhy = platform === 'cjhy';

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
                    {(() => {
                        const activeTasks = tasks.filter(t => ['running', 'downloading', 'paused', 'pending'].includes(t.status));
                        return (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowCurrentTasksDialog(true)}
                                className={cn(
                                    "transition-all duration-300 relative overflow-hidden",
                                    activeTasks.length > 0 ? "border-blue-500/40 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700 bg-blue-500/5 shadow-[0_0_10px_rgba(59,130,246,0.15)]" : ""
                                )}
                            >
                                <Download className={cn('h-4 w-4 mr-1.5', activeTasks.length > 0 && 'animate-bounce')} />
                                <span className="font-medium tracking-tight">当前任务</span>
                                {activeTasks.length > 0 && (
                                    <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-blue-500 text-white rounded-full font-bold shadow-sm">
                                        {activeTasks.length}
                                    </span>
                                )}
                            </Button>
                        );
                    })()}
                    <Button variant="outline" size="sm" onClick={() => setShowConvertDialog(true)}>
                        <FileArchive className="h-4 w-4 mr-1.5" />
                        格式转换
                    </Button>
                </div>
            </div>

            {/* 主内容区 */}
            <div className="flex-1 flex gap-4 min-h-0">
                {/* 左侧面板 - 始终显示创建表单 */}
                <div className="w-80 flex flex-col gap-4 shrink-0 min-h-0">
                    <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
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
                                            <Label>{isCjhy ? '图层类型' : '地图类型'}</Label>
                                            <Select value={mapType} onValueChange={setMapType}>
                                                <SelectTrigger className="h-9">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {availableMapTypes.map((t) => (
                                                        <SelectItem key={t} value={t}>
                                                            {isCjhy ? (chartLayerNames[t] || t) : (mapTypeNames[t] || t)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {/* 坐标系信息 - 全宽显示 */}
                                    {currentPlatform?.crs_info && (
                                        <p className={`text-xs ${currentPlatform.crs_info.includes('3857') ? 'text-muted-foreground' : 'text-red-500 font-medium'}`}>
                                            🌐 坐标系: {currentPlatform.crs_info}
                                        </p>
                                    )}

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
                                            {selectedRegionCode ? (
                                                <div className="flex items-center gap-2 h-9 px-3 bg-primary/5 border border-primary/20 rounded-md">
                                                    <Search className="h-4 w-4 text-primary/50 shrink-0" />
                                                    <span className="text-sm flex-1 truncate">
                                                        {selectedRegionName || selectedRegionCode}
                                                    </span>
                                                    <button
                                                        onClick={() => {
                                                            setSelectedRegionCode(null);
                                                            setSelectedRegionName(null);
                                                            setRegionSearchQuery('');
                                                            setRegionSearchResults([]);
                                                            setBounds({ north: 0, south: 0, east: 0, west: 0 });
                                                        }}
                                                        className="text-muted-foreground hover:text-destructive shrink-0"
                                                    >
                                                        <span className="text-xs">✕</span>
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
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
                                                                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between"
                                                                    onClick={() => {
                                                                        setSelectedRegionCode(region.code);
                                                                        setSelectedRegionName(region.name);
                                                                    }}
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
                                                </>
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
                                        <div className={cn(
                                            "relative overflow-hidden rounded-xl border p-4 transition-all duration-300 animate-in fade-in slide-in-from-bottom-2",
                                            estimate.total_tiles > 10_000_000
                                                ? "border-red-500/30 bg-gradient-to-br from-red-500/10 via-red-500/5 to-transparent shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                                                : estimate.total_tiles > 1_000_000
                                                    ? "border-yellow-500/30 bg-gradient-to-br from-yellow-500/10 via-yellow-500/5 to-transparent shadow-[0_0_15px_rgba(234,179,8,0.1)]"
                                                    : "border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent shadow-sm"
                                        )}>
                                            <div className="flex items-center gap-2 mb-4 relative z-10">
                                                <div className={cn(
                                                    "p-1.5 rounded-md",
                                                    estimate.total_tiles > 10_000_000 ? "bg-red-500/20 text-red-600" :
                                                        estimate.total_tiles > 1_000_000 ? "bg-yellow-500/20 text-yellow-600" :
                                                            "bg-primary/20 text-primary"
                                                )}>
                                                    <Layers className="h-4 w-4" />
                                                </div>
                                                <span className="font-semibold text-sm tracking-tight text-foreground">下载任务预估</span>
                                            </div>

                                            <div className="grid grid-cols-2 gap-4 relative z-10">
                                                <div className="space-y-1">
                                                    <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">瓦片总数</p>
                                                    <div className="flex items-baseline gap-1">
                                                        <span className={cn(
                                                            "text-2xl font-bold tracking-tight",
                                                            estimate.total_tiles > 10_000_000 ? "text-red-500" :
                                                                estimate.total_tiles > 1_000_000 ? "text-yellow-600 dark:text-yellow-500" :
                                                                    "text-foreground"
                                                        )}>
                                                            {estimate.total_tiles > 1_000_000 ? (estimate.total_tiles / 1_000_000).toFixed(1) + 'M' : estimate.total_tiles.toLocaleString()}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground font-medium">张</span>
                                                    </div>
                                                </div>
                                                <div className="space-y-1">
                                                    <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">预估大小</p>
                                                    <div className="flex items-baseline gap-1">
                                                        <span className="text-2xl font-bold tracking-tight text-foreground">
                                                            {parseFloat(formatSize(estimate.estimated_size_mb))}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground font-medium">
                                                            {formatSize(estimate.estimated_size_mb).replace(/[0-9.]/g, '').trim()}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            {estimate.total_tiles > 1_000_000 && (
                                                <div className={cn(
                                                    "relative mt-4 p-2.5 rounded-lg border text-xs leading-relaxed font-medium z-10 flex gap-2 items-start transition-colors",
                                                    estimate.total_tiles > 10_000_000
                                                        ? "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
                                                        : "bg-yellow-500/10 border-yellow-500/20 text-yellow-700 dark:text-yellow-500"
                                                )}>
                                                    {estimate.total_tiles > 10_000_000 ? (
                                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                                    ) : (
                                                        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                                    )}
                                                    <div>
                                                        {estimate.total_tiles > 10_000_000 ? (
                                                            <>极大数量警告：数据量达到 <strong>{(estimate.total_tiles / 1_000_000).toFixed(1)}M</strong>，可能导致耗时过长或内存溢出，强烈建议缩小框选区域或减少层级。{platform === 'cjhy' && '航道图 Level 11+ 分辨率极高，建议大区域仅选择 4-10 级。'}</>
                                                        ) : (
                                                            <>大批量下载提醒：瓦片总数超过 100 万，任务执行可能需要较长时间，请耐心等待。</>
                                                        )}
                                                    </div>
                                                </div>
                                            )}

                                            {/* 装饰性背景光晕 */}
                                            <div className={cn(
                                                "absolute -top-6 -right-6 w-32 h-32 rounded-full blur-3xl opacity-20 pointer-events-none z-0 transition-colors duration-500",
                                                estimate.total_tiles > 10_000_000 ? "bg-red-500" :
                                                    estimate.total_tiles > 1_000_000 ? "bg-yellow-500" :
                                                        "bg-primary"
                                            )} />
                                        </div>
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
                    <div className="flex-1 min-h-0 rounded-lg overflow-hidden border relative z-0 isolate">
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

            {/* 当前任务弹框 */}
            <Dialog open={showCurrentTasksDialog} onOpenChange={setShowCurrentTasksDialog}>
                <DialogContent className="max-w-lg max-h-[70vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Download className="h-5 w-5 text-blue-500" />
                            当前下载任务
                        </DialogTitle>
                        <DialogDescription>
                            {(() => {
                                const active = tasks.filter(t => ['running', 'downloading', 'paused', 'pending'].includes(t.status));
                                return active.length > 0 ? `${active.length} 个任务正在执行/等待中` : '无活跃任务';
                            })()}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex-1 min-h-0 overflow-hidden">
                        {(() => {
                            const activeTasks = tasks.filter(t => ['running', 'downloading', 'paused', 'pending'].includes(t.status));
                            if (activeTasks.length === 0) {
                                return (
                                    <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                                        <Download className="h-10 w-10 mb-3 opacity-20" />
                                        <p>当前没有正在执行的下载任务</p>
                                    </div>
                                );
                            }
                            return (
                                <SimpleBar className="h-full max-h-[45vh]">
                                    <div className="space-y-2 pr-2">
                                        {activeTasks.map(task => {
                                            const progress = task.total_tiles > 0 ? ((task.completed_tiles + task.failed_tiles) / task.total_tiles) * 100 : 0;
                                            const isActive = ['running', 'downloading'].includes(task.status);
                                            const isPaused = task.status === 'paused';
                                            const isPending = task.status === 'pending';
                                            const isOperating = operatingTaskId === task.id;
                                            return (
                                                <div key={task.id} className={cn(
                                                    'p-3.5 rounded-xl border transition-all group overflow-hidden relative',
                                                    isActive ? 'border-blue-500/40 bg-gradient-to-r from-blue-500/10 to-transparent shadow-sm' :
                                                        isPaused ? 'border-yellow-500/30 bg-gradient-to-r from-yellow-500/10 to-transparent' :
                                                            'border-border/60 bg-muted/20 hover:bg-muted/40 hover:border-border',
                                                    isOperating && 'opacity-70 scale-[0.99]'
                                                )}>
                                                    {/* 名称 + 状态 + 进度内容区 */}
                                                    <div className="flex items-center gap-3 relative z-10 w-full">
                                                        <div className={cn(
                                                            "p-2 rounded-lg shrink-0",
                                                            isActive ? "bg-blue-500/20 text-blue-600" :
                                                                isPaused ? "bg-yellow-500/20 text-yellow-600" :
                                                                    "bg-muted-foreground/10 text-muted-foreground"
                                                        )}>
                                                            <Layers className="h-4 w-4" />
                                                        </div>
                                                        <div className="flex flex-col flex-1 min-w-0 pr-8">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-semibold text-sm truncate">{task.name}</span>
                                                                <span className={cn('text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-bold shrink-0',
                                                                    isActive ? 'text-blue-600 bg-blue-500/20' :
                                                                        isPaused ? 'text-yellow-600 bg-yellow-500/20' :
                                                                            'text-muted-foreground bg-muted-foreground/10'
                                                                )}>
                                                                    {statusInfo[task.status]?.name || task.status}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-2 mt-1.5 w-full">
                                                                <Progress value={progress} className="flex-1 h-1.5 bg-black/5 dark:bg-white/10" />
                                                            </div>
                                                            <div className="flex items-center justify-between mt-1 text-[11px] font-medium text-muted-foreground">
                                                                <span className="truncate pr-2">
                                                                    <span className="text-foreground">{task.completed_tiles.toLocaleString()}</span>
                                                                    {task.failed_tiles > 0 && <span className="text-red-500 ml-1">✗{task.failed_tiles.toLocaleString()}</span>}
                                                                    <span className="opacity-40 mx-1">/</span>
                                                                    <span>{task.total_tiles.toLocaleString()}</span>
                                                                </span>
                                                                {isActive && task.download_speed > 0 && (
                                                                    <span className="text-blue-500 tracking-tight tabular-nums flex items-center gap-1 shrink-0">
                                                                        <Download className="h-3 w-3" />
                                                                        {formatSpeed(task.download_speed)}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* 操作按钮 (悬浮显示或正在操作时显示加载) */}
                                                        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-gradient-to-l from-background/90 via-background/80 to-transparent pl-4 pr-1 py-1 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity">
                                                            {isOperating && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground mr-1 shrink-0" />}
                                                            {(isPending || isPaused) && (
                                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-green-500 hover:bg-green-500/10 hover:text-green-600 transition-colors shrink-0 backdrop-blur-sm"
                                                                    onClick={() => handleStart(task.id)} disabled={isOperating}>
                                                                    <Play className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                            {isActive && (
                                                                <>
                                                                    <Button size="icon" variant="ghost" className="h-8 w-8 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-600 transition-colors shrink-0 backdrop-blur-sm"
                                                                        onClick={() => handlePause(task.id)}>
                                                                        <Pause className="h-4 w-4" />
                                                                    </Button>
                                                                    <Button size="icon" variant="ghost" className="h-8 w-8 text-orange-500 hover:bg-orange-500/10 hover:text-orange-600 transition-colors shrink-0 backdrop-blur-sm"
                                                                        onClick={() => handleCancel(task.id)}>
                                                                        <Square className="h-4 w-4" />
                                                                    </Button>
                                                                </>
                                                            )}
                                                            {task.failed_tiles > 0 && !isActive && (
                                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 transition-colors shrink-0 backdrop-blur-sm"
                                                                    onClick={() => handleRetry(task.id)} disabled={isOperating}>
                                                                    <RefreshCw className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                            {task.output_path && (
                                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0 backdrop-blur-sm"
                                                                    onClick={() => handleOpenFolder(task.output_path)}>
                                                                    <FolderOpen className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                            {!isActive && (
                                                                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:bg-red-500/10 hover:text-red-600 transition-colors shrink-0 backdrop-blur-sm"
                                                                    onClick={() => handleDelete(task.id)}>
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </SimpleBar>
                            );
                        })()}
                    </div>

                    <DialogFooter className="flex items-center justify-between">
                        <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => { setShowCurrentTasksDialog(false); navigate('/task-history'); }}>
                            查看全部任务历史 →
                        </Button>
                        <Button variant="outline" onClick={() => setShowCurrentTasksDialog(false)}>
                            关闭
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
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
    const [loading, setLoading] = useState(false);

    // 根据输入文件自动检测格式
    const inputFormat = inputPath.toLowerCase().endsWith('.mbtiles')
        ? 'mbtiles'
        : inputPath.toLowerCase().endsWith('.zip')
            ? 'zip'
            : null;

    // 输出格式：反向转换
    const outputFormat = inputFormat === 'mbtiles' ? 'zip' : inputFormat === 'zip' ? 'mbtiles' : null;

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
        if (!inputPath || !outputFormat) {
            alert('请选择有效的输入文件');
            return;
        }

        setLoading(true);
        try {
            const ext = outputFormat;
            const outputPath = await save({
                title: '选择输出位置',
                defaultPath: `output.${ext}`,
                filters: [{ name: '输出文件', extensions: [ext] }],
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
                    <DialogTitle>转换瓦片文件</DialogTitle>
                    <DialogDescription>支持 ZIP 和 MBTiles 格式互转</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 mt-4">
                    <div className="space-y-2">
                        <Label>输入文件</Label>
                        <div className="flex gap-2">
                            <Input
                                value={inputPath}
                                onChange={(e) => setInputPath(e.target.value)}
                                placeholder="选择 ZIP 或 MBTiles 文件"
                                className="flex-1"
                            />
                            <Button variant="outline" onClick={handleBrowseFile}>
                                <FolderOpen className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {inputPath && (
                        <div className="p-3 bg-muted rounded-lg text-sm">
                            {inputFormat ? (
                                <div className="flex items-center gap-2">
                                    <span className="text-muted-foreground">转换方向：</span>
                                    <span className="font-medium">{inputFormat.toUpperCase()}</span>
                                    <span className="text-muted-foreground">→</span>
                                    <span className="font-medium">{outputFormat?.toUpperCase()}</span>
                                </div>
                            ) : (
                                <span className="text-destructive">请选择 .zip 或 .mbtiles 文件</span>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        取消
                    </Button>
                    <Button onClick={handleConvert} disabled={loading || !inputFormat}>
                        {loading ? '转换中...' : '开始转换'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
