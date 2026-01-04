// API基础路径
const API_BASE = '';

// 页面切换
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const page = item.dataset.page;
        switchPage(page);
    });
});

function switchPage(pageName) {
    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });

    // 切换页面
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.id === `page-${pageName}`);
    });

    // 加载页面数据
    if (pageName === 'dashboard') loadDashboard();
    if (pageName === 'settings') {
        loadApiKeys();
        loadRegionConfig();
    }
    if (pageName === 'collector') {
        loadCollectorStatus();
        loadCategories();
    }
}

// ============ 数据概览 ============

async function loadDashboard() {
    try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const data = await res.json();

        if (data.success) {
            document.getElementById('stat-total').textContent = formatNumber(data.total);
            document.getElementById('stat-tianditu').textContent = formatNumber(data.by_platform.tianditu || 0);
            document.getElementById('stat-amap').textContent = formatNumber(data.by_platform.amap || 0);
            document.getElementById('stat-baidu').textContent = formatNumber(data.by_platform.baidu || 0);

            // 渲染分类图表
            renderCategoryChart(data.by_category, data.total);
        }
    } catch (e) {
        console.error('加载统计失败:', e);
    }
}

function renderCategoryChart(categories, total) {
    const container = document.getElementById('category-chart');
    if (!categories || Object.keys(categories).length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#64748b;padding:40px;">暂无数据</p>';
        return;
    }

    const maxCount = Math.max(...Object.values(categories));
    let html = '';

    Object.entries(categories).slice(0, 10).forEach(([name, count]) => {
        const percent = (count / maxCount * 100).toFixed(1);
        html += `
            <div class="category-bar">
                <span class="label">${name}</span>
                <div class="bar">
                    <div class="fill" style="width: ${percent}%"></div>
                </div>
                <span class="count">${formatNumber(count)}</span>
            </div>
        `;
    });

    container.innerHTML = html;
}

// ============ API Key设置 (多Key支持) ============

async function loadApiKeys() {
    try {
        const res = await fetch(`${API_BASE}/api/keys`);
        const data = await res.json();

        if (data.success) {
            ['tianditu', 'amap', 'baidu'].forEach(platform => {
                renderKeyList(platform, data.keys[platform] || []);
            });
        }
    } catch (e) {
        console.error('加载API Key失败:', e);
    }
}

function renderKeyList(platform, keys) {
    const container = document.getElementById(`keylist-${platform}`);
    if (!container) return;

    if (keys.length === 0) {
        container.innerHTML = '<p style="color:#64748b;font-size:13px;padding:10px 0;">尚未配置API Key</p>';
        return;
    }

    container.innerHTML = keys.map((key, index) => `
        <div class="key-item">
            <div class="key-info">
                <div class="key-name">${key.name || `Key ${index + 1}`}</div>
                <div class="key-value">${key.api_key}</div>
            </div>
            <div class="key-status">
                ${key.is_active ? '<span class="badge active">启用</span>' : '<span class="badge inactive">禁用</span>'}
                ${key.quota_exhausted ? '<span class="badge exhausted">配额用尽</span>' : ''}
            </div>
            <div class="key-actions">
                <button onclick="toggleKeyActive('${platform}', ${key.id}, ${!key.is_active})">${key.is_active ? '禁用' : '启用'}</button>
                <button class="delete" onclick="deleteApiKey('${platform}', ${key.id})">删除</button>
            </div>
        </div>
    `).join('');
}

async function addApiKey(platform) {
    const input = document.getElementById(`key-${platform}`);
    const nameInput = document.getElementById(`keyname-${platform}`);
    const apiKey = input.value.trim();
    const name = nameInput ? nameInput.value.trim() : '';

    if (!apiKey) {
        alert('请输入API Key');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/keys/${platform}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, name: name })
        });

        const data = await res.json();
        if (data.success) {
            input.value = '';
            if (nameInput) nameInput.value = '';
            loadApiKeys();
        } else {
            alert(data.error || '添加失败');
        }
    } catch (e) {
        alert('网络错误');
    }
}

