/**
 * Generate app icons for Windows and macOS from SVG logo.
 * macOS icons require ~12.8% padding around the icon content (Apple HIG).
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcTauri = path.join(__dirname, '..', 'src-tauri');
const iconsDir = path.join(srcTauri, 'icons');
const svgPath = path.join(srcTauri, 'logo.svg');

// Ensure icons directory exists
if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
}

console.log('='.repeat(50));
console.log('POI Collector Icon Generator');
console.log('='.repeat(50));

// Step 1: Create base 1024x1024 PNG from SVG
console.log('\n[1/3] Converting SVG to PNG...');
const basePng = await sharp(svgPath)
    .resize(1024, 1024)
    .png()
    .toBuffer();

// Save base icon (for Windows - no padding needed)
await sharp(basePng).toFile(path.join(iconsDir, 'icon.png'));
console.log('  Created: icon.png (1024x1024, no padding)');

// Step 2: Create macOS version with 12.8% padding
console.log('\n[2/3] Creating macOS icon with 12.8% padding...');
const paddingPercent = 12.8;
const scaleFactor = (100 - 2 * paddingPercent) / 100; // ~0.744
const newIconSize = Math.floor(1024 * scaleFactor); // ~762
const offset = Math.floor((1024 - newIconSize) / 2); // ~131

// Resize icon content smaller
const scaledIcon = await sharp(basePng)
    .resize(newIconSize, newIconSize, { fit: 'contain' })
    .toBuffer();

// Create transparent canvas and composite the scaled icon centered
const macosIcon = await sharp({
    create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
})
    .composite([{
        input: scaledIcon,
        left: offset,
        top: offset
    }])
    .png()
    .toFile(path.join(iconsDir, 'icon_macos.png'));

console.log(`  Created: icon_macos.png (1024x1024, with ${paddingPercent}% padding)`);

// Step 3: Generate all required icon sizes
console.log('\n[3/3] Generating icon sizes...');

// Standard sizes for Tauri
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const size of sizes) {
    await sharp(basePng)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, `${size}x${size}.png`));
    console.log(`  Created: ${size}x${size}.png`);
}

// Tauri special sizes
await sharp(basePng).resize(128, 128).png().toFile(path.join(iconsDir, '128x128.png'));
await sharp(basePng).resize(256, 256).png().toFile(path.join(iconsDir, '128x128@2x.png'));
console.log('  Created: 128x128.png and 128x128@2x.png');

// Windows Store logos
const storeLogos = {
    'Square30x30Logo.png': 30,
    'Square44x44Logo.png': 44,
    'Square71x71Logo.png': 71,
    'Square89x89Logo.png': 89,
    'Square107x107Logo.png': 107,
    'Square142x142Logo.png': 142,
    'Square150x150Logo.png': 150,
    'Square284x284Logo.png': 284,
    'Square310x310Logo.png': 310,
    'StoreLogo.png': 50,
};

for (const [name, size] of Object.entries(storeLogos)) {
    await sharp(basePng)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, name));
    console.log(`  Created: ${name}`);
}

console.log('\n' + '='.repeat(50));
console.log('PNG icons generated successfully!');
console.log('='.repeat(50));
console.log(`\nGenerated files in: ${iconsDir}`);
console.log('\nNext: Running Tauri icon command to generate .ico and .icns...');
