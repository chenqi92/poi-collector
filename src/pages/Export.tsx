import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Download,
  FileSpreadsheet,
  FileJson,
  Database,
  Loader2,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  MapPin,
  Search,
  FolderTree,
  Anchor,
  Ship,
} from "lucide-react";
import SimpleBar from "simplebar-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

interface ExportPOI {
  id: number;
  name: string;
  lon: number;
  lat: number;
  address: string;
  phone: string;
  category: string;
  platform: string;
  region_code: string;
}

interface Region {
  code: string;
  name: string;
  level: string;
  parent_code: string | null;
}

interface BuoyInfo {
  id: string;
  name: string | null;
  lon_84: number | null;
  lat_84: number | null;
  buoy_type: string | null;
  icon_url: string | null;
  organization_id: string | null;
  color: string | null;
  waterway: string | null;
  shape: string | null;
  light_info: string | null;
  region: string | null;
  raw_json: string;
}

const platformNames: Record<string, string> = {
  all: "全部平台",
  tianditu: "天地图",
  amap: "高德地图",
  baidu: "百度地图",
};

const platformColors: Record<string, string> = {
  tianditu: 'bg-cyan-500/20 text-cyan-500',
  amap: 'bg-indigo-500/20 text-indigo-500',
  baidu: 'bg-red-500/20 text-red-500',
};

const formats = [
  {
    id: "excel",
    icon: FileSpreadsheet,
    label: "CSV (Excel)",
    desc: ".csv",
    ext: "csv",
    gradient: "from-emerald-500 to-emerald-600",
  },
  { id: "json", icon: FileJson, label: "JSON", desc: ".json", ext: "json", gradient: "from-amber-500 to-amber-600" },
  { id: "mysql", icon: Database, label: "MySQL", desc: ".sql", ext: "sql", gradient: "from-blue-500 to-blue-600" },
];