async function toggleKeyActive(platform, keyId, isActive) {
    try {
        await fetch(`${API_BASE}/api/keys/${platform}/${keyId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
        });
        loadApiKeys();
    } catch (e) {
        console.error('更新失败:', e);
    }
}

async function deleteApiKey(platform, keyId) {
    if (!confirm('确定要删除这个API Key吗？')) return;

    try {
        await fetch(`${API_BASE}/api/keys/${platform}/${keyId}`, {
            method: 'DELETE'
        });
        loadApiKeys();
    } catch (e) {
        console.error('删除失败:', e);
    }
}

function toggleKeyVisibility(platform) {
    const input = document.getElementById(`key-${platform}`);
    input.type = input.type === 'password' ? 'text' : 'password';
}

// ============ 区域配置 ============

let currentRegion = null;

async function loadRegionConfig() {
    try {
        // 加载当前区域配置
        const regionRes = await fetch(`${API_BASE}/api/region`);
        const regionData = await regionRes.json();

        if (regionData.success) {
            currentRegion = regionData.region;
            updateRegionDisplay(regionData.region);
        }

        // 加载预设区域列表
        const presetsRes = await fetch(`${API_BASE}/api/regions/presets`);
        const presetsData = await presetsRes.json();

        if (presetsData.success) {
            const select = document.getElementById('region-preset');
            select.innerHTML = '<option value="">-- 选择预设区域 --</option>' +
                presetsData.presets.map(p =>
                    `<option value="${p.id}" ${currentRegion && currentRegion.name === p.name ? 'selected' : ''}>${p.name} (${p.admin_code})</option>`
                ).join('');
        }
    } catch (e) {
        console.error('加载区域配置失败:', e);
    }
}

function updateRegionDisplay(region) {
    // 更新侧边栏副标题
    const subtitle = document.getElementById('current-region-name');
    if (subtitle) subtitle.textContent = region.name;

    // 更新采集页面显示
    const collectorRegion = document.getElementById('collector-region-name');
    if (collectorRegion) collectorRegion.textContent = region.name;

    // 更新设置页面显示
    const display = document.getElementById('region-current-display');
    if (display) {
        display.textContent = `${region.name} (代码: ${region.admin_code})`;
    }

    // 填充表单
    const nameInput = document.getElementById('region-name');
    const adminCodeInput = document.getElementById('region-admin-code');
    const cityCodeInput = document.getElementById('region-city-code');
    const minLonInput = document.getElementById('region-min-lon');
    const maxLonInput = document.getElementById('region-max-lon');
    const minLatInput = document.getElementById('region-min-lat');
    const maxLatInput = document.getElementById('region-max-lat');

    if (nameInput) nameInput.value = region.name;
    if (adminCodeInput) adminCodeInput.value = region.admin_code;
    if (cityCodeInput) cityCodeInput.value = region.city_code;
    if (minLonInput) minLonInput.value = region.bounds.min_lon;
    if (maxLonInput) maxLonInput.value = region.bounds.max_lon;
    if (minLatInput) minLatInput.value = region.bounds.min_lat;
    if (maxLatInput) maxLatInput.value = region.bounds.max_lat;
}

async function selectPresetRegion() {
    const select = document.getElementById('region-preset');
    const presetId = select.value;
    const status = document.getElementById('region-status');

    if (!presetId) return;

    try {
        const res = await fetch(`${API_BASE}/api/region`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset_id: presetId })
        });

        const data = await res.json();
        if (data.success) {
            status.textContent = '✓ ' + data.message;
            status.className = 'status success';
            currentRegion = data.region;
            updateRegionDisplay(data.region);
        } else {
            status.textContent = data.error || '切换失败';
            status.className = 'status error';
        }
    } catch (e) {
        status.textContent = '网络错误';
        status.className = 'status error';
    }
}

async function saveCustomRegion() {
    const status = document.getElementById('region-status');

    const regionData = {
        name: document.getElementById('region-name').value.trim(),
        admin_code: document.getElementById('region-admin-code').value.trim(),
        city_code: document.getElementById('region-city-code').value.trim(),
        bounds: {
            min_lon: parseFloat(document.getElementById('region-min-lon').value),
            max_lon: parseFloat(document.getElementById('region-max-lon').value),
            min_lat: parseFloat(document.getElementById('region-min-lat').value),
            max_lat: parseFloat(document.getElementById('region-max-lat').value)
        }
    };

    // 验证
    if (!regionData.name || !regionData.admin_code || !regionData.city_code) {
        status.textContent = '请填写创区名称、行政代码和城市代码';
        status.className = 'status error';
        return;
    }

    if (isNaN(regionData.bounds.min_lon) || isNaN(regionData.bounds.max_lon) ||
        isNaN(regionData.bounds.min_lat) || isNaN(regionData.bounds.max_lat)) {
        status.textContent = '请填写有效的边界坐标';
        status.className = 'status error';
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/region`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(regionData)
        });

        const data = await res.json();
        if (data.success) {
            status.textContent = '✓ ' + data.message;
            status.className = 'status success';
            currentRegion = data.region;
            updateRegionDisplay(data.region);
            // 重置预设选择
            document.getElementById('region-preset').value = '';
        } else {
            status.textContent = data.error || '保存失败';
            status.className = 'status error';
        }
    } catch (e) {
        status.textContent = '网络错误';
        status.className = 'status error';
    }
}

