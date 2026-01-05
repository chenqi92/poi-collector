// generate_regions.mjs - 生成行政区划数据
// 将省市区数据整合为统一 JSON 格式
// 数据来源: https://github.com/modood/Administrative-divisions-of-China

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 省份数据
const provinces = [{ "code": "11", "name": "北京市" }, { "code": "12", "name": "天津市" }, { "code": "13", "name": "河北省" }, { "code": "14", "name": "山西省" }, { "code": "15", "name": "内蒙古自治区" }, { "code": "21", "name": "辽宁省" }, { "code": "22", "name": "吉林省" }, { "code": "23", "name": "黑龙江省" }, { "code": "31", "name": "上海市" }, { "code": "32", "name": "江苏省" }, { "code": "33", "name": "浙江省" }, { "code": "34", "name": "安徽省" }, { "code": "35", "name": "福建省" }, { "code": "36", "name": "江西省" }, { "code": "37", "name": "山东省" }, { "code": "41", "name": "河南省" }, { "code": "42", "name": "湖北省" }, { "code": "43", "name": "湖南省" }, { "code": "44", "name": "广东省" }, { "code": "45", "name": "广西壮族自治区" }, { "code": "46", "name": "海南省" }, { "code": "50", "name": "重庆市" }, { "code": "51", "name": "四川省" }, { "code": "52", "name": "贵州省" }, { "code": "53", "name": "云南省" }, { "code": "54", "name": "西藏自治区" }, { "code": "61", "name": "陕西省" }, { "code": "62", "name": "甘肃省" }, { "code": "63", "name": "青海省" }, { "code": "64", "name": "宁夏回族自治区" }, { "code": "65", "name": "新疆维吾尔自治区" }];

async function main() {
    console.log('开始生成行政区划数据...');

    // 获取城市和区县数据
    const citiesResp = await fetch('https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/cities.json');
    const areasResp = await fetch('https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/areas.json');

    const cities = await citiesResp.json();
    const areas = await areasResp.json();

    console.log(`省份: ${provinces.length}, 城市: ${cities.length}, 区县: ${areas.length}`);

    // 构建统一格式
    const regions = [];

    // 添加省份
    for (const p of provinces) {
        regions.push({
            code: p.code,
            name: p.name,
            level: 'province',
            parentCode: null
        });
    }

    // 添加城市
    for (const c of cities) {
        regions.push({
            code: c.code,
            name: c.name,
            level: 'city',
            parentCode: c.provinceCode
        });
    }

    // 添加区县
    for (const a of areas) {
        regions.push({
            code: a.code,
            name: a.name,
            level: 'district',
            parentCode: a.cityCode
        });
    }

    console.log(`总计: ${regions.length} 条记录`);

    // 写入文件
    const outputPath = path.join(__dirname, '..', 'src-tauri', 'resources', 'regions.json');
    fs.writeFileSync(outputPath, JSON.stringify(regions, null, 2), 'utf-8');

    console.log(`已保存到: ${outputPath}`);
}

main().catch(console.error);
