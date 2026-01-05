import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import Settings from '@/pages/Settings';
import Collector from '@/pages/Collector';
import Search from '@/pages/Search';
import Regions from '@/pages/Regions';
import Export from '@/pages/Export';
import '@/index.css';

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="poi-ui-theme">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="regions" element={<Regions />} />
            <Route path="settings" element={<Settings />} />
            <Route path="collector" element={<Collector />} />
            <Route path="search" element={<Search />} />
            <Route path="export" element={<Export />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