// ============ 数据采集 ============

let statusInterval = null;
let totalCategories = 9; // 默认类别数
let allCategories = []; // 所有类别列表

async function loadCategories() {
    try {
        const res = await fetch(`${API_BASE}/api/collector/categories`);
        const data = await res.json();

        if (data.success) {
            allCategories = data.categories;
            totalCategories = data.categories.length;

            // 渲染状态说明标签
            const container = document.getElementById('category-tags');
            container.innerHTML = data.categories.map(cat =>
                `<span class="category-tag" data-id="${cat.id}">${cat.name}</span>`
            ).join('');

            // 为每个平台渲染类别复选框
            ['tianditu', 'amap', 'baidu'].forEach(platform => {
                renderCategoryCheckboxes(platform, data.categories);
            });
        }
    } catch (e) {
        console.error('加载类别失败:', e);
    }
}

function renderCategoryCheckboxes(platform, categories) {
    const container = document.getElementById(`categories-${platform}`);
    if (!container) return;

    container.innerHTML = categories.map(cat => `
        <label class="category-checkbox checked">
            <input type="checkbox"
                   id="cat-${platform}-${cat.id}"
                   value="${cat.id}"
                   checked
                   onchange="updateCategoryCheckbox(this)">
            ${cat.name}
        </label>
    `).join('');
}

function updateCategoryCheckbox(checkbox) {
    const label = checkbox.parentElement;
    if (checkbox.checked) {
        label.classList.add('checked');
    } else {
        label.classList.remove('checked');
    }
    // 更新全选状态
    updateSelectAllState(checkbox);
}

function updateSelectAllState(checkbox) {
    // 从checkbox的id中提取platform
    const idParts = checkbox.id.split('-');
    const platform = idParts[1];

    const container = document.getElementById(`categories-${platform}`);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const selectAll = document.getElementById(`selectall-${platform}`);

    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    if (selectAll) selectAll.checked = allChecked;
}

function toggleAllCategories(platform) {
    const selectAll = document.getElementById(`selectall-${platform}`);
    const container = document.getElementById(`categories-${platform}`);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');

    checkboxes.forEach(cb => {
        cb.checked = selectAll.checked;
        updateCategoryCheckbox(cb);
    });
}

function getSelectedCategories(platform) {
    const container = document.getElementById(`categories-${platform}`);
    if (!container) return null;

    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);

    // 如果全选，返回null表示采集所有
    if (selected.length === allCategories.length) {
        return null;
    }
    return selected;
}

