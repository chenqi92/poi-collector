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
            {/* Sidebar - Glassmorphism Style */}
            <aside className="w-16 bg-gradient-to-b from-sidebar/90 to-sidebar/70 backdrop-blur-xl border-r border-white/5 dark:border-white/5 flex flex-col items-center py-4 relative">
                {/* Subtle gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />
                
                {/* Logo with glow effect */}
                <div className="mb-6 relative z-10">
                    <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center text-white font-bold shadow-lg glow-sm">
                        P
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 flex flex-col gap-1 relative z-10">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) =>
                                cn(
                                    "w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-200 relative group",
                                    "text-muted-foreground hover:text-foreground",
                                    isActive 
                                        ? "gradient-primary text-white shadow-lg glow-sm" 
                                        : "hover:bg-accent/50"
                                )
                            }
                            title={item.label}
                        >
                            {({ isActive }) => (
                                <>
                                    <item.icon className={cn(
                                        "w-5 h-5 transition-transform duration-200",
                                        !isActive && "group-hover:scale-110"
                                    )} />
                                    {/* Active indicator bar */}
                                    {isActive && (
                                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-white rounded-r-full" />
                                    )}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* Bottom section */}
                <div className="relative z-10">
                    <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => setSettingsOpen(true)}
                        className="w-11 h-11 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all duration-200"
                    >
                        <Settings className="h-5 w-5" />
                    </Button>
                </div>
            </aside>

            {/* Main Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Bar with gradient accent */}
                <header className="h-14 border-b border-border/50 flex items-center justify-between px-6 shrink-0 bg-background/80 backdrop-blur-sm relative">
                    {/* Gradient accent line */}
                    <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
                    
                    <h1 className="text-lg font-semibold text-foreground">POI Collector</h1>

                    <div className="flex items-center gap-2">
                        <ThemeToggle />
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
