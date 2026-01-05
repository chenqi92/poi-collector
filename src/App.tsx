import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import Collector from '@/pages/Collector';
import Search from '@/pages/Search';
import Export from '@/pages/Export';
import '@/index.css';

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="poi-ui-theme">
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="collector" element={<Collector />} />
              <Route path="search" element={<Search />} />
              <Route path="export" element={<Export />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;

