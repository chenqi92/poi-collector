import { NavLink, Outlet } from 'react-router-dom';
import {
    LayoutDashboard,
    Download,
    Search,
    MapPin,
    FileOutput,
    Settings,
    Key,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

const navItems = [
    { path: '/dashboard', icon: LayoutDashboard, label: '概览' },
    { path: '/regions', icon: MapPin, label: '地区' },
    { path: '/collector', icon: Download, label: '采集' },
    { path: '/search', icon: Search, label: '查询' },
    { path: '/export', icon: FileOutput, label: '导出' },
];

export default function Layout() {
    return (
        <div className="flex h-screen bg-background">
            {/* Sidebar */}
            <aside className="w-16 bg-sidebar border-r border-sidebar-border flex flex-col items-center py-4">
                {/* Logo */}
                <div className="mb-6">
                    <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
                        <MapPin className="w-5 h-5 text-primary-foreground" />
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 flex flex-col gap-2">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) =>
                                cn(
                                    "w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
                                    "hover:bg-sidebar-accent text-sidebar-foreground",
                                    isActive && "bg-sidebar-accent text-sidebar-primary"
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
            <div className="flex-1 flex flex-col">
                {/* Top Bar */}
                <header className="h-14 border-b border-border flex items-center justify-between px-6">
                    <h1 className="text-lg font-semibold text-foreground">POI Collector</h1>

                    <div className="flex items-center gap-2">
                        <ThemeToggle />

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                    <Settings className="h-5 w-5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuLabel>设置</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem asChild>
                                    <NavLink to="/settings" className="flex items-center gap-2 cursor-pointer">
                                        <Key className="w-4 h-4" />
                                        API Key 管理
                                    </NavLink>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </header>

                {/* Content */}
                <main className="flex-1 overflow-y-auto p-6">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