export default function Export() {
  const [platform, setPlatform] = useState("all");
  const { success: showSuccess, error: showError } = useToast();

  // POI 导出弹框
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [format, setFormat] = useState("excel");
  const [exporting, setExporting] = useState(false);

  // 航标导出弹框
  const [showBuoyExportDialog, setShowBuoyExportDialog] = useState(false);
  const [buoyFormat, setBuoyFormat] = useState("excel");

  // 地区筛选
  const [provinces, setProvinces] = useState<Region[]>([]);
  const [children, setChildren] = useState<Record<string, Region[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(
    new Set()
  );
  const [regionNames, setRegionNames] = useState<Map<string, string>>(
    new Map()
  );

  // 搜索过滤
  const [searchQuery, setSearchQuery] = useState("");
  const [showAll, setShowAll] = useState(false); // 显示全部数据（跳过地区筛选）

  // 数据
  const [allData, setAllData] = useState<ExportPOI[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const [totalPoiCount, setTotalPoiCount] = useState(0);

  // Tab: poi | buoy
  const [activeTab, setActiveTab] = useState<'poi' | 'buoy'>('poi');

  // 航标数据
  const [buoyCount, setBuoyCount] = useState(0);
  const [buoyData, setBuoyData] = useState<BuoyInfo[]>([]);
  const [buoyExporting, setBuoyExporting] = useState(false);
  const [buoyPage, setBuoyPage] = useState(1);
  const [buoySearch, setBuoySearch] = useState('');
  const [buoySelectedRegion, setBuoySelectedRegion] = useState<string | null>(null);
  const buoyPageSize = 100;

  // 是否显示表格（选择了地区或开启了显示全部）
  const hasRegionSelected = selectedRegions.size > 0 || showAll;

  useEffect(() => {
    loadProvinces();
    loadBuoyInfo();
    loadTotalPoiCount();
  }, []);

  const loadTotalPoiCount = async () => {
    try {
      const stats = await invoke<{ total: number }>('get_stats');
      setTotalPoiCount(stats.total);
    } catch (e) {
      console.error('获取POI总数失败:', e);
    }
  };

  const loadBuoyInfo = async () => {
    try {
      const count = await invoke<number>('chart_get_buoy_count');
      setBuoyCount(count);
      if (count > 0) {
        const data = await invoke<BuoyInfo[]>('chart_get_all_buoys');
        setBuoyData(data);
      } else {
        setBuoyData([]);
      }
    } catch (e) {
      console.error('加载航标信息失败:', e);
    }
  };

  // 当选择地区后加载数据
  useEffect(() => {
    if (hasRegionSelected) {
      loadAllData();
    }
  }, [platform, hasRegionSelected]);

  const loadProvinces = async () => {
    try {
      const data = await invoke<Region[]>("get_provinces");
      setProvinces(data);
      const names = new Map<string, string>();
      data.forEach((p) => names.set(p.code, p.name));
      setRegionNames(names);
    } catch (e) {
      console.error("加载省份失败:", e);
    }
  };

  const loadChildren = async (parentCode: string) => {
    if (children[parentCode]) return children[parentCode];
    try {
      const data = await invoke<Region[]>("get_region_children", {
        parentCode,
      });
      setChildren((prev) => ({ ...prev, [parentCode]: data }));
      setRegionNames((prev) => {
        const newMap = new Map(prev);
        data.forEach((r) => newMap.set(r.code, r.name));
        return newMap;
      });
      return data;
    } catch (e) {
      console.error("加载子区域失败:", e);
      return [];
    }
  };

  const toggleExpand = async (code: string) => {
    const newExpanded = new Set(expanded);
    if (newExpanded.has(code)) {
      newExpanded.delete(code);
    } else {
      newExpanded.add(code);
      await loadChildren(code);
    }
    setExpanded(newExpanded);
  };

  const toggleSelectRegion = async (
    code: string,
    name: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    const newSelected = new Set(selectedRegions);
    const newNames = new Map(regionNames);
    newNames.set(code, name);

    if (newSelected.has(code)) {
      // 取消选中：同时移除所有子级和孙级
      newSelected.delete(code);
      const childData = children[code] || [];
      for (const child of childData) {
        newSelected.delete(child.code);
        const grandchildren = children[child.code] || [];
        for (const gc of grandchildren) {
          newSelected.delete(gc.code);
        }
      }
    } else {
      // 选中：同时选中所有子级和孙级
      newSelected.add(code);
      const childData = await loadChildren(code);
      for (const child of childData) {
        newSelected.add(child.code);
        newNames.set(child.code, child.name);
        if (child.level === "city") {
          const grandchildren = await loadChildren(child.code);
          for (const gc of grandchildren) {
            newSelected.add(gc.code);
            newNames.set(gc.code, gc.name);
          }
        }
      }
    }

    setSelectedRegions(newSelected);
    setRegionNames(newNames);
    setPage(1);
  };

  const clearSelectedRegions = () => {
    setSelectedRegions(new Set());
    setAllData([]);
    setPage(1);
  };

  const loadAllData = async () => {
    setLoading(true);
    try {
      // 先修复缺失的 region_code
      await invoke<[number, number]>("fix_region_codes");

      const data = await invoke<ExportPOI[]>("get_all_poi_data", {
        platform: platform === "all" ? null : platform,
      });
      setAllData(data);
    } catch (e) {
      console.error("加载数据失败:", e);
    } finally {
      setLoading(false);
    }
  };

  // 根据选中的地区过滤数据
  const filteredData = useMemo(() => {
    if (!hasRegionSelected) return [];

    let data = allData;

    // 如果不是"显示全部"模式，则按地区代码筛选
    if (!showAll && selectedRegions.size > 0) {
      const matchCodes = new Set<string>();

      for (const code of selectedRegions) {
        matchCodes.add(code);

        const childRegions = children[code] || [];
        for (const child of childRegions) {
          matchCodes.add(child.code);
          const grandchildren = children[child.code] || [];
          for (const gc of grandchildren) {
            matchCodes.add(gc.code);
          }
        }
      }

      data = data.filter((poi) => matchCodes.has(poi.region_code));
    }

    // 按搜索词进一步过滤
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      data = data.filter(
        (poi) =>
          poi.name.toLowerCase().includes(query) ||
          (poi.address && poi.address.toLowerCase().includes(query))
      );
    }

    return data;
  }, [
    allData,
    selectedRegions,
    children,
    searchQuery,
    hasRegionSelected,
    showAll,
  ]);

  const handleExport = async () => {
    if (filteredData.length === 0) {
      showError("无数据", "没有可导出的数据");
      return;
    }

    const formatInfo = formats.find((f) => f.id === format);
    if (!formatInfo) return;

    const filePath = await save({
      defaultPath: `poi_data_${platform}_${new Date().toISOString().split("T")[0]
        }.${formatInfo.ext}`,
      filters: [
        {
          name: formatInfo.label,
          extensions: [formatInfo.ext],
        },
      ],
    });

    if (!filePath) return;

    setExporting(true);

    try {
      const filteredIds = filteredData.map((poi) => poi.id);
      const count = await invoke<number>("export_poi_to_file", {
        path: filePath,
        format: format,
        platform: platform === "all" ? null : platform,
        ids: filteredIds,
      });

      showSuccess("导出成功", `已导出 ${count.toLocaleString()} 条数据`);
      setShowExportDialog(false);
    } catch (e) {
      showError("导出失败", String(e));
    } finally {
      setExporting(false);
    }
  };

  // 分页数据
  const pagedData = filteredData.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.ceil(filteredData.length / pageSize);

  // 航标过滤和分页
  // 提取去重的地区列表
  const buoyRegions = useMemo(() => {
    const regionSet = new Set<string>();
    buoyData.forEach(b => {
      if (b.region) regionSet.add(b.region);
    });
    return Array.from(regionSet).sort();
  }, [buoyData]);

  const filteredBuoyData = useMemo(() => {
    let data = buoyData;
    // 地区筛选
    if (buoySelectedRegion) {
      data = data.filter(b => b.region === buoySelectedRegion);
    }
    // 搜索筛选
    if (buoySearch.trim()) {
      const q = buoySearch.toLowerCase();
      data = data.filter(b =>
        (b.name || '').toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.buoy_type || '').toLowerCase().includes(q) ||
        (b.waterway || '').toLowerCase().includes(q) ||
        (b.region || '').toLowerCase().includes(q)
      );
    }
    return data;
  }, [buoyData, buoySelectedRegion, buoySearch]);
  const buoyTotalPages = Math.ceil(filteredBuoyData.length / buoyPageSize);
  const pagedBuoyData = filteredBuoyData.slice((buoyPage - 1) * buoyPageSize, buoyPage * buoyPageSize);

  const renderRegion = (region: Region, indent: number = 0) => {
    const hasChildren = region.level !== "district";
    const isExpanded = expanded.has(region.code);
    const isSelected = selectedRegions.has(region.code);
    const regionChildren = children[region.code] || [];

    return (
      <div key={region.code}>
        <div
          className={`flex items-center gap-1.5 py-1.5 px-2 rounded-lg text-xs transition-all cursor-pointer
                              ${isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent"
            }`}
          style={{ paddingLeft: `${indent * 12 + 8}px` }}
          onClick={(e) => toggleSelectRegion(region.code, region.name, e)}
        >
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(region.code);
              }}
              className="p-0.5 hover:bg-accent rounded transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => { }}
            onClick={(e) => toggleSelectRegion(region.code, region.name, e)}
            className="w-3.5 h-3.5 cursor-pointer accent-primary"
          />
          <span className="flex-1 truncate font-medium">
            {region.name}
          </span>
        </div>
        {isExpanded &&
          regionChildren.map((child) => renderRegion(child, indent + 1))}
      </div>
    );
  };

  const handleBuoyExport = async () => {
    if (filteredBuoyData.length === 0) {
      showError('无数据', '没有可导出的航标数据');
      return;
    }

    const formatInfo = formats.find(f => f.id === buoyFormat);
    if (!formatInfo) return;

    const filePath = await save({
      defaultPath: `buoys_export_${new Date().toISOString().split('T')[0]}.${formatInfo.ext}`,
      filters: [{ name: formatInfo.label, extensions: [formatInfo.ext] }],
    });

    if (!filePath) return;

    setBuoyExporting(true);
    try {
      // formats 中 id 为 excel 对应后端 csv，mysql 对应后端 mysql
      const backendFormat = buoyFormat === 'excel' ? 'csv' : buoyFormat;
      const result = await invoke<string>('chart_export_buoys', { format: backendFormat, outputPath: filePath });
      showSuccess('导出成功', result);
      setShowBuoyExportDialog(false);
    } catch (e) {
      showError('导出失败', String(e));
    } finally {
      setBuoyExporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">数据导出</h1>
          <p className="text-muted-foreground">
            导出已采集的 POI 和航标数据
          </p>
        </div>
        {/* Tab 切换 */}
        <div className="flex items-center bg-muted/50 rounded-xl p-1">
          <button
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'poi'
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground'
              }`}
            onClick={() => setActiveTab('poi')}
          >
            <MapPin className="w-4 h-4" />
            POI 数据
            <span className="ml-1 px-1.5 py-0.5 text-xs bg-primary/20 text-primary rounded-full">
              {allData.length > 0 ? allData.length.toLocaleString() : totalPoiCount.toLocaleString()}
            </span>
          </button>
          <button
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'buoy'
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground'
              }`}
            onClick={() => setActiveTab('buoy')}
          >
            <Anchor className="w-4 h-4" />
            航标数据
            {buoyCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-500 rounded-full">
                {buoyCount.toLocaleString()}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* POI Tab */}
      {activeTab === 'poi' && (
        <div className="flex-1 min-h-0 flex gap-4">
          {/* 左侧: 地区筛选 */}
          <Card className="w-56 shrink-0 overflow-hidden flex flex-col">
            <CardHeader className="py-3 px-4 shrink-0 border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FolderTree className="w-4 h-4 text-primary" />
                  选择地区
                </CardTitle>
                {selectedRegions.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={clearSelectedRegions}
                  >
                    清空({selectedRegions.size})
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
              <SimpleBar className="h-full p-2">
                {/* 显示全部选项 */}
                <div
                  className={`flex items-center gap-2 py-2.5 px-3 mb-2 rounded-xl text-xs border transition-all cursor-pointer
                                          ${showAll
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "border-border hover:bg-accent"
                    }`}
                  onClick={() => {
                    setShowAll(!showAll);
                    setPage(1);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={() => { }}
                    className="w-3.5 h-3.5 cursor-pointer accent-primary"
                  />
                  <span className="font-medium">显示全部数据</span>
                </div>

                {!showAll && (
                  <div className="text-[10px] text-muted-foreground px-2 mb-2">
                    按地区筛选（勾选上方可跳过）
                  </div>
                )}

                {provinces.map((p) => renderRegion(p))}
              </SimpleBar>
            </CardContent>
          </Card>

          {/* 右侧: 数据表格 */}
          <Card className="flex-1 overflow-hidden flex flex-col">
            {hasRegionSelected ? (
              <>
                <CardHeader className="py-3 px-4 shrink-0 border-b border-border/50 bg-gradient-to-r from-muted/50 to-transparent">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">数据预览</CardTitle>
                      <select
                        value={platform}
                        onChange={(e) => setPlatform(e.target.value)}
                        className="px-3 py-1.5 text-sm border border-input bg-background rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/50"
                      >
                        {Object.entries(platformNames).map(([key, name]) => (
                          <option key={key} value={key}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            setPage(1);
                          }}
                          placeholder="搜索名称或地址..."
                          className="pl-8 pr-3 py-1.5 text-sm border border-input bg-background rounded-lg w-48
                                                         focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                      <span className="text-sm text-muted-foreground">
                        <span className="text-primary font-medium">{filteredData.length.toLocaleString()}</span> 条
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {totalPages > 1 && (
                        <div className="flex items-center gap-1 text-sm mr-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                          >
                            上一页
                          </Button>
                          <span className="text-muted-foreground px-2">
                            {page}/{totalPages}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() =>
                              setPage((p) => Math.min(totalPages, p + 1))
                            }
                            disabled={page === totalPages}
                          >
                            下一页
                          </Button>
                        </div>
                      )}
                      <Button
                        onClick={() => setShowExportDialog(true)}
                        disabled={filteredData.length === 0}
                        className="gradient-primary text-white border-0 hover:opacity-90"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        导出数据
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
                  {loading ? (
                    <div className="flex items-center justify-center h-32">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    </div>
                  ) : filteredData.length > 0 ? (
                    <SimpleBar className="h-full">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 sticky top-0">
                          <tr>
                            <th className="text-left p-3 font-medium w-12">ID</th>
                            <th className="text-left p-3 font-medium">名称</th>
                            <th className="text-left p-3 font-medium">地址</th>
                            <th className="text-left p-3 font-medium w-20">类别</th>
                            <th className="text-left p-3 font-medium w-20">经度</th>
                            <th className="text-left p-3 font-medium w-20">纬度</th>
                            <th className="text-left p-3 font-medium w-16">平台</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedData.map((poi, idx) => (
                            <tr
                              key={poi.id}
                              className={`border-b border-border/30 hover:bg-accent/30 transition-colors ${idx % 2 === 1 ? 'bg-muted/20' : ''}`}
                            >
                              <td className="p-3 text-muted-foreground">
                                {poi.id}
                              </td>
                              <td
                                className="p-3 truncate max-w-[200px] font-medium"
                                title={poi.name}
                              >
                                {poi.name}
                              </td>
                              <td
                                className="p-3 truncate max-w-[200px] text-muted-foreground"
                                title={poi.address}
                              >
                                {poi.address || "-"}
                              </td>
                              <td className="p-3 text-muted-foreground">
                                {poi.category || "-"}
                              </td>
                              <td className="p-3 text-muted-foreground text-xs font-mono">
                                {poi.lon.toFixed(4)}
                              </td>
                              <td className="p-3 text-muted-foreground text-xs font-mono">
                                {poi.lat.toFixed(4)}
                              </td>
                              <td className="p-3">
                                <span className={`px-2 py-0.5 rounded-full text-xs ${platformColors[poi.platform] || 'bg-muted text-muted-foreground'}`}>
                                  {platformNames[poi.platform]?.substring(0, 2) ||
                                    poi.platform}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </SimpleBar>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                      <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
                      <p className="font-medium">所选地区暂无匹配数据</p>
                      <p className="text-xs mt-1">请尝试选择其他地区或平台</p>
                    </div>
                  )}
                </CardContent>
              </>
            ) : (
              <CardContent className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <div className="w-20 h-20 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                  <MapPin className="w-10 h-10 opacity-30" />
                </div>
                <p className="text-lg font-medium mb-2">请先选择地区</p>
                <p className="text-sm">在左侧地区列表中勾选要导出的地区</p>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      {/* Buoy Tab */}
      {activeTab === 'buoy' && (
        <div className="flex-1 min-h-0 flex gap-4">
          {/* 左侧：地区筛选 */}
          <Card className="w-48 shrink-0 overflow-hidden flex flex-col">
            <CardHeader className="py-2 px-3 shrink-0 border-b border-border/50 bg-gradient-to-r from-blue-500/10 to-transparent">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-blue-500" />
                  地区筛选
                </span>
                {buoySelectedRegion && (
                  <button onClick={() => { setBuoySelectedRegion(null); setBuoyPage(1); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground">
                    清除
                  </button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 min-h-0">
              <SimpleBar className="h-full">
                <div className="p-1">
                  <button
                    className={`w-full text-left px-2.5 py-1.5 text-xs rounded transition-colors ${!buoySelectedRegion ? 'bg-blue-500/10 text-blue-500 font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
                    onClick={() => { setBuoySelectedRegion(null); setBuoyPage(1); }}
                  >
                    全部地区 ({buoyData.length})
                  </button>
                  {buoyRegions.map(region => {
                    const count = buoyData.filter(b => b.region === region).length;
                    return (
                      <button
                        key={region}
                        className={`w-full text-left px-2.5 py-1.5 text-xs rounded transition-colors flex items-center justify-between ${buoySelectedRegion === region ? 'bg-blue-500/10 text-blue-500 font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
                        onClick={() => { setBuoySelectedRegion(region); setBuoyPage(1); }}
                      >
                        <span>{region}</span>
                        <span className="text-[10px]">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </SimpleBar>
            </CardContent>
          </Card>


          {/* 右侧：航标数据表格 */}
          <Card className="flex-1 overflow-hidden flex flex-col">
            <CardHeader className="py-3 px-4 shrink-0 border-b border-border/50 bg-gradient-to-r from-blue-500/10 to-transparent">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Ship className="w-4 h-4 text-blue-500" />
                    航标数据
                  </CardTitle>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={buoySearch}
                      onChange={(e) => { setBuoySearch(e.target.value); setBuoyPage(1); }}
                      placeholder="搜索名称/ID/类型..."
                      className="pl-8 pr-3 py-1.5 text-sm border border-input bg-background rounded-lg w-48 focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <span className="text-sm text-muted-foreground">
                    <span className="text-blue-500 font-medium">{filteredBuoyData.length.toLocaleString()}</span> 条
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {buoyTotalPages > 1 && (
                    <div className="flex items-center gap-1 text-sm mr-2">
                      <Button variant="outline" size="sm" className="h-7 px-2"
                        onClick={() => setBuoyPage(p => Math.max(1, p - 1))} disabled={buoyPage === 1}>
                        上一页
                      </Button>
                      <span className="text-muted-foreground px-2">{buoyPage}/{buoyTotalPages}</span>
                      <Button variant="outline" size="sm" className="h-7 px-2"
                        onClick={() => setBuoyPage(p => Math.min(buoyTotalPages, p + 1))} disabled={buoyPage === buoyTotalPages}>
                        下一页
                      </Button>
                    </div>
                  )}
                  <Button
                    onClick={() => setShowBuoyExportDialog(true)}
                    disabled={filteredBuoyData.length === 0}
                    className="gradient-primary text-white border-0 hover:opacity-90"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    导出数据
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
              {buoyData.length > 0 ? (
                <SimpleBar className="h-full">
                  <table className="w-full text-sm table-fixed">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium w-[160px]">名称</th>
                        <th className="text-left p-2 font-medium w-[100px]">航道</th>
                        <th className="text-left p-2 font-medium w-[70px]">地区</th>
                        <th className="text-left p-2 font-medium w-[180px]">坐标</th>
                        <th className="text-left p-2 font-medium w-[60px]">形状</th>
                        <th className="text-left p-2 font-medium w-[100px]">灯质</th>
                        <th className="text-left p-2 font-medium w-[60px]">颜色</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedBuoyData.map((buoy, idx) => (
                        <tr key={buoy.id}
                          className={`border-b border-border/30 hover:bg-accent/30 transition-colors ${idx % 2 === 1 ? 'bg-muted/20' : ''}`}>
                          <td className="p-2 font-medium truncate" title={buoy.name || ''}>
                            {buoy.name || '-'}
                          </td>
                          <td className="p-2 text-xs truncate" title={buoy.waterway || ''}>
                            {buoy.waterway ? (
                              <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600">{buoy.waterway}</span>
                            ) : '-'}
                          </td>
                          <td className="p-2 text-xs truncate">
                            {buoy.region ? (
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">{buoy.region}</span>
                            ) : '-'}
                          </td>
                          <td className="p-2 text-muted-foreground text-xs font-mono whitespace-nowrap">
                            {buoy.lon_84?.toFixed(5) || '-'}, {buoy.lat_84?.toFixed(5) || '-'}
                          </td>
                          <td className="p-2 text-xs text-muted-foreground truncate">
                            {buoy.shape || '-'}
                          </td>
                          <td className="p-2 text-xs truncate" title={buoy.light_info || ''}>
                            {buoy.light_info || '-'}
                          </td>
                          <td className="p-2">
                            {buoy.color ? (
                              <span className="px-1.5 py-0.5 rounded-full text-xs bg-muted">
                                {buoy.color}
                              </span>
                            ) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </SimpleBar>
              ) : (
                <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                  <Anchor className="w-8 h-8 mb-2 opacity-50" />
                  <p className="font-medium">暂无航标数据</p>
                  <p className="text-xs mt-1">请先在航道图采集页面采集航标</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )
      }

      {/* 导出弹框 */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center">
                <Download className="w-4 h-4 text-white" />
              </div>
              导出数据
            </DialogTitle>
            <DialogDescription>
              选择导出格式，将导出 <span className="text-primary font-medium">{filteredData.length.toLocaleString()}</span> 条数据
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            {formats.map((f) => {
              const Icon = f.icon;
              const isSelected = format === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer hover-lift
                                              ${isSelected
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:border-primary/30"
                    }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isSelected ? `bg-gradient-to-r ${f.gradient}` : 'bg-muted'}`}>
                    <Icon className={`w-4 h-4 ${isSelected ? 'text-white' : 'text-muted-foreground'}`} />
                  </div>
                  <span
                    className={
                      isSelected
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {f.label}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {f.desc}
                  </span>
                </button>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowExportDialog(false)}
            >
              取消
            </Button>
            <Button onClick={handleExport} disabled={exporting} className="gradient-primary text-white border-0 hover:opacity-90">
              {exporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  导出中...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  选择位置导出
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 航标导出弹框 */}
      <Dialog open={showBuoyExportDialog} onOpenChange={setShowBuoyExportDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 flex items-center justify-center">
                <Anchor className="w-4 h-4 text-white" />
              </div>
              导出航标数据
            </DialogTitle>
            <DialogDescription>
              选择导出格式，将导出 <span className="text-blue-500 font-medium">{filteredBuoyData.length.toLocaleString()}</span> 条航标数据
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            {formats.map((f) => {
              const Icon = f.icon;
              const isSelected = buoyFormat === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setBuoyFormat(f.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer hover-lift
                    ${isSelected
                      ? "border-blue-500/50 bg-blue-500/5"
                      : "border-border hover:border-blue-500/30"
                    }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isSelected ? `bg-gradient-to-r ${f.gradient}` : 'bg-muted'}`}>
                    <Icon className={`w-4 h-4 ${isSelected ? 'text-white' : 'text-muted-foreground'}`} />
                  </div>
                  <span
                    className={
                      isSelected
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {f.label}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {f.desc}
                  </span>
                </button>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBuoyExportDialog(false)}
            >
              取消
            </Button>
            <Button onClick={handleBuoyExport} disabled={buoyExporting} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 hover:opacity-90">
              {buoyExporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  导出中...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  选择位置导出
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div >
  );
}
