import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Key, Plus, Trash2, Eye, EyeOff, Loader2, Shield, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface ApiKey {
    id: number;
    name: string;
    api_key: string;
    is_active: boolean;
    quota_exhausted: boolean;
}

const platforms = [
    { id: 'tianditu', name: '天地图', hint: 'console.tianditu.gov.cn', gradient: 'from-cyan-500 to-cyan-600' },
    { id: 'amap', name: '高德地图', hint: 'console.amap.com', gradient: 'from-indigo-500 to-indigo-600' },
    { id: 'baidu', name: '百度地图', hint: 'lbsyun.baidu.com', gradient: 'from-red-500 to-red-600' },
];

export default function Settings() {
    const [keys, setKeys] = useState<Record<string, ApiKey[]>>({});
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
    const [newKey, setNewKey] = useState<Record<string, { name: string; key: string }>>({});
    const [loading, setLoading] = useState(true);
    const [addingKey, setAddingKey] = useState<string | null>(null);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const keysData = await invoke<Record<string, ApiKey[]>>('get_api_keys');
            setKeys(keysData);
        } catch (e) {
            console.error('加载设置失败:', e);
        } finally {
            setLoading(false);
        }
    };

    const addKey = async (platform: string) => {
        const data = newKey[platform];
        if (!data?.key) return;

        setAddingKey(platform);
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
        } finally {
            setAddingKey(null);
        }
    };

    const deleteKey = async (platform: string, keyId: number) => {
        if (!confirm('确定要删除这个 API Key 吗？')) return;
        try {
            await invoke('delete_api_key', { platform, keyId });
            loadData();
        } catch (e) {
            console.error('删除失败:', e);
        }
    };

    const getTotalKeys = () => Object.values(keys).reduce((sum, arr) => sum + arr.length, 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">加载设置...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">API Key 设置</h1>
                    <p className="text-muted-foreground">配置各平台的 API Key 用于数据采集</p>
                </div>
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 border border-primary/20">
                    <Key className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-primary">{getTotalKeys()} 个 Key</span>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {platforms.map((platform) => {
                    const platformKeys = keys[platform.id] || [];
                    const isAdding = addingKey === platform.id;

                    return (
                        <Card key={platform.id} className="overflow-hidden relative hover-lift transition-all">
                            {/* Gradient top border */}
                            <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${platform.gradient}`} />

                            <CardHeader>
                                <div className="flex items-center gap-2">
                                    <div className={`w-8 h-8 rounded-lg bg-gradient-to-r ${platform.gradient} flex items-center justify-center`}>
                                        <Key className="w-4 h-4 text-white" />
                                    </div>
                                    <CardTitle className="text-lg">{platform.name}</CardTitle>
                                    <span className="ml-auto px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                                        {platformKeys.length} 个
                                    </span>
                                </div>
                                <CardDescription className="flex items-center gap-1">
                                    <ExternalLink className="w-3 h-3" />
                                    {platform.hint}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {/* Key 列表 */}
                                <div className="space-y-2 max-h-40 overflow-y-auto">
                                    {platformKeys.length > 0 ? (
                                        platformKeys.map((k) => (
                                            <div
                                                key={k.id}
                                                className="flex items-center gap-2 p-3 bg-muted/50 rounded-xl border border-border/50"
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-medium text-foreground truncate">
                                                        {k.name || `Key ${k.id}`}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground font-mono truncate">
                                                        {showKeys[`${platform.id}-${k.id}`]
                                                            ? k.api_key
                                                            : '••••••••••••••••'
                                                        }
                                                    </div>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    onClick={() => setShowKeys({
                                                        ...showKeys,
                                                        [`${platform.id}-${k.id}`]: !showKeys[`${platform.id}-${k.id}`]
                                                    })}
                                                >
                                                    {showKeys[`${platform.id}-${k.id}`]
                                                        ? <EyeOff className="w-4 h-4" />
                                                        : <Eye className="w-4 h-4" />
                                                    }
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                                    onClick={() => deleteKey(platform.id, k.id)}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-6 text-muted-foreground text-sm">
                                            <Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                            尚未配置 API Key
                                        </div>
                                    )}
                                </div>

                                {/* 添加新 Key */}
                                <div className="pt-4 border-t border-border/50 space-y-2">
                                    <input
                                        type="text"
                                        placeholder="备注名称（可选）"
                                        className="w-full px-3 py-2 border border-input bg-background rounded-lg 
                                                 text-foreground placeholder:text-muted-foreground text-sm 
                                                 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                                        value={newKey[platform.id]?.name || ''}
                                        onChange={(e) => setNewKey({
                                            ...newKey,
                                            [platform.id]: { ...newKey[platform.id], name: e.target.value }
                                        })}
                                    />
                                    <div className="flex gap-2">
                                        <div className="flex-1 relative">
                                            <input
                                                type={showKeys[`new-${platform.id}`] ? 'text' : 'password'}
                                                placeholder="API Key"
                                                className="w-full px-3 py-2 pr-10 border border-input bg-background 
                                                         rounded-lg text-foreground placeholder:text-muted-foreground 
                                                         text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                                                value={newKey[platform.id]?.key || ''}
                                                onChange={(e) => setNewKey({
                                                    ...newKey,
                                                    [platform.id]: { ...newKey[platform.id], key: e.target.value }
                                                })}
                                                onKeyDown={(e) => e.key === 'Enter' && addKey(platform.id)}
                                            />
                                            <button
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground 
                                                         hover:text-foreground transition-colors"
                                                onClick={() => setShowKeys({
                                                    ...showKeys,
                                                    [`new-${platform.id}`]: !showKeys[`new-${platform.id}`]
                                                })}
                                            >
                                                {showKeys[`new-${platform.id}`]
                                                    ? <EyeOff className="w-4 h-4" />
                                                    : <Eye className="w-4 h-4" />
                                                }
                                            </button>
                                        </div>
                                        <Button
                                            onClick={() => addKey(platform.id)}
                                            disabled={isAdding || !newKey[platform.id]?.key}
                                            className="gradient-primary text-white border-0 hover:opacity-90"
                                        >
                                            {isAdding ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Plus className="w-4 h-4" />
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            <Card className="overflow-hidden">
                <CardHeader className="border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                    <CardTitle className="text-sm flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-primary/20 flex items-center justify-center">
                            <Shield className="w-3 h-3 text-primary" />
                        </div>
                        使用说明
                    </CardTitle>
                </CardHeader>
                <CardContent className="pt-4">
                    <ul className="text-sm text-muted-foreground space-y-2">
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                            每个平台可以配置多个 API Key，系统会自动轮换使用
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                            当某个 Key 配额耗尽时，会自动切换到下一个可用 Key
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                            建议为每个平台配置至少 2-3 个 Key 以确保采集稳定性
                        </li>
                    </ul>
                </CardContent>
            </Card>
        </div>
    );
}
