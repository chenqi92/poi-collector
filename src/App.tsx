import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { TasksProvider } from '@/lib/tasksContext';
import { NotificationsProvider, NotificationsBridge } from '@/lib/notificationsContext';
import { Shell } from '@/components/shell';
import Dashboard from '@/pages/Dashboard';
import NewCollection from '@/pages/NewCollection';
import DataHub from '@/pages/DataHub';
import OfflineMaps from '@/pages/OfflineMaps';
import Settings from '@/pages/Settings';
import '@/index.css';

function App() {
    return (
        <ThemeProvider defaultTheme="dark" storageKey="poi-ui-theme">
            <NotificationsProvider>
                <NotificationsBridge />
                <ToastProvider>
                    <TasksProvider>
                        <BrowserRouter>
                            <Routes>
                                <Route path="/" element={<Shell />}>
                                    <Route index element={<Navigate to="/workspace" replace />} />

                                    {/* 5 canonical modules */}
                                    <Route path="workspace" element={<Dashboard />} />
                                    <Route path="new" element={<NewCollection />} />
                                    <Route path="data" element={<DataHub />} />
                                    <Route path="offline" element={<OfflineMaps />} />
                                    <Route path="settings" element={<Settings />} />

                                    {/* Legacy paths → new modules */}
                                    <Route path="dashboard" element={<Navigate to="/workspace" replace />} />
                                    <Route path="collector" element={<Navigate to="/new?tab=poi" replace />} />
                                    <Route path="tile-downloader" element={<Navigate to="/new?tab=tile" replace />} />
                                    <Route path="search" element={<Navigate to="/data?tab=browse" replace />} />
                                    <Route path="export" element={<Navigate to="/data?tab=export" replace />} />
                                    <Route path="task-history" element={<Navigate to="/new?sub=history" replace />} />
                                    <Route path="data-management" element={<Navigate to="/data?tab=cleanup" replace />} />
                                </Route>
                            </Routes>
                        </BrowserRouter>
                    </TasksProvider>
                </ToastProvider>
            </NotificationsProvider>
        </ThemeProvider>
    );
}

export default App;