async function loadCollectorStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/collector/status`);
        const data = await res.json();

        if (data.success) {
            ['tianditu', 'amap', 'baidu'].forEach(platform => {
                updateCollectorUI(platform, data.statuses[platform]);
            });
        }
    } catch (e) {
        console.error('加载采集状态失败:', e);
    }
}

function updateCollectorUI(platform, status) {
    const statusEl = document.getElementById(`cstatus-${platform}`);
    const progressEl = document.getElementById(`cprogress-${platform}`);
    const progressTextEl = document.getElementById(`cprogress-text-${platform}`);
    const countEl = document.getElementById(`ccount-${platform}`);
    const infoEl = document.getElementById(`cinfo-${platform}`);
    const btnEl = document.getElementById(`cbtn-${platform}`);

    // 状态
    const statusMap = {
        'idle': '未开始',
        'running': '采集中',
        'paused': '已暂停',
        'completed': '已完成',
        'error': '出错'
    };
    statusEl.textContent = statusMap[status.status] || status.status;
    statusEl.className = `collector-status ${status.status}`;

    // 进度
    const completedCount = (status.completed_categories || []).length;
    const progress = (completedCount / totalCategories * 100).toFixed(0);
    progressEl.style.width = `${progress}%`;
    progressTextEl.textContent = `${completedCount} / ${totalCategories} 类别`;
    countEl.textContent = `已采集: ${formatNumber(status.total_collected || 0)}`;

    // 当前信息
    if (status.status === 'running' && status.current_category_id) {
        infoEl.textContent = `正在采集: ${status.current_category_id}`;
    } else if (status.status === 'paused' && status.current_category_id) {
        infoEl.textContent = `暂停于: ${status.current_category_id}`;
    } else if (status.status === 'error') {
        infoEl.textContent = `错误: ${status.error_message || '未知错误'}`;
    } else {
        infoEl.textContent = '';
    }

    // 按钮文字
    if (status.status === 'paused') {
        btnEl.textContent = '继续采集';
    } else if (status.status === 'running') {
        btnEl.textContent = '采集中...';
    } else {
        btnEl.textContent = '开始采集';
    }

    // 更新类别标签
    updateCategoryTags(platform, status);
}

function updateCategoryTags(platform, status) {
    const tags = document.querySelectorAll('.category-tag');
    tags.forEach(tag => {
        tag.classList.remove('completed', 'current');
        const id = tag.dataset.id;

        if ((status.completed_categories || []).includes(id)) {
            tag.classList.add('completed');
        } else if (status.current_category_id === id) {
            tag.classList.add('current');
        }
    });
}

async function startCollector(platform) {
    // 获取选中的类别
    const selectedCategories = getSelectedCategories(platform);

    if (selectedCategories && selectedCategories.length === 0) {
        alert('请至少选择一个采集类别');
        return;
    }

    try {
        const requestBody = {
            resume: true,
            categories: selectedCategories
        };

        const res = await fetch(`${API_BASE}/api/collector/${platform}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await res.json();
        if (data.success) {
            // 开始轮询状态
            startStatusPolling();
            loadCollectorStatus();
        } else {
            alert(data.error || '启动失败');
        }
    } catch (e) {
        alert('网络错误');
    }
}

async function stopCollector(platform) {
    try {
        await fetch(`${API_BASE}/api/collector/${platform}/stop`, { method: 'POST' });
        setTimeout(loadCollectorStatus, 500);
    } catch (e) {
        console.error('停止失败:', e);
    }
}

async function resetCollector(platform) {
    if (!confirm(`确定要重置 ${platform} 的采集进度吗？这将清除所有进度记录。`)) {
        return;
    }

    try {
        await fetch(`${API_BASE}/api/collector/${platform}/reset`, { method: 'POST' });
        loadCollectorStatus();
    } catch (e) {
        console.error('重置失败:', e);
    }
}

function startStatusPolling() {
    if (statusInterval) return;
    statusInterval = setInterval(loadCollectorStatus, 2000);
}

function stopStatusPolling() {
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
    }
}

// ============ 数据查询 ============

