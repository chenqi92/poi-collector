import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Check, X, Search, MapPin, Loader2 } from 'lucide-react';

// 行政区划类型
interface Region {
    code: string;
    name: string;
    level: string; // province, city, district
    parentCode: string | null;
}

// 选中的区域项
interface SelectedRegion {
    code: string;
    name: string;
    level: string;
    fullPath: string; // 完整路径，如 "江苏省 > 盐城市 > 阜宁县"
}

interface RegionSelectorProps {
    value: SelectedRegion[];
    onChange: (regions: SelectedRegion[]) => void;
    maxSelections?: number; // 最大选择数量
    allowMultiLevel?: boolean; // 是否允许同时选择不同层级
}

export function RegionSelector({
    value,
    onChange,
    maxSelections = 100,
    allowMultiLevel: _allowMultiLevel = true
}: RegionSelectorProps) {
    const [provinces, setProvinces] = useState<Region[]>([]);
    const [citiesMap, setCitiesMap] = useState<Record<string, Region[]>>({});
    const [districtsMap, setDistrictsMap] = useState<Record<string, Region[]>>({});

    const [expandedProvinces, setExpandedProvinces] = useState<Set<string>>(new Set());
    const [expandedCities, setExpandedCities] = useState<Set<string>>(new Set());

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Region[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [loading, setLoading] = useState(true);

    // 加载省份数据
    useEffect(() => {
        const loadProvinces = async () => {
            try {
                const data = await invoke<Region[]>('get_provinces');
                setProvinces(data);
            } catch (e) {
                console.error('Failed to load provinces:', e);
            } finally {
                setLoading(false);
            }
        };
        loadProvinces();
    }, []);

    // 加载城市数据
    const loadCities = useCallback(async (provinceCode: string) => {
        if (citiesMap[provinceCode]) return;
        try {
            const data = await invoke<Region[]>('get_region_children', { parentCode: provinceCode });
            setCitiesMap(prev => ({ ...prev, [provinceCode]: data }));
        } catch (e) {
            console.error('Failed to load cities:', e);
        }
    }, [citiesMap]);

    // 加载区县数据
    const loadDistricts = useCallback(async (cityCode: string) => {
        if (districtsMap[cityCode]) return;
        try {
            const data = await invoke<Region[]>('get_region_children', { parentCode: cityCode });
            setDistrictsMap(prev => ({ ...prev, [cityCode]: data }));
        } catch (e) {
            console.error('Failed to load districts:', e);
        }
    }, [districtsMap]);

    // 搜索区划
    const handleSearch = useCallback(async (query: string) => {
        setSearchQuery(query);
        if (!query.trim()) {
            setSearchResults([]);
            return;
        }
        setIsSearching(true);
        try {
            const data = await invoke<Region[]>('search_regions', { query: query.trim() });
            setSearchResults(data);
        } catch (e) {
            console.error('Failed to search regions:', e);
        } finally {
            setIsSearching(false);
        }
    }, []);

    // 切换省份展开
    const toggleProvince = async (provinceCode: string) => {
        const newExpanded = new Set(expandedProvinces);
        if (newExpanded.has(provinceCode)) {
            newExpanded.delete(provinceCode);
        } else {
            newExpanded.add(provinceCode);
            await loadCities(provinceCode);
        }
        setExpandedProvinces(newExpanded);
    };

    // 切换城市展开
    const toggleCity = async (cityCode: string) => {
        const newExpanded = new Set(expandedCities);
        if (newExpanded.has(cityCode)) {
            newExpanded.delete(cityCode);
        } else {
            newExpanded.add(cityCode);
            await loadDistricts(cityCode);
        }
        setExpandedCities(newExpanded);
    };

    // 构建完整路径
    const buildFullPath = (region: Region): string => {
        if (region.level === 'province') {
            return region.name;
        }
        if (region.level === 'city') {
            const province = provinces.find(p => p.code === region.parentCode);
            return province ? `${province.name} > ${region.name}` : region.name;
        }
        if (region.level === 'district') {
            // 需要找到城市和省份
            for (const [cityCode, districts] of Object.entries(districtsMap)) {
                if (districts.some(d => d.code === region.code)) {
                    const city = Object.values(citiesMap).flat().find(c => c.code === cityCode);
                    if (city) {
                        const province = provinces.find(p => p.code === city.parentCode);
                        return province
                            ? `${province.name} > ${city.name} > ${region.name}`
                            : `${city.name} > ${region.name}`;
                    }
                }
            }
        }
        return region.name;
    };

    // 检查是否已选中
    const isSelected = (code: string) => value.some(r => r.code === code);

    // 选中/取消选中区域
    const toggleSelection = (region: Region) => {
        if (isSelected(region.code)) {
            onChange(value.filter(r => r.code !== region.code));
        } else {
            if (value.length >= maxSelections) return;
            const newRegion: SelectedRegion = {
                code: region.code,
                name: region.name,
                level: region.level,
                fullPath: buildFullPath(region),
            };
            onChange([...value, newRegion]);
        }
    };

    // 移除选中项
    const removeSelection = (code: string) => {
        onChange(value.filter(r => r.code !== code));
    };

    // 清空所有选中
    const clearAll = () => {
        onChange([]);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                <span className="ml-2 text-gray-500">加载行政区划数据...</span>
            </div>
        );
    }

    return (
        <div className="region-selector">
            {/* 搜索框 */}
            <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="搜索省市区..."
                    className="w-full pl-10 pr-4 py-2 bg-gray-800/50 border border-gray-700 rounded-lg 
                             text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                {isSearching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
                )}
            </div>

            {/* 已选区域标签 */}
            {value.length > 0 && (
                <div className="mb-4 p-3 bg-gray-800/30 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-gray-400">
                            已选择 {value.length} 个区域
                        </span>
                        <button
                            onClick={clearAll}
                            className="text-xs text-red-400 hover:text-red-300"
                        >
                            清空全部
                        </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {value.map(region => (
                            <span
                                key={region.code}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-blue-500/20 
                                         text-blue-300 text-sm rounded-md"
                            >
                                <MapPin className="w-3 h-3" />
                                {region.name}
                                <button
                                    onClick={() => removeSelection(region.code)}
                                    className="ml-1 hover:text-red-400"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* 搜索结果 */}
            {searchQuery && searchResults.length > 0 && (
                <div className="mb-4 max-h-48 overflow-y-auto border border-gray-700 rounded-lg">
                    {searchResults.map(region => (
                        <div
                            key={region.code}
                            onClick={() => toggleSelection(region)}
                            className={`flex items-center justify-between p-2 cursor-pointer
                                      hover:bg-gray-700/50 border-b border-gray-700/50 last:border-0
                                      ${isSelected(region.code) ? 'bg-blue-500/10' : ''}`}
                        >
                            <div>
                                <span className="text-white">{region.name}</span>
                                <span className="ml-2 text-xs text-gray-500">
                                    {region.level === 'province' ? '省级' :
                                        region.level === 'city' ? '市级' : '区县'}
                                </span>
                            </div>
                            {isSelected(region.code) && (
                                <Check className="w-4 h-4 text-blue-500" />
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* 树形列表 */}
            {!searchQuery && (
                <div className="max-h-80 overflow-y-auto border border-gray-700 rounded-lg">
                    {provinces.map(province => (
                        <div key={province.code} className="border-b border-gray-700/50 last:border-0">
                            {/* 省级 */}
                            <div className="flex items-center">
                                <button
                                    onClick={() => toggleProvince(province.code)}
                                    className="p-2 hover:bg-gray-700/30"
                                >
                                    {expandedProvinces.has(province.code) ? (
                                        <ChevronDown className="w-4 h-4 text-gray-400" />
                                    ) : (
                                        <ChevronRight className="w-4 h-4 text-gray-400" />
                                    )}
                                </button>
                                <div
                                    onClick={() => toggleSelection(province)}
                                    className={`flex-1 flex items-center justify-between p-2 cursor-pointer
                                              hover:bg-gray-700/30 ${isSelected(province.code) ? 'bg-blue-500/10' : ''}`}
                                >
                                    <span className="text-white font-medium">{province.name}</span>
                                    {isSelected(province.code) && (
                                        <Check className="w-4 h-4 text-blue-500" />
                                    )}
                                </div>
                            </div>

                            {/* 市级展开 */}
                            {expandedProvinces.has(province.code) && citiesMap[province.code] && (
                                <div className="ml-6 border-l border-gray-700/50">
                                    {citiesMap[province.code].map(city => (
                                        <div key={city.code}>
                                            <div className="flex items-center">
                                                <button
                                                    onClick={() => toggleCity(city.code)}
                                                    className="p-2 hover:bg-gray-700/30"
                                                >
                                                    {expandedCities.has(city.code) ? (
                                                        <ChevronDown className="w-4 h-4 text-gray-400" />
                                                    ) : (
                                                        <ChevronRight className="w-4 h-4 text-gray-400" />
                                                    )}
                                                </button>
                                                <div
                                                    onClick={() => toggleSelection(city)}
                                                    className={`flex-1 flex items-center justify-between p-2 cursor-pointer
                                                              hover:bg-gray-700/30 ${isSelected(city.code) ? 'bg-blue-500/10' : ''}`}
                                                >
                                                    <span className="text-gray-200">{city.name}</span>
                                                    {isSelected(city.code) && (
                                                        <Check className="w-4 h-4 text-blue-500" />
                                                    )}
                                                </div>
                                            </div>

                                            {/* 区县展开 */}
                                            {expandedCities.has(city.code) && districtsMap[city.code] && (
                                                <div className="ml-6 border-l border-gray-700/50">
                                                    {districtsMap[city.code].map(district => (
                                                        <div
                                                            key={district.code}
                                                            onClick={() => toggleSelection(district)}
                                                            className={`flex items-center justify-between p-2 pl-4 cursor-pointer
                                                                      hover:bg-gray-700/30 ${isSelected(district.code) ? 'bg-blue-500/10' : ''}`}
                                                        >
                                                            <span className="text-gray-300">{district.name}</span>
                                                            {isSelected(district.code) && (
                                                                <Check className="w-4 h-4 text-blue-500" />
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export type { Region, SelectedRegion };
