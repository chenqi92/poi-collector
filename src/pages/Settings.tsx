import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Key, MapPin, Plus, Trash2, Eye, EyeOff } from 'lucide-react';

interface ApiKey {
    id: number;
    name: string;
    api_key: string;
    is_active: boolean;
    quota_exhausted: boolean;
}

interface RegionConfig {
    name: string;
    admin_code: string;
    city_code: string;
    bounds: {
        min_lon: number;
        max_lon: number;
        min_lat: number;
        max_lat: number;
    };
}

interface RegionPreset {
    id: string;
    name: string;
    admin_code: string;
}

const platforms = [
    { id: 'tianditu', name: '天地图', hint: '访问 console.tianditu.gov.cn 申请' },
    { id: 'amap', name: '高德地图', hint: '访问 console.amap.com 申请 Web服务API Key' },
    { id: 'baidu', name: '百度地图', hint: '访问 lbsyun.baidu.com 申请服务端AK' },
];

export default function Settings() {
    const [keys, setKeys] = useState<Record<string, ApiKey[]>>({});
    const [region, setRegion] = useState<RegionConfig | null>(null);
    const [presets, setPresets] = useState<RegionPreset[]>([]);
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
    const [newKey, setNewKey] = useState<Record<string, { name: string; key: string }>>({});

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [keysData, regionData, presetsData] = await Promise.all([
                invoke<Record<string, ApiKey[]>>('get_api_keys'),
                invoke<RegionConfig>('get_region_config'),
                invoke<RegionPreset[]>('get_region_presets'),
            ]);
            setKeys(keysData);
            setRegion(regionData);
            setPresets(presetsData);
        } catch (e) {
            console.error('加载设置失败:', e);
        }
    };

    const addKey = async (platform: string) => {
        const data = newKey[platform];
        if (!data?.key) return;

        try {
            await invoke('add_api_key', {
                platform,
                apiKey: data.key,
                name: data.name || undefined
            });
            setNewKey({ ...newKey, [platform]: { name: '', key: '' } });
            loadData();
        } catch (e) {
            console.error('添加Key失败:', e);
        }
    };

    const deleteKey = async (platform: string, keyId: number) => {
        if (!confirm('确定要删除这个API Key吗？')) return;
        try {
            await invoke('delete_api_key', { platform, keyId });
            loadData();
        } catch (e) {
            console.error('删除失败:', e);
        }
    };

    const selectPreset = async (presetId: string) => {
        try {
            await invoke('set_region_by_preset', { presetId });
            loadData();
        } catch (e) {
            console.error('切换区域失败:', e);
        }
    };

    return (
        <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">设置</h1>
            <p className="text-slate-500 mb-8">配置API Key和采集区域</p>

            {/* API Keys */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                {platforms.map((platform) => (
                    <div key={platform.id} className="card">
                        <div className="flex items-center gap-2 mb-2">
                            <Key className="w-5 h-5 text-primary-500" />
                            <h3 className="font-semibold">{platform.name}</h3>
                        </div>
                        <p className="text-xs text-slate-400 mb-4">{platform.hint}</p>

                        {/* Key List */}
                        <div className="space-y-2 mb-4 max-h-40 overflow-y-auto">
                            {keys[platform.id]?.map((k) => (
                                <div key={k.id} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg text-sm">
                                    <div className="flex-1 truncate">
                                        <div className="font-medium">{k.name || `Key ${k.id}`}</div>
                                        <div className="text-slate-400 text-xs font-mono">{k.api_key}</div>
                                    </div>
                                    <button
                                        onClick={() => deleteKey(platform.id, k.id)}
                                        className="p-1 text-red-500 hover:bg-red-50 rounded"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            )) || <div className="text-slate-400 text-sm">尚未配置Key</div>}
                        </div>

                        {/* Add Key */}
                        <div className="space-y-2 pt-4 border-t">
                            <input
                                type="text"
                                placeholder="备注名称（可选）"
                                className="input text-sm"
                                value={newKey[platform.id]?.name || ''}
                                onChange={(e) => setNewKey({
                                    ...newKey,
                                    [platform.id]: { ...newKey[platform.id], name: e.target.value }
                                })}
                            />
                            <div className="flex gap-2">
                                <div className="flex-1 relative">
                                    <input
                                        type={showKeys[platform.id] ? 'text' : 'password'}
                                        placeholder="API Key"
                                        className="input text-sm pr-10"
                                        value={newKey[platform.id]?.key || ''}
                                        onChange={(e) => setNewKey({
                                            ...newKey,
                                            [platform.id]: { ...newKey[platform.id], key: e.target.value }
                                        })}
                                    />
                                    <button
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
                                        onClick={() => setShowKeys({ ...showKeys, [platform.id]: !showKeys[platform.id] })}
                                    >
                                        {showKeys[platform.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                <button className="btn btn-primary" onClick={() => addKey(platform.id)}>
                                    <Plus className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Region Config */}
            <div className="card">
                <div className="flex items-center gap-2 mb-4">
                    <MapPin className="w-5 h-5 text-primary-500" />
                    <h3 className="font-semibold">采集区域配置</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">预设区域</label>
                        <select
                            className="input"
                            value=""
                            onChange={(e) => e.target.value && selectPreset(e.target.value)}
                        >
                            <option value="">选择预设区域...</option>
                            {presets.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name} ({p.admin_code})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-lg">
                        <div className="text-sm font-medium text-slate-700 mb-2">当前配置</div>
                        {region ? (
                            <div className="text-sm space-y-1">
                                <div><span className="text-slate-500">区域:</span> <span className="font-medium">{region.name}</span></div>
                                <div><span className="text-slate-500">代码:</span> {region.admin_code}</div>
                                <div><span className="text-slate-500">范围:</span> {region.bounds.min_lon.toFixed(2)}~{region.bounds.max_lon.toFixed(2)}, {region.bounds.min_lat.toFixed(2)}~{region.bounds.max_lat.toFixed(2)}</div>
                            </div>
                        ) : (
                            <div className="text-slate-400">未配置</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
