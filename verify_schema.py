
import os
import sqlite3
import shutil
from multi_collector import init_database

print("Removing DB...")
if os.path.exists('funing_poi.db'):
    try:
        os.remove('funing_poi.db')
        print("DB removed")
    except Exception as e:
        print(f"Failed to remove DB: {e}")

if os.path.exists('__pycache__'):
    try:
        shutil.rmtree('__pycache__')
        print("Cache removed")
    except Exception as e:
        print(f"Failed to remove cache: {e}")

print("Initializing DB...")
try:
    init_database('funing_poi.db')
    print("Init called")
except Exception as e:
    print(f"Init failed: {e}")

if os.path.exists('funing_poi.db'):
    conn = sqlite3.connect('funing_poi.db')
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(pois)")
    cols = cursor.fetchall()
    print(f"Columns: {len(cols)}")
    for c in cols:
        print(c)
    conn.close()
else:
    print("DB not created")
