#!/usr/bin/env python3
"""
Generate app icons for Windows and macOS from SVG logo.
macOS icons require ~12.8% padding around the icon content.
"""

import subprocess
import sys
from pathlib import Path

# Check for required packages
try:
    from PIL import Image
    import cairosvg
except ImportError as e:
    print(f"Missing required package: {e}")
    print("Installing required packages...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow", "cairosvg"])
    from PIL import Image
    import cairosvg

def svg_to_png(svg_path: Path, png_path: Path, size: int = 1024):
    """Convert SVG to PNG at specified size."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=size,
        output_height=size
    )
    print(f"Created: {png_path}")

def add_padding(input_path: Path, output_path: Path, padding_percent: float = 12.8):
    """
    Add padding around the icon for macOS.
    Apple HIG recommends icon content be within ~80% of the canvas.
    This adds padding_percent% padding on each side.
    """
    img = Image.open(input_path)
    original_size = img.size[0]  # Assuming square
    
    # Calculate new size after scaling down
    scale_factor = (100 - 2 * padding_percent) / 100  # ~0.744 for 12.8%
    new_icon_size = int(original_size * scale_factor)
    
    # Resize the icon
    resized_icon = img.resize((new_icon_size, new_icon_size), Image.Resampling.LANCZOS)
    
    # Create new canvas with transparent background
    canvas = Image.new('RGBA', (original_size, original_size), (0, 0, 0, 0))
    
    # Calculate position to center the icon
    offset = (original_size - new_icon_size) // 2
    
    # Paste resized icon onto canvas
    canvas.paste(resized_icon, (offset, offset))
    
    canvas.save(output_path, 'PNG')
    print(f"Created with {padding_percent}% padding: {output_path}")

def main():
    # Paths
    project_root = Path(__file__).parent.parent
    src_tauri = project_root / "src-tauri"
    icons_dir = src_tauri / "icons"
    svg_path = src_tauri / "logo.svg"
    
    # Ensure icons directory exists
    icons_dir.mkdir(exist_ok=True)
    
    # Temp paths
    temp_png = icons_dir / "temp_1024.png"
    windows_icon_source = icons_dir / "icon.png"
    macos_icon_source = icons_dir / "icon_macos.png"
    
    print("=" * 50)
    print("POI Collector Icon Generator")
    print("=" * 50)
    
    # Step 1: Convert SVG to PNG (1024x1024)
    print("\n[1/4] Converting SVG to PNG...")
    svg_to_png(svg_path, temp_png, 1024)
    
    # Step 2: Create Windows icon source (no padding needed for Windows)
    print("\n[2/4] Creating Windows icon source...")
    img = Image.open(temp_png)
    img.save(windows_icon_source, 'PNG')
    print(f"Created: {windows_icon_source}")
    
    # Step 3: Create macOS icon source with 12.8% padding
    print("\n[3/4] Creating macOS icon source with 12.8% padding...")
    add_padding(temp_png, macos_icon_source, padding_percent=12.8)
    
    # Step 4: Generate all required icon sizes
    print("\n[4/4] Generating icon sizes...")
    
    # Windows/general icons (from non-padded source)
    windows_sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    for size in windows_sizes:
        img = Image.open(windows_icon_source)
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(icons_dir / f"{size}x{size}.png", 'PNG')
        print(f"  Created: {size}x{size}.png")
    
    # Special Tauri sizes
    img = Image.open(windows_icon_source)
    img.resize((128, 128), Image.Resampling.LANCZOS).save(icons_dir / "128x128.png", 'PNG')
    img.resize((256, 256), Image.Resampling.LANCZOS).save(icons_dir / "128x128@2x.png", 'PNG')
    print("  Created: 128x128.png and 128x128@2x.png")
    
    # Windows Store logos
    store_sizes = {
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, size in store_sizes.items():
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(icons_dir / name, 'PNG')
        print(f"  Created: {name}")
    
    # Clean up temp file
    temp_png.unlink()
    
    print("\n" + "=" * 50)
    print("Icon generation complete!")
    print("=" * 50)
    print(f"\nGenerated files in: {icons_dir}")
    print("\nNext steps:")
    print("  1. Use 'npx tauri icon' to generate .ico and .icns files")
    print("     - For Windows: npx tauri icon src-tauri/icons/icon.png")
    print("     - For macOS: Use icon_macos.png as source for .icns")
    print("\nNote: macOS icon has 12.8% padding per Apple HIG standards")

if __name__ == "__main__":
    main()