async function doSearch() {
    const query = document.getElementById('search-input').value.trim();
    const platform = document.getElementById('search-platform').value;
    const mode = document.getElementById('search-mode').value;
    const container = document.getElementById('search-results');

    if (!query) {
        container.innerHTML = '<p class="placeholder">请输入关键词进行搜索</p>';
        return;
    }

    container.innerHTML = '<p class="placeholder">搜索中...</p>';

    try {
        const params = new URLSearchParams({ q: query, platform, mode, limit: 50 });
        const res = await fetch(`${API_BASE}/api/search?${params}`);
        const data = await res.json();

        if (data.success && data.results.length > 0) {
            container.innerHTML = data.results.map(poi => `
                <div class="result-item">
                    <div class="result-main">
                        <div class="result-name">
                            ${poi.name}
                            <span class="result-platform ${poi.platform}">${platformName(poi.platform)}</span>
                        </div>
                        <div class="result-info">
                            ${poi.category || '未分类'} ${poi.address ? '· ' + poi.address : ''}
                        </div>
                    </div>
                    <div class="result-coords">${poi.lon.toFixed(6)}, ${poi.lat.toFixed(6)}</div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p class="placeholder">未找到匹配结果</p>';
        }
    } catch (e) {
        container.innerHTML = '<p class="placeholder">搜索失败，请重试</p>';
    }
}

// ============ 平台对比 ============

async function doCompare() {
    const query = document.getElementById('compare-input').value.trim();

    if (!query) {
        return;
    }

    ['tianditu', 'amap', 'baidu'].forEach(p => {
        document.getElementById(`compare-${p}`).innerHTML = '<p class="placeholder">搜索中...</p>';
    });

    try {
        const res = await fetch(`${API_BASE}/api/compare?q=${encodeURIComponent(query)}&limit=20`);
        const data = await res.json();

        if (data.success) {
            ['tianditu', 'amap', 'baidu'].forEach(platform => {
                const results = data.results[platform] || [];
                const container = document.getElementById(`compare-${platform}`);

                if (results.length > 0) {
                    container.innerHTML = results.map(poi => `
                        <div class="compare-item">
                            <div class="name">${poi.name}</div>
                            ${poi.address ? `<div class="address">${poi.address}</div>` : ''}
                            <div class="coords">${poi.lon.toFixed(6)}, ${poi.lat.toFixed(6)}</div>
                        </div>
                    `).join('') + `<div class="compare-count">共 ${results.length} 条结果</div>`;
                } else {
                    container.innerHTML = '<p class="placeholder">无结果</p>';
                }
            });
        }
    } catch (e) {
        console.error('对比搜索失败:', e);
    }
}

// ============ 工具函数 ============

function formatNumber(num) {
    if (num === undefined || num === null) return '-';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function platformName(platform) {
    const names = {
        'tianditu': '天地图',
        'amap': '高德',
        'baidu': '百度'
    };
    return names[platform] || platform;
}

// ============ 实时日志 ============

let logEventSource = null;

function switchLogPlatform() {
    const platform = document.getElementById('log-platform').value;
    const container = document.getElementById('log-content');

    // 关闭之前的连接
    if (logEventSource) {
        logEventSource.close();
        logEventSource = null;
    }

    if (!platform) {
        container.innerHTML = '<p class="log-placeholder">选择平台查看采集日志...</p>';
        return;
    }

    container.innerHTML = '<p class="log-placeholder">连接中...</p>';

    // 建立SSE连接
    logEventSource = new EventSource(`${API_BASE}/api/collector/${platform}/logs`);

    logEventSource.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);
            appendLog(data);
        } catch (e) {
            console.error('解析日志失败:', e);
        }
    };

    logEventSource.onerror = function () {
        container.innerHTML += '<p class="log-line error">连接断开</p>';
        logEventSource.close();
        logEventSource = null;
    };

    logEventSource.onopen = function () {
        container.innerHTML = '';
    };
}

function appendLog(log) {
    const container = document.getElementById('log-content');

    // 移除placeholder
    const placeholder = container.querySelector('.log-placeholder');
    if (placeholder) {
        placeholder.remove();
    }

    const line = document.createElement('div');
    line.className = 'log-line';

    // 检测错误/成功
    if (log.msg && (log.msg.includes('错误') || log.msg.includes('Error'))) {
        line.className += ' error';
    } else if (log.msg && (log.msg.includes('完成') || log.msg.includes('成功'))) {
        line.className += ' success';
    }

    line.innerHTML = `<span class="time">${log.time || ''}</span>${escapeHtml(log.msg || '')}`;
    container.appendChild(line);

    // 自动滚动到底部
    container.scrollTop = container.scrollHeight;

    // 限制日志数量
    while (container.children.length > 200) {
        container.removeChild(container.firstChild);
    }
}

function clearLogs() {
    const container = document.getElementById('log-content');
    container.innerHTML = '<p class="log-placeholder">日志已清空</p>';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============ 初始化 ============

document.addEventListener('DOMContentLoaded', () => {
    // 加载当前区域配置
    loadCurrentRegion();
    loadDashboard();

    // 当切换到采集页面时开始轮询
    const collectorObserver = new MutationObserver(() => {
        const collectorPage = document.getElementById('page-collector');
        if (collectorPage.classList.contains('active')) {
            startStatusPolling();
        } else {
            stopStatusPolling();
            // 关闭日志连接
            if (logEventSource) {
                logEventSource.close();
                logEventSource = null;
            }
        }
    });

    document.querySelectorAll('.page').forEach(page => {
        collectorObserver.observe(page, { attributes: true, attributeFilter: ['class'] });
    });
});

// 全局区域加载函数
async function loadCurrentRegion() {
    try {
        const res = await fetch(`${API_BASE}/api/region`);
        const data = await res.json();
        if (data.success) {
            currentRegion = data.region;
            updateRegionDisplay(data.region);
        }
    } catch (e) {
        console.error('加载当前区域失败:', e);
    }
}
