import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { TasksProvider } from '@/lib/tasksContext';
import { NotificationsProvider, NotificationsBridge } from '@/lib/notificationsContext';
import { PoiDataProvider } from '@/lib/poiDataContext';
import { Shell } from '@/components/shell';
import '@/index.css';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const NewCollection = lazy(() => import('@/pages/NewCollection'));
const DataHub = lazy(() => import('@/pages/DataHub'));
const OfflineMaps = lazy(() => import('@/pages/OfflineMaps'));
const Settings = lazy(() => import('@/pages/Settings'));

function RouteFallback() {
    return (
        <div
            style={{
                flex: 1,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--text-3)',
                fontSize: 12,
            }}
        >
            <span>加载模块...</span>
        </div>
    );
}

function App() {
    return (
        <ThemeProvider defaultTheme="dark" storageKey="poi-ui-theme">
            <NotificationsProvider>
                <NotificationsBridge />
                <ToastProvider>
                    <TasksProvider>
                        <PoiDataProvider>
                        <BrowserRouter>
                            <Routes>
                                <Route path="/" element={<Shell />}>
                                    <Route index element={<Navigate to="/workspace" replace />} />

                                    {/* 5 canonical modules */}
                                    <Route path="workspace" element={<Suspense fallback={<RouteFallback />}><Dashboard /></Suspense>} />
                                    <Route path="new" element={<Suspense fallback={<RouteFallback />}><NewCollection /></Suspense>} />
                                    <Route path="data" element={<Suspense fallback={<RouteFallback />}><DataHub /></Suspense>} />
                                    <Route path="offline" element={<Suspense fallback={<RouteFallback />}><OfflineMaps /></Suspense>} />
                                    <Route path="settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />

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
                        </PoiDataProvider>
                    </TasksProvider>
                </ToastProvider>
            </NotificationsProvider>
        </ThemeProvider>
    );
}

export default App;
