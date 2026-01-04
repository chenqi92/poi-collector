#!/usr/bin/env python3
"""诊断脚本"""
import sys
print(f"Python版本: {sys.version}")
print(f"当前目录: {sys.path}")
print()

print("测试1: 导入标准库...")
try:
    import sqlite3
    import json
    from pathlib import Path
    print("  OK: 标准库正常")
except Exception as e:
    print(f"  错误: {e}")

print("测试2: 导入Flask...")
try:
    from flask import Flask
    print("  OK: Flask正常")
except Exception as e:
    print(f"  错误: {e}")

print("测试3: 导入flask_cors...")
try:
    from flask_cors import CORS
    print("  OK: flask_cors正常")
except Exception as e:
    print(f"  错误: {e}")

print("测试4: 导入multi_database...")
try:
    from multi_database import MultiPlatformDatabase, Platform, MatchMode
    print("  OK: multi_database正常")
except Exception as e:
    print(f"  错误: {e}")

print("测试5: 导入multi_collector...")
try:
    from multi_collector import create_collector, init_database, POI_CATEGORIES
    print("  OK: multi_collector正常")
except Exception as e:
    print(f"  错误: {e}")

print("测试6: 导入web_server...")
try:
    import web_server
    print("  OK: web_server正常")
except Exception as e:
    print(f"  错误: {e}")

print()
print("诊断完成")
input("按Enter退出...")
