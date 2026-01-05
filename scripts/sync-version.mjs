/**
 * Sync version across all project files from version.json
 * Usage: node scripts/sync-version.mjs [version]
 * 
 * If version is provided, it will update version.json first, then sync to all files.
 * If no version is provided, it will read from version.json and sync to all files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Files to sync
const FILES = {
    versionJson: path.join(projectRoot, 'version.json'),
    packageJson: path.join(projectRoot, 'package.json'),
    tauriConf: path.join(projectRoot, 'src-tauri', 'tauri.conf.json'),
    cargoToml: path.join(projectRoot, 'src-tauri', 'Cargo.toml'),
};

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function updateCargoToml(filePath, version) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Only replace the package version, not dependencies
    content = content.replace(
        /^(version\s*=\s*)"[^"]+"/m,
        `$1"${version}"`
    );
    fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
    const newVersion = process.argv[2];

    console.log('='.repeat(50));
    console.log('POI Collector Version Sync');
    console.log('='.repeat(50));

    // Read current version
    const versionData = readJson(FILES.versionJson);
    let version = versionData.version;

    if (newVersion) {
        // Validate version format (semver-like)
        if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
            console.error(`\n❌ Invalid version format: ${newVersion}`);
            console.error('   Expected format: X.Y.Z or X.Y.Z-suffix');
            process.exit(1);
        }
        version = newVersion;
        versionData.version = version;
        writeJson(FILES.versionJson, versionData);
        console.log(`\n✅ Updated version.json: ${version}`);
    } else {
        console.log(`\n📌 Using version from version.json: ${version}`);
    }

    // Sync to package.json
    const packageData = readJson(FILES.packageJson);
    const oldPackageVersion = packageData.version;
    packageData.version = version;
    writeJson(FILES.packageJson, packageData);
    console.log(`✅ Updated package.json: ${oldPackageVersion} → ${version}`);

    // Sync to tauri.conf.json
    const tauriData = readJson(FILES.tauriConf);
    const oldTauriVersion = tauriData.version;
    tauriData.version = version;
    writeJson(FILES.tauriConf, tauriData);
    console.log(`✅ Updated tauri.conf.json: ${oldTauriVersion} → ${version}`);

    // Sync to Cargo.toml
    const cargoContent = fs.readFileSync(FILES.cargoToml, 'utf8');
    const oldCargoVersion = cargoContent.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || 'unknown';
    updateCargoToml(FILES.cargoToml, version);
    console.log(`✅ Updated Cargo.toml: ${oldCargoVersion} → ${version}`);

    console.log('\n' + '='.repeat(50));
    console.log(`🎉 All files synced to version ${version}`);
    console.log('='.repeat(50));
    console.log('\nNote: Run `npm install` to update package-lock.json');
}

main();
