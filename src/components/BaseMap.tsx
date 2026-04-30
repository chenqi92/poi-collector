import { memo, useMemo } from 'react';
import { TileLayer } from 'react-leaflet';
import { cn } from '@/lib/utils';
import {
    BaseMapType,
    TIANDITU_ANNOTATION_URL,
    TIANDITU_SUBDOMAINS,
    resolveBaseMap,
    useAvailableBaseMaps,
    useTiandituKey,
} from '@/lib/baseMaps';

interface BaseMapLayerProps {
    baseMapType: BaseMapType;
    /** 外部传入的天地图 Key 覆盖（如下载页输入框中实时输入的 key） */
    tiandituKeyOverride?: string;
}

/** 渲染当前选中的底图（含天地图卫星/地形的注记叠加） */
export const BaseMapLayer = memo(function BaseMapLayer({
    baseMapType,
    tiandituKeyOverride,
}: BaseMapLayerProps) {
    const savedKey = useTiandituKey();
    // 优先使用外部传入的 key，便于 key 还未持久化到数据库时也能即时生效
    const tiandituKey = tiandituKeyOverride && tiandituKeyOverride.length > 0
        ? tiandituKeyOverride
        : savedKey;
    const available = useAvailableBaseMaps(tiandituKey);
    const current = useMemo(() => resolveBaseMap(baseMapType, available), [baseMapType, available]);
    const url = useMemo(
        () => current?.url.replace('{tk}', tiandituKey) ?? '',
        [current, tiandituKey]
    );
    const annotationUrl = useMemo(
        () => TIANDITU_ANNOTATION_URL.replace('{tk}', tiandituKey),
        [tiandituKey]
    );

    if (!current) return null;

    const showAnnotation =
        (current.key === 'tianditu_img' || current.key === 'tianditu_ter') && !!tiandituKey;

    return (
        <>
            <TileLayer
                key={current.key}
                attribution={current.attr}
                url={url}
                {...(current.subdomains ? { subdomains: current.subdomains } : {})}
            />
            {showAnnotation && (
                <TileLayer
                    key={`${current.key}-cva`}
                    url={annotationUrl}
                    subdomains={TIANDITU_SUBDOMAINS}
                />
            )}
        </>
    );
});

interface BaseMapSwitcherProps {
    value: BaseMapType;
    onChange: (type: BaseMapType) => void;
    className?: string;
    size?: 'sm' | 'md';
}

/** 底图切换工具条；未配置天地图 Key 时自动隐藏天地图选项 */
export const BaseMapSwitcher = memo(function BaseMapSwitcher({
    value,
    onChange,
    className,
    size = 'sm',
}: BaseMapSwitcherProps) {
    const tiandituKey = useTiandituKey();
    const available = useAvailableBaseMaps(tiandituKey);
    const sizeCls = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]';

    return (
        <div className={cn('flex items-center gap-0.5 p-0.5 bg-muted rounded-md', className)}>
            {available.map((opt) => (
                <button
                    key={opt.key}
                    type="button"
                    onClick={() => onChange(opt.key)}
                    className={cn(
                        'rounded transition-all',
                        sizeCls,
                        value === opt.key
                            ? 'bg-background text-foreground shadow-sm font-medium'
                            : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
});
