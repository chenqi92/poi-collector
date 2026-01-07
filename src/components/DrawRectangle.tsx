import { useEffect, useRef, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';

export interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface DrawRectangleProps {
    bounds: Bounds;
    onBoundsChange: (bounds: Bounds) => void;
    editable?: boolean;
}

export function DrawRectangle({
    bounds,
    onBoundsChange,
    editable = true,
}: DrawRectangleProps) {
    const map = useMap();
    const rectangleRef = useRef<L.Rectangle | null>(null);
    const drawControlRef = useRef<L.Control.Draw | null>(null);
    const drawnItemsRef = useRef<L.FeatureGroup>(new L.FeatureGroup());
    const isExternalUpdateRef = useRef(false);

    // 从矩形层提取边界
    const extractBounds = useCallback(
        (layer: L.Rectangle) => {
            const latLngBounds = layer.getBounds();
            onBoundsChange({
                north: latLngBounds.getNorth(),
                south: latLngBounds.getSouth(),
                east: latLngBounds.getEast(),
                west: latLngBounds.getWest(),
            });
        },
        [onBoundsChange]
    );

    // 初始化绘制控件
    useEffect(() => {
        map.addLayer(drawnItemsRef.current);

        if (editable) {
            // 自定义绘制控件
            drawControlRef.current = new L.Control.Draw({
                position: 'topright',
                draw: {
                    rectangle: {
                        shapeOptions: {
                            color: '#3b82f6',
                            weight: 2,
                            fillOpacity: 0.2,
                        },
                    },
                    polyline: false,
                    polygon: false,
                    circle: false,
                    circlemarker: false,
                    marker: false,
                },
                edit: {
                    featureGroup: drawnItemsRef.current,
                    remove: true,
                },
            });
            map.addControl(drawControlRef.current);
        }

        // 处理绘制创建事件
        const handleCreated = (e: L.LeafletEvent) => {
            const event = e as L.DrawEvents.Created;
            drawnItemsRef.current.clearLayers();
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
                rectangleRef.current = null;
            }

            const layer = event.layer as L.Rectangle;
            drawnItemsRef.current.addLayer(layer);
            extractBounds(layer);
        };

        // 处理编辑事件
        const handleEdited = (e: L.LeafletEvent) => {
            const event = e as L.DrawEvents.Edited;
            event.layers.eachLayer((layer) => {
                if (layer instanceof L.Rectangle) {
                    extractBounds(layer);
                }
            });
        };

        // 处理删除事件
        const handleDeleted = () => {
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
                rectangleRef.current = null;
            }
            onBoundsChange({ north: 0, south: 0, east: 0, west: 0 });
        };

        map.on(L.Draw.Event.CREATED, handleCreated);
        map.on(L.Draw.Event.EDITED, handleEdited);
        map.on(L.Draw.Event.DELETED, handleDeleted);

        return () => {
            map.off(L.Draw.Event.CREATED, handleCreated);
            map.off(L.Draw.Event.EDITED, handleEdited);
            map.off(L.Draw.Event.DELETED, handleDeleted);

            if (drawControlRef.current) {
                map.removeControl(drawControlRef.current);
            }
            map.removeLayer(drawnItemsRef.current);
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
            }
        };
    }, [map, editable, extractBounds, onBoundsChange]);

    // 同步外部边界到矩形
    useEffect(() => {
        // 只有边界有效时才显示
        if (bounds.north > bounds.south && bounds.east > bounds.west) {
            isExternalUpdateRef.current = true;

            // 清除绘制的项目
            drawnItemsRef.current.clearLayers();

            if (rectangleRef.current) {
                rectangleRef.current.setBounds([
                    [bounds.south, bounds.west],
                    [bounds.north, bounds.east],
                ]);
            } else {
                rectangleRef.current = L.rectangle(
                    [
                        [bounds.south, bounds.west],
                        [bounds.north, bounds.east],
                    ],
                    {
                        color: '#3b82f6',
                        weight: 2,
                        fillOpacity: 0.2,
                    }
                );
                map.addLayer(rectangleRef.current);
            }

            // 将矩形添加到可编辑组
            if (editable && rectangleRef.current) {
                drawnItemsRef.current.addLayer(rectangleRef.current);
                rectangleRef.current = null;
            }

            isExternalUpdateRef.current = false;
        } else {
            // 清除矩形
            drawnItemsRef.current.clearLayers();
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
                rectangleRef.current = null;
            }
        }
    }, [map, bounds, editable]);

    return null;
}
