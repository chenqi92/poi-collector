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

const platformNames: Record<string, string> = {
  all: "全部平台",
  tianditu: "天地图",
  amap: "高德地图",
  baidu: "百度地图",
};

const formats = [
  {
    id: "excel",
    icon: FileSpreadsheet,
    label: "CSV (Excel)",
    desc: ".csv",
    ext: "csv",
  },
  { id: "json", icon: FileJson, label: "JSON", desc: ".json", ext: "json" },
  { id: "mysql", icon: Database, label: "MySQL", desc: ".sql", ext: "sql" },
];

export default function Export() {
  const [platform, setPlatform] = useState("all");
  const { success: showSuccess, error: showError } = useToast();

  // 导出弹框
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [format, setFormat] = useState("excel");
  const [exporting, setExporting] = useState(false);

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

  // 是否显示表格（选择了地区或开启了显示全部）
  const hasRegionSelected = selectedRegions.size > 0 || showAll;

  useEffect(() => {
    loadProvinces();
  }, []);

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
  // 选择省级时，匹配该省所有市县；选择市级时，匹配该市所有区县
  const filteredData = useMemo(() => {
    if (!hasRegionSelected) return [];

    let data = allData;

    // 如果不是"显示全部"模式，则按地区代码筛选
    if (!showAll && selectedRegions.size > 0) {
      // 收集所有要匹配的地区代码（包括选中地区及其子地区）
      const matchCodes = new Set<string>();

      for (const code of selectedRegions) {
        matchCodes.add(code);

        // 添加子地区代码
        const childRegions = children[code] || [];
        for (const child of childRegions) {
          matchCodes.add(child.code);
          // 如果是市级，还要添加区县代码
          const grandchildren = children[child.code] || [];
          for (const gc of grandchildren) {
            matchCodes.add(gc.code);
          }
        }
      }

      // 按 region_code 精确匹配筛选
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
      defaultPath: `poi_data_${platform}_${
        new Date().toISOString().split("T")[0]
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
      // 传递筛选后的 ID 列表，确保导出数据与预览一致
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

  const renderRegion = (region: Region, indent: number = 0) => {
    const hasChildren = region.level !== "district";
    const isExpanded = expanded.has(region.code);
    const isSelected = selectedRegions.has(region.code);
    const regionChildren = children[region.code] || [];

    return (
      <div key={region.code}>
        <div
          className={`flex items-center gap-1 py-1 px-1 rounded text-xs transition-colors
                              ${
                                isSelected ? "bg-primary/10" : "hover:bg-accent"
                              }`}
          style={{ paddingLeft: `${indent * 12 + 4}px` }}
        >
          {hasChildren ? (
            <button
              onClick={() => toggleExpand(region.code)}
              className="p-0.5 hover:bg-accent rounded"
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
            onChange={() => {}}
            onClick={(e) => toggleSelectRegion(region.code, region.name, e)}
            className="w-3 h-3 cursor-pointer"
          />
          <span
            className="flex-1 truncate cursor-pointer"
            onClick={(e) => toggleSelectRegion(region.code, region.name, e)}
          >
            {region.name}
          </span>
        </div>
        {isExpanded &&
          regionChildren.map((child) => renderRegion(child, indent + 1))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">数据导出</h1>
          <p className="text-muted-foreground">
            先选择地区，然后查看和导出对应数据
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        {/* 左侧: 地区筛选 */}
        <Card className="w-52 shrink-0 overflow-hidden flex flex-col">
          <CardHeader className="py-2 px-3 shrink-0 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">选择地区</CardTitle>
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
          <CardContent className="flex-1 overflow-hidden p-0">
            <SimpleBar className="h-full p-1">
              {/* 显示全部选项 */}
              <div
                className={`flex items-center gap-2 py-2 px-2 mb-1 rounded text-xs border transition-colors cursor-pointer
                                          ${
                                            showAll
                                              ? "bg-primary/10 border-primary"
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
                  onChange={() => {}}
                  className="w-3 h-3 cursor-pointer"
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
              <CardHeader className="py-2 px-4 shrink-0 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">数据预览</CardTitle>
                    <select
                      value={platform}
                      onChange={(e) => setPlatform(e.target.value)}
                      className="px-2 py-1 text-sm border border-input bg-background rounded"
                    >
                      {Object.entries(platformNames).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setPage(1);
                        }}
                        placeholder="搜索名称或地址..."
                        className="pl-8 pr-3 py-1 text-sm border border-input bg-background rounded w-48
                                                         focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {filteredData.length.toLocaleString()} 条
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
                        <span className="text-muted-foreground px-1">
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
                    >
                      <Download className="w-4 h-4 mr-2" />
                      导出数据
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 overflow-auto p-0">
                {loading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredData.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium w-12">ID</th>
                        <th className="text-left p-2 font-medium">名称</th>
                        <th className="text-left p-2 font-medium">地址</th>
                        <th className="text-left p-2 font-medium w-20">类别</th>
                        <th className="text-left p-2 font-medium w-20">经度</th>
                        <th className="text-left p-2 font-medium w-20">纬度</th>
                        <th className="text-left p-2 font-medium w-16">平台</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedData.map((poi) => (
                        <tr
                          key={poi.id}
                          className="border-b border-border hover:bg-accent/50"
                        >
                          <td className="p-2 text-muted-foreground">
                            {poi.id}
                          </td>
                          <td
                            className="p-2 truncate max-w-[200px]"
                            title={poi.name}
                          >
                            {poi.name}
                          </td>
                          <td
                            className="p-2 truncate max-w-[200px] text-muted-foreground"
                            title={poi.address}
                          >
                            {poi.address || "-"}
                          </td>
                          <td className="p-2 text-muted-foreground">
                            {poi.category || "-"}
                          </td>
                          <td className="p-2 text-muted-foreground text-xs">
                            {poi.lon.toFixed(4)}
                          </td>
                          <td className="p-2 text-muted-foreground text-xs">
                            {poi.lat.toFixed(4)}
                          </td>
                          <td className="p-2">
                            <span className="px-1.5 py-0.5 bg-muted rounded text-xs">
                              {platformNames[poi.platform]?.substring(0, 2) ||
                                poi.platform}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                    <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
                    <p>所选地区暂无匹配数据</p>
                    <p className="text-xs mt-1">请尝试选择其他地区或平台</p>
                  </div>
                )}
              </CardContent>
            </>
          ) : (
            <CardContent className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <MapPin className="w-16 h-16 mb-4 opacity-20" />
              <p className="text-lg font-medium mb-2">请先选择地区</p>
              <p className="text-sm">在左侧地区列表中勾选要导出的地区</p>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 导出弹框 */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              导出数据
            </DialogTitle>
            <DialogDescription>
              选择导出格式，将导出 {filteredData.length.toLocaleString()} 条数据
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            {formats.map((f) => {
              const Icon = f.icon;
              return (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all
                                              ${
                                                format === f.id
                                                  ? "border-primary bg-primary/5"
                                                  : "border-border hover:border-primary/50"
                                              }`}
                >
                  <Icon
                    className={`w-5 h-5 ${
                      format === f.id ? "text-primary" : "text-muted-foreground"
                    }`}
                  />
                  <span
                    className={
                      format === f.id
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
            <Button onClick={handleExport} disabled={exporting}>
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
    </div>
  );
}
