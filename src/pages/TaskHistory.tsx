import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Play,
    Pause,
    Square,
    Trash2,
    FolderOpen,
    RefreshCw,
    MapPin,
    Navigation,
    Map,
    Clock,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    Loader2,
    FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import SimpleBar from 'simplebar-react';

// 统一任务类型
type UnifiedTask = {
    id: string;
    task_type: 'poi' | 'buoy' | 'feature' | 'tile';
    name: string;
    status: string;
    total: number;
    completed: number;
    failed: number;
    platform: string | null;
    output_path: string | null;
    created_at: string | null;
    completed_at: string | null;
    extra: string | null;
};

type TabType = 'all' | 'poi' | 'buoy' | 'feature' | 'tile';

const TAB_CONFIG: { key: TabType; label: string; icon: typeof MapPin }[] = [
    { key: 'all', label: '全部', icon: Clock },
    { key: 'poi', label: 'POI采集', icon: MapPin },
    { key: 'buoy', label: '航标采集', icon: Navigation },
    { key: 'feature', label: '航道要素', icon: Navigation },
    { key: 'tile', label: '瓦片下载', icon: Map },
];

const STATUS_MAP: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
    running: { label: '进行中', color: 'text-blue-500 bg-blue-500/10', icon: Loader2 },
    downloading: { label: '下载中', color: 'text-blue-500 bg-blue-500/10', icon: Loader2 },
    paused: { label: '已暂停', color: 'text-yellow-500 bg-yellow-500/10', icon: Pause },
    completed: { label: '已完成', color: 'text-green-500 bg-green-500/10', icon: CheckCircle2 },
    failed: { label: '失败', color: 'text-red-500 bg-red-500/10', icon: XCircle },
    error: { label: '出错', color: 'text-red-500 bg-red-500/10', icon: AlertTriangle },
    cancelled: { label: '已取消', color: 'text-muted-foreground bg-muted', icon: Square },
    interrupted: { label: '已中断', color: 'text-orange-500 bg-orange-500/10', icon: AlertTriangle },
    pending: { label: '等待中', color: 'text-muted-foreground bg-muted', icon: Clock },
    idle: { label: '空闲', color: 'text-muted-foreground bg-muted', icon: Clock },
};

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
    poi: { label: 'POI', color: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
    buoy: { label: '航标', color: 'text-cyan-600 bg-cyan-500/10 border-cyan-500/20' },
    feature: { label: '要素', color: 'text-sky-600 bg-sky-500/10 border-sky-500/20' },
    tile: { label: '瓦片', color: 'text-violet-600 bg-violet-500/10 border-violet-500/20' },
};

