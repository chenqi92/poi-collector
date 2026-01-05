import { NavLink, Outlet } from 'react-router-dom';
import {
    LayoutDashboard,
    Settings,
    Download,
    Search,
    MapPin
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const navItems = [
    { path: '/dashboard', icon: LayoutDashboard, label: '数据概览' },
    { path: '/settings', icon: Settings, label: 'API Key设置' },
    { path: '/collector', icon: Download, label: '数据采集' },
    { path: '/search', icon: Search, label: '数据查询' },
];

export default function Layout() {
    const [regionName, setRegionName] = useState('加载中...');

    useEffect(() => {
        loadRegion();
    }, []);

    const loadRegion = async () => {
        try {
            const config = await invoke<{ name: string }>('get_region_config');
            setRegionName(config.name);
        } catch (e) {
            setRegionName('未配置');
        }
    };

    return (
        <div className="flex h-screen bg-slate-50">
            {/* Sidebar */}
            <aside className="w-64 bg-sidebar text-white flex flex-col">
                <div className="p-5 border-b border-white/10">
                    <h1 className="text-lg font-bold flex items-center gap-2">
                        <MapPin className="w-5 h-5 text-primary-400" />
                        POI Collector
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">{regionName}</p>
                </div>

                <nav className="flex-1 py-4">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) =>
                                `sidebar-item ${isActive ? 'active' : ''}`
                            }
                        >
                            <item.icon className="w-5 h-5" />
                            {item.label}
                        </NavLink>
                    ))}
                </nav>

                <div className="p-4 border-t border-white/10 text-xs text-slate-400">
                    v1.0.0 · Tauri Desktop
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto">
                <div className="p-8">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
