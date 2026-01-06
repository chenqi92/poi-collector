#!/usr/bin/env node
/**
 * 版本更新脚本
 * 用法: node scripts/bump-version.js [patch|minor|major|<version>]
 * 
 * 同步更新以下文件的版本号:
 * - package.json
 * - version.json
 * - src-tauri/tauri.conf.json
 * - src-tauri/Cargo.toml
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FILES = {
    'package.json': {
        type: 'json',
        path: path.join(ROOT, 'package.json'),
        key: 'version'
    },
    'version.json': {
        type: 'json',
        path: path.join(ROOT, 'version.json'),
        key: 'version'
    },
    'tauri.conf.json': {
        type: 'json',
        path: path.join(ROOT, 'src-tauri', 'tauri.conf.json'),
        key: 'version'
    },
    'Cargo.toml': {
        type: 'toml',
        path: path.join(ROOT, 'src-tauri', 'Cargo.toml'),
        regex: /^version\s*=\s*"([^"]+)"/m
    }
};

function parseVersion(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) throw new Error(`Invalid version format: ${version}`);
    return {
        major: parseInt(match[1]),
        minor: parseInt(match[2]),
        patch: parseInt(match[3])
    };
}

function bumpVersion(current, type) {
    const v = parseVersion(current);
    switch (type) {
        case 'patch':
            v.patch++;
            break;
        case 'minor':
            v.minor++;
            v.patch = 0;
            break;
        case 'major':
            v.major++;
            v.minor = 0;
            v.patch = 0;
            break;
        default:
            // 直接使用传入的版本号
            return type;
    }
    return `${v.major}.${v.minor}.${v.patch}`;
}

function getCurrentVersion() {
    const pkg = JSON.parse(fs.readFileSync(FILES['package.json'].path, 'utf8'));
    return pkg.version;
}

function updateJsonFile(filePath, key, newVersion) {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const oldVersion = content[key];
    content[key] = newVersion;
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
    return oldVersion;
}

function updateTomlFile(filePath, regex, newVersion) {
    let content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(regex);
    const oldVersion = match ? match[1] : null;
    content = content.replace(regex, `version = "${newVersion}"`);
    fs.writeFileSync(filePath, content);
    return oldVersion;
}

function main() {
    const arg = process.argv[2];

    if (!arg) {
        console.log('用法: node scripts/bump-version.js [patch|minor|major|<version>]');
        console.log('');
        console.log('示例:');
        console.log('  node scripts/bump-version.js patch   # 0.2.0 -> 0.2.1');
        console.log('  node scripts/bump-version.js minor   # 0.2.0 -> 0.3.0');
        console.log('  node scripts/bump-version.js major   # 0.2.0 -> 1.0.0');
        console.log('  node scripts/bump-version.js 1.0.0   # -> 1.0.0');
        process.exit(1);
    }

    const currentVersion = getCurrentVersion();
    const newVersion = bumpVersion(currentVersion, arg);

    console.log(`版本更新: ${currentVersion} -> ${newVersion}\n`);

    for (const [name, config] of Object.entries(FILES)) {
        if (!fs.existsSync(config.path)) {
            console.log(`  ⚠ ${name}: 文件不存在，跳过`);
            continue;
        }

        try {
            if (config.type === 'json') {
                updateJsonFile(config.path, config.key, newVersion);
            } else if (config.type === 'toml') {
                updateTomlFile(config.path, config.regex, newVersion);
            }
            console.log(`  ✓ ${name}`);
        } catch (e) {
            console.log(`  ✗ ${name}: ${e.message}`);
        }
    }

    console.log(`\n完成! 新版本: ${newVersion}`);
}

main();