export default function TaskHistory() {
    const [tasks, setTasks] = useState<UnifiedTask[]>([]);
    const [activeTab, setActiveTab] = useState<TabType>('all');
    const [loading, setLoading] = useState(true);
    const [operatingTaskId, setOperatingTaskId] = useState<string | null>(null);
    const [logTaskId, setLogTaskId] = useState<string | null>(null);
    const [logData, setLogData] = useState<any>(null);
    const [logLoading, setLogLoading] = useState(false);

    // 防止并发查询的锁
    const isLoadingRef = useRef(false);

    // 加载任务
    const loadTasks = useCallback(async () => {
        // 防止并发查询
        if (isLoadingRef.current) return;
        isLoadingRef.current = true;
        try {
            const result = await invoke<UnifiedTask[]>('get_all_task_history');
            setTasks(result);
        } catch (e) {
            console.error('加载任务历史失败:', e);
        } finally {
            setLoading(false);
            isLoadingRef.current = false;
        }
    }, []);

    // 缓冲进度更新，避免每次事件都 remap 整个 tasks 数组
    type ProgressUpdate = { completed: number; failed: number; status: string };
    const pendingUpdatesRef = useRef<Record<string, ProgressUpdate>>({});
    const flushTimerRef = useRef<number | null>(null);

    const flushProgressUpdates = useCallback(() => {
        flushTimerRef.current = null;
        const updates = pendingUpdatesRef.current;
        const keys = Object.keys(updates);
        if (keys.length === 0) return;
        pendingUpdatesRef.current = {};
        setTasks(prev => prev.map(t => {
            const u = updates[t.id];
            return u ? { ...t, completed: u.completed, failed: u.failed, status: u.status } : t;
        }));
    }, []);

    useEffect(() => {
        loadTasks();

        // loading 超时保护
        const loadingTimeout = setTimeout(() => setLoading(false), 5000);

        // 监听进度事件 —— 通过 ref 缓冲 + rAF 批量刷新
        const unlisten = listen<{ task_id: string; completed: number; failed: number; speed: number; status: string }>('tile-download-progress', (event) => {
            const p = event.payload;
            pendingUpdatesRef.current[`tile_${p.task_id}`] = { completed: p.completed, failed: p.failed, status: p.status };
            if (flushTimerRef.current === null) {
                flushTimerRef.current = requestAnimationFrame(flushProgressUpdates);
            }
        });

        // 定时全量刷新 —— 页面不可见时暂停
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => { if (!timer) timer = setInterval(loadTasks, 10000); };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        const onVis = () => document.hidden ? stop() : start();
        document.addEventListener('visibilitychange', onVis);
        start();

        return () => {
            unlisten.then(f => f());
            stop();
            document.removeEventListener('visibilitychange', onVis);
            clearTimeout(loadingTimeout);
            if (flushTimerRef.current !== null) cancelAnimationFrame(flushTimerRef.current);
        };
    }, [loadTasks, flushProgressUpdates]);

    // 过滤任务
    const filteredTasks = activeTab === 'all'
        ? tasks
        : tasks.filter(t => t.task_type === activeTab);

    // 统计
    const stats = {
        total: tasks.length,
        active: tasks.filter(t => ['running', 'downloading', 'paused'].includes(t.status)).length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => ['failed', 'error'].includes(t.status)).length,
    };

    // 按状态分组
    const activeGroup = filteredTasks.filter(t => ['running', 'downloading', 'paused', 'pending'].includes(t.status));
    const completedGroup = filteredTasks.filter(t => t.status === 'completed');
    const otherGroup = filteredTasks.filter(t => ['failed', 'error', 'cancelled', 'interrupted', 'idle'].includes(t.status));

    // ---- 操作函数 ----

    // 瓦片任务：开始
    const handleTileStart = async (taskId: string) => {
        const realId = taskId.replace('tile_', '');
        setOperatingTaskId(taskId);
        try {
            await invoke('start_tile_download', { taskId: realId });
            loadTasks();
        } catch (e) {
            alert(`启动下载失败: ${e}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 瓦片任务：暂停
    const handleTilePause = async (taskId: string) => {
        const realId = taskId.replace('tile_', '');
        try {
            await invoke('pause_tile_download', { taskId: realId });
            loadTasks();
        } catch (e) {
            alert(`暂停下载失败: ${e}`);
        }
    };

    // 瓦片任务：停止
    const handleTileCancel = async (taskId: string) => {
        const realId = taskId.replace('tile_', '');
        try {
            await invoke('cancel_tile_download', { taskId: realId });
            loadTasks();
        } catch (e) {
            alert(`停止下载失败: ${e}`);
        }
    };

    // 瓦片任务：重试
    const handleTileRetry = async (taskId: string) => {
        const realId = taskId.replace('tile_', '');
        setOperatingTaskId(taskId);
        try {
            const count = await invoke<number>('retry_failed_tiles', { taskId: realId });
            if (count === 0) {
                alert('没有需要重试的失败瓦片');
                return;
            }
            await invoke('start_tile_download', { taskId: realId });
            loadTasks();
        } catch (e) {
            alert(`重试失败: ${e}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 瓦片任务：查看日志
    const handleViewLogs = async (taskId: string) => {
        const realId = taskId.replace('tile_', '');
        setLogTaskId(taskId);
        setLogLoading(true);
        setLogData(null);
        try {
            const data = await invoke<any>('get_tile_task_logs', { taskId: realId });
            setLogData(data);
        } catch (e) {
            setLogData({ stats: { total: 0, completed: 0, failed: 0, pending: 0 }, error_summary: [{ error: String(e), count: 1 }], failed_tiles: [] });
        } finally {
            setLogLoading(false);
        }
    };

    // 瓦片任务：删除
    const handleTileDelete = async (taskId: string, deleteFiles: boolean) => {
        const realId = taskId.replace('tile_', '');
        if (!confirm(deleteFiles ? '确定删除任务和文件？' : '确定删除该下载任务？')) return;
        try {
            await invoke('delete_tile_task', { taskId: realId, deleteFiles });
            loadTasks();
        } catch (e) {
            alert(`删除任务失败: ${e}`);
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

    // 航标任务：继续执行（使用原始 bounds 重新开始采集）
    const handleBuoyResume = async (task: UnifiedTask) => {
        let extra: Record<string, unknown> = {};
        try { if (task.extra) extra = JSON.parse(task.extra); } catch { /* ignore */ }
        const w = extra.bounds_west as number;
        const s = extra.bounds_south as number;
        const e = extra.bounds_east as number;
        const n = extra.bounds_north as number;
        if (!w && !s && !e && !n) {
            alert('该任务没有记录边界范围，无法继续执行');
            return;
        }
        setOperatingTaskId(task.id);
        try {
            await invoke('chart_start_buoy_collection', {
                west: w, south: s, east: e, north: n,
                gridStep: (extra.grid_step as number) || 0.1,
            });
            loadTasks();
        } catch (err) {
            alert(`启动采集失败: ${err}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 航道要素任务：继续执行（使用原始 bounds 重新开始采集）
    const handleFeatureResume = async (task: UnifiedTask) => {
        let extra: Record<string, unknown> = {};
        try { if (task.extra) extra = JSON.parse(task.extra); } catch { /* ignore */ }
        const w = extra.bounds_west as number;
        const s = extra.bounds_south as number;
        const e = extra.bounds_east as number;
        const n = extra.bounds_north as number;
        if (!w && !s && !e && !n) {
            alert('该任务没有记录边界范围，无法继续执行');
            return;
        }
        setOperatingTaskId(task.id);
        try {
            await invoke('chart_start_feature_collection', {
                west: w, south: s, east: e, north: n,
                gridStep: (extra.grid_step as number) || 0.2,
                includeFences: (extra.include_fences as boolean | undefined) ?? true,
                includeHydro: (extra.include_hydro as boolean | undefined) ?? true,
            });
            loadTasks();
        } catch (err) {
            alert(`启动采集失败: ${err}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // POI 任务：继续执行（使用原始 platform/region 重新开始采集）
    const handlePoiResume = async (task: UnifiedTask) => {
        let extra: Record<string, unknown> = {};
        try { if (task.extra) extra = JSON.parse(task.extra); } catch { /* ignore */ }
        const platform = task.platform;
        const regionCode = extra.region_code as string;
        if (!platform || !regionCode) {
            alert('该任务缺少平台或区域信息，无法继续执行');
            return;
        }
        setOperatingTaskId(task.id);
        try {
            // categories 传 null 使用全部类别（任务记录的是类别名称不是ID，且 upsert 不会重复插入）
            await invoke('start_collector', {
                platform,
                categories: null,
                regions: [regionCode],
            });
            loadTasks();
        } catch (err) {
            alert(`启动采集失败: ${err}`);
        } finally {
            setOperatingTaskId(null);
        }
    };

    // 查看任务详情（通用 - 非瓦片任务展示基本信息）
    const handleViewTaskDetails = (task: UnifiedTask) => {
        setLogTaskId(task.id);
        setLogLoading(false);
        // 构造通用详情数据
        let extra: Record<string, unknown> = {};
        try { if (task.extra) extra = JSON.parse(task.extra); } catch { /* ignore */ }
        setLogData({ _taskDetail: true, task, extra });
    };

    // 格式化时间 - SQLite CURRENT_TIMESTAMP 存储UTC时间，需转为本地时间显示
    const formatTime = (timeStr: string | null) => {
        if (!timeStr) return '-';
        try {
            // SQLite 格式: "2026-03-11 00:40:30", 视为 UTC
            // 若已带时区偏移则直接解析，否则追加 Z 标记为 UTC
            const isoStr = timeStr.replace(' ', 'T') + (timeStr.includes('+') || timeStr.includes('Z') ? '' : 'Z');
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return timeStr;
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });
        } catch {
            return timeStr;
        }
    };

    // 渲染单个任务
    const renderTask = (task: UnifiedTask) => {
        const statusInfo = STATUS_MAP[task.status] || STATUS_MAP['idle'];
        const typeInfo = TYPE_LABELS[task.task_type] || TYPE_LABELS['poi'];
        const progress = task.total > 0 ? ((task.completed + task.failed) / task.total) * 100 : 0;
        const isOperating = operatingTaskId === task.id;
        const isTile = task.task_type === 'tile';
        const isActive = ['running', 'downloading'].includes(task.status);
        const isPaused = task.status === 'paused';
        const isPending = task.status === 'pending';
        const isInterrupted = task.status === 'interrupted';
        const isFailed = ['failed', 'error'].includes(task.status);
        const hasFailed = task.failed > 0;
        const isBuoy = task.task_type === 'buoy';
        const isFeature = task.task_type === 'feature';
        const isPoi = task.task_type === 'poi';

        // Parse extra
        let extra: Record<string, unknown> = {};
        try {
            if (task.extra) extra = JSON.parse(task.extra);
        } catch { /* ignore */ }

        return (
            <div
                key={task.id}
                className={cn(
                    'group p-4 rounded-xl border transition-all hover:shadow-sm',
                    isActive && 'border-blue-500/30 bg-blue-500/5',
                    isPaused && 'border-yellow-500/20 bg-yellow-500/5',
                    isOperating && 'opacity-70',
                    !isActive && !isPaused && 'border-border/50 hover:bg-accent/30'
                )}
            >
                <div className="flex items-center gap-3">
                    {/* 类型标签 */}
                    <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full border', typeInfo.color)}>
                        {typeInfo.label}
                    </span>

                    {/* 任务名称 */}
                    <span className="font-medium text-sm flex-1 truncate" title={task.name}>
                        {task.name}
                    </span>

                    {/* 状态 */}
                    <span className={cn('text-[11px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1', statusInfo.color)}>
                        {isActive ? (
                            <statusInfo.icon className="h-3 w-3 animate-spin" />
                        ) : (
                            <statusInfo.icon className="h-3 w-3" />
                        )}
                        {statusInfo.label}
                    </span>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-0.5 shrink-0">
                        {isOperating && (
                            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground mr-1" />
                        )}

                        {/* 瓦片专属操作 */}
                        {isTile && (isPending || isPaused) && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-500 hover:text-green-600 hover:bg-green-500/10"
                                onClick={() => handleTileStart(task.id)} title="开始下载" disabled={isOperating}>
                                <Play className="h-3.5 w-3.5" />
                            </Button>
                        )}
                        {isTile && isActive && (
                            <>
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-yellow-500 hover:text-yellow-600 hover:bg-yellow-500/10"
                                    onClick={() => handleTilePause(task.id)} title="暂停">
                                    <Pause className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                    onClick={() => handleTileCancel(task.id)} title="停止">
                                    <Square className="h-3.5 w-3.5" />
                                </Button>
                            </>
                        )}
                        {isTile && hasFailed && !isActive && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-orange-500 hover:text-orange-600 hover:bg-orange-500/10"
                                onClick={() => handleTileRetry(task.id)} title="重试失败" disabled={isOperating}>
                                <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* 航标任务：继续执行 */}
                        {isBuoy && (isInterrupted || isFailed) && !isActive && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-500 hover:text-green-600 hover:bg-green-500/10"
                                onClick={() => handleBuoyResume(task)} title="继续采集" disabled={isOperating}>
                                <Play className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* 航道要素任务：继续执行 */}
                        {isFeature && (isInterrupted || isFailed) && !isActive && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-500 hover:text-green-600 hover:bg-green-500/10"
                                onClick={() => handleFeatureResume(task)} title="继续采集" disabled={isOperating}>
                                <Play className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* POI 任务：继续执行 */}
                        {isPoi && (isInterrupted || isFailed) && !isActive && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-500 hover:text-green-600 hover:bg-green-500/10"
                                onClick={() => handlePoiResume(task)} title="继续采集" disabled={isOperating}>
                                <Play className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* 打开文件夹 */}
                        {task.output_path && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                onClick={() => handleOpenFolder(task.output_path!)} title="打开文件夹">
                                <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* 日志/详情 */}
                        {isTile && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                onClick={() => handleViewLogs(task.id)} title="查看日志">
                                <FileText className="h-3.5 w-3.5" />
                            </Button>
                        )}
                        {(isBuoy || isFeature || isPoi) && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                onClick={() => handleViewTaskDetails(task)} title="查看详情">
                                <FileText className="h-3.5 w-3.5" />
                            </Button>
                        )}

                        {/* 删除 - 仅瓦片任务 */}
                        {isTile && !isActive && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-500 hover:bg-red-500/10"
                                onClick={() => handleTileDelete(task.id, false)} title="删除任务">
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        )}
                    </div>
                </div>

                {/* 进度条和数字 */}
                <div className="mt-2.5 flex items-center gap-3">
                    <Progress value={progress} className="flex-1 h-1.5" />
                    <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                        {task.task_type === 'poi' ? (
                            <>
                                <span className="text-foreground font-medium">{(extra.total_collected as number) || 0}</span>
                                <span>条数据</span>
                                <span className="text-muted-foreground/50">|</span>
                                <span>{task.completed}/{task.total} 类别</span>
                            </>
                        ) : (
                            <>
                                <span className="text-green-500">{task.completed.toLocaleString()}</span>
                                {task.failed > 0 && (
                                    task.platform === 'cjhy' ? (
                                        <span className="text-amber-500 inline-flex items-center gap-0.5" title="航道图空白区域瓦片不存在，属正常现象">
                                            <AlertTriangle className="h-3 w-3" />
                                            {task.failed.toLocaleString()}空白
                                        </span>
                                    ) : (
                                        <span className="text-red-500 inline-flex items-center gap-0.5">
                                            <XCircle className="h-3 w-3" />
                                            {task.failed.toLocaleString()}
                                        </span>
                                    )
                                )}
                                <span className="text-muted-foreground/50">/</span>
                                <span>{task.total.toLocaleString()}</span>
                            </>
                        )}
                        <span className="text-muted-foreground/50">|</span>
                        <span>{formatTime(task.created_at)}</span>
                    </div>
                </div>
            </div>
        );
    };

    // 渲染分组
    const renderGroup = (title: string, items: UnifiedTask[]) => {
        if (items.length === 0) return null;
        return (
            <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
                    {title} ({items.length})
                </div>
                {items.map(renderTask)}
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col gap-4">
            {/* 顶部：标题 + 统计 */}
            <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-bold">任务历史</h2>
                    <Button size="sm" variant="ghost" onClick={loadTasks} className="h-7 px-2 text-muted-foreground">
                        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                    </Button>
                </div>

                {/* 统计卡片 */}
                <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5">
                        <div className="h-2 w-2 rounded-full bg-blue-500"></div>
                        <span className="text-muted-foreground">进行中</span>
                        <span className="font-semibold">{stats.active}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="h-2 w-2 rounded-full bg-green-500"></div>
                        <span className="text-muted-foreground">已完成</span>
                        <span className="font-semibold">{stats.completed}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="h-2 w-2 rounded-full bg-red-500"></div>
                        <span className="text-muted-foreground">失败</span>
                        <span className="font-semibold">{stats.failed}</span>
                    </div>
                    <span className="text-muted-foreground/50">|</span>
                    <span className="text-muted-foreground">共 <span className="font-semibold text-foreground">{stats.total}</span> 个任务</span>
                </div>
            </div>

            {/* Tab 切换 */}
            <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-lg shrink-0 w-fit">
                {TAB_CONFIG.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                            activeTab === tab.key
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <tab.icon className="h-3.5 w-3.5" />
                        {tab.label}
                        <span className={cn(
                            'text-[10px] px-1.5 py-0 rounded-full',
                            activeTab === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                        )}>
                            {tab.key === 'all' ? tasks.length : tasks.filter(t => t.task_type === tab.key).length}
                        </span>
                    </button>
                ))}
            </div>

            {/* 任务列表 */}
            <div className="flex-1 min-h-0">
                <SimpleBar className="h-full">
                    {loading ? (
                        <div className="flex items-center justify-center h-40">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : filteredTasks.length === 0 ? (
                        <Card className="border-dashed">
                            <CardContent className="py-12 text-center">
                                <Clock className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
                                <p className="text-muted-foreground">暂无任务记录</p>
                                <p className="text-sm text-muted-foreground/60 mt-1">开始采集或下载后，任务会自动记录在这里</p>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="space-y-4 pr-2">
                            {renderGroup('进行中', activeGroup)}
                            {renderGroup('已完成', completedGroup)}
                            {renderGroup('失败/已取消', otherGroup)}
                        </div>
                    )}
                </SimpleBar>
            </div>

            {/* 日志弹窗 */}
            <Dialog open={!!logTaskId} onOpenChange={(open) => !open && setLogTaskId(null)}>
                <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
                    <DialogHeader className="shrink-0">
                        <DialogTitle>{logData?._taskDetail ? '任务详情' : '任务日志'}</DialogTitle>
                    </DialogHeader>
                    {logLoading ? (
                        <div className="flex items-center justify-center h-40">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : logData ? (
                        <SimpleBar className="flex-1 min-h-0">
                            <div className="space-y-4 pr-2">
                                {logData._taskDetail ? (
                                    /* 通用任务详情视图 */
                                    <>
                                        <div className="grid grid-cols-3 gap-2 text-center text-sm">
                                            <div className="bg-muted/50 rounded-lg p-2">
                                                <div className="text-lg font-bold">{logData.task.total.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">总计</div>
                                            </div>
                                            <div className="bg-green-500/10 rounded-lg p-2">
                                                <div className="text-lg font-bold text-green-500">{logData.task.completed.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">已完成</div>
                                            </div>
                                            <div className="bg-red-500/10 rounded-lg p-2">
                                                <div className="text-lg font-bold text-red-500">{logData.task.failed.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">失败</div>
                                            </div>
                                        </div>

                                        <div className="space-y-2 text-sm">
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground">任务名称</span>
                                                <span className="font-medium">{logData.task.name}</span>
                                            </div>
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground">状态</span>
                                                <span className={cn('text-xs px-2 py-0.5 rounded-full', (STATUS_MAP[logData.task.status] || STATUS_MAP['idle']).color)}>
                                                    {(STATUS_MAP[logData.task.status] || STATUS_MAP['idle']).label}
                                                </span>
                                            </div>
                                            <div className="flex justify-between py-1.5 border-b border-border/50">
                                                <span className="text-muted-foreground">创建时间</span>
                                                <span>{formatTime(logData.task.created_at)}</span>
                                            </div>
                                            {logData.task.completed_at && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">完成时间</span>
                                                    <span>{formatTime(logData.task.completed_at)}</span>
                                                </div>
                                            )}
                                            {logData.task.platform && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">平台</span>
                                                    <span>{logData.task.platform}</span>
                                                </div>
                                            )}

                                            {/* 动态显示 extra 属性 */}
                                            {logData.extra.total_collected != null && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">采集数据量</span>
                                                    <span className="font-medium text-green-500">{Number(logData.extra.total_collected).toLocaleString()} 条</span>
                                                </div>
                                            )}
                                            {logData.extra.categories && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">采集类别</span>
                                                    <span className="text-right max-w-[200px] truncate" title={String(logData.extra.categories)}>
                                                        {String(logData.extra.categories)}
                                                    </span>
                                                </div>
                                            )}
                                            {logData.extra.region_code && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">区域代码</span>
                                                    <span className="font-mono text-xs">{String(logData.extra.region_code)}</span>
                                                </div>
                                            )}
                                            {logData.extra.bounds_west != null && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">采集范围</span>
                                                    <span className="font-mono text-xs">
                                                        {Number(logData.extra.bounds_west).toFixed(2)}~{Number(logData.extra.bounds_east).toFixed(2)}°E,{' '}
                                                        {Number(logData.extra.bounds_south).toFixed(2)}~{Number(logData.extra.bounds_north).toFixed(2)}°N
                                                    </span>
                                                </div>
                                            )}
                                            {logData.extra.grid_step != null && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">网格步长</span>
                                                    <span>{logData.extra.grid_step}°</span>
                                                </div>
                                            )}
                                            {logData.extra.layers && (
                                                <div className="flex justify-between py-1.5 border-b border-border/50">
                                                    <span className="text-muted-foreground">图层</span>
                                                    <span>{String(logData.extra.layers)}</span>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    /* 瓦片任务日志视图（原有逻辑） */
                                    <>
                                        <div className="grid grid-cols-4 gap-2 text-center text-sm">
                                            <div className="bg-muted/50 rounded-lg p-2">
                                                <div className="text-lg font-bold">{logData.stats.total.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">总计</div>
                                            </div>
                                            <div className="bg-green-500/10 rounded-lg p-2">
                                                <div className="text-lg font-bold text-green-500">{logData.stats.completed.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">已完成</div>
                                            </div>
                                            <div className="bg-red-500/10 rounded-lg p-2">
                                                <div className="text-lg font-bold text-red-500">{logData.stats.failed.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">失败</div>
                                            </div>
                                            <div className="bg-blue-500/10 rounded-lg p-2">
                                                <div className="text-lg font-bold text-blue-500">{logData.stats.pending.toLocaleString()}</div>
                                                <div className="text-xs text-muted-foreground">待下载</div>
                                            </div>
                                        </div>

                                        {logData.error_summary.length > 0 && (
                                            <div>
                                                <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                                                    <XCircle className="h-4 w-4 text-red-500" />
                                                    错误摘要
                                                </h4>
                                                <div className="space-y-1.5">
                                                    {logData.error_summary.map((item: any, i: number) => (
                                                        <div key={i} className="flex items-start gap-2 text-xs bg-red-500/5 border border-red-500/10 rounded-md p-2">
                                                            <span className="bg-red-500 text-white px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
                                                                {item.count}
                                                            </span>
                                                            <span className="text-red-400 break-all font-mono">{item.error}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {logData.failed_tiles.length > 0 && (
                                            <div>
                                                <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                                                    <MapPin className="h-4 w-4 text-red-500" />
                                                    失败瓦片详情
                                                    <span className="text-muted-foreground font-normal ml-1">
                                                        (显示前 {Math.min(logData.failed_tiles.length, 200)} 条)
                                                    </span>
                                                </h4>
                                                <div className="border rounded-md overflow-hidden">
                                                    <table className="w-full text-xs">
                                                        <thead className="bg-muted/50 sticky top-0 z-10">
                                                            <tr>
                                                                <th className="text-left px-2 py-1.5 font-medium">Z</th>
                                                                <th className="text-left px-2 py-1.5 font-medium">X</th>
                                                                <th className="text-left px-2 py-1.5 font-medium">Y</th>
                                                                <th className="text-left px-2 py-1.5 font-medium">重试</th>
                                                                <th className="text-left px-2 py-1.5 font-medium">错误信息</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {logData.failed_tiles.map((t: any, i: number) => (
                                                                <tr key={i} className="border-t border-border/50 hover:bg-muted/30">
                                                                    <td className="px-2 py-1 font-mono">{t.z}</td>
                                                                    <td className="px-2 py-1 font-mono">{t.x}</td>
                                                                    <td className="px-2 py-1 font-mono">{t.y}</td>
                                                                    <td className="px-2 py-1 font-mono">{t.retries}</td>
                                                                    <td className="px-2 py-1 text-red-400 break-all max-w-[200px]">{t.error}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        )}

                                        {logData.error_summary.length === 0 && logData.failed_tiles.length === 0 && (
                                            <div className="text-center text-muted-foreground py-8">
                                                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                                                <p>没有失败记录，任务运行正常</p>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </SimpleBar>
                    ) : null}
                </DialogContent>
            </Dialog>
        </div>
    );
}
