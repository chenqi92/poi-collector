import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
    LayoutDashboard,
    Download,
    Search,
    FileOutput,
    Database,
    Settings,
    Map,
} from 'lucide-react';
import SimpleBar from 'simplebar-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { SettingsDialog } from '@/components/SettingsDialog';
import { cn } from '@/lib/utils';

const navItems = [
    { path: '/dashboard', icon: LayoutDashboard, label: '概览' },
    { path: '/collector', icon: Download, label: '采集' },
    { path: '/tile-downloader', icon: Map, label: '瓦片' },
    { path: '/search', icon: Search, label: '查询' },
    { path: '/export', icon: FileOutput, label: '导出' },
    { path: '/data-management', icon: Database, label: '数据管理' },
];

export default function Layout() {
    const [settingsOpen, setSettingsOpen] = useState(false);

    return (
        <div className="flex h-screen bg-background">
            {/* Sidebar */}
            <aside className="w-16 bg-muted/50 border-r border-border flex flex-col items-center py-4">
                {/* Logo */}
                <div className="mb-6">
                    <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold">
                        P
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 flex flex-col gap-1">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) =>
                                cn(
                                    "w-11 h-11 rounded-lg flex items-center justify-center transition-all relative",
                                    "hover:bg-accent text-muted-foreground hover:text-foreground",
                                    isActive && "bg-primary text-primary-foreground shadow-md hover:bg-primary hover:text-primary-foreground"
                                )
                            }
                            title={item.label}
                        >
                            <item.icon className="w-5 h-5" />
                        </NavLink>
                    ))}
                </nav>
            </aside>

            {/* Main Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Bar */}
                <header className="h-14 border-b border-border flex items-center justify-between px-6 shrink-0">
                    <h1 className="text-lg font-semibold text-foreground">POI Collector</h1>

                    <div className="flex items-center gap-2">
                        <ThemeToggle />
                        <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}>
                            <Settings className="h-5 w-5" />
                        </Button>
                    </div>
                </header>

                {/* Content */}
                <SimpleBar className="flex-1 p-6">
                    <Outlet />
                </SimpleBar>
            </div>

            {/* Settings Dialog */}
            <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </div>
    );
}
