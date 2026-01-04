
import sqlite3
import os

if os.path.exists('funing_poi.db'):
    conn = sqlite3.connect('funing_poi.db')
    cursor = conn.cursor()
    try:
        cursor.execute("PRAGMA table_info(pois)")
        columns = cursor.fetchall()
        print(f"Existing columns: {len(columns)}")
        for col in columns:
            print(col)
    except Exception as e:
        print(e)
    conn.close()
else:
    print("DB file not found")

print("-" * 20)
print("File check:")
with open('multi_collector.py', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if i < 50:
            print(f"{i+1}: {line.strip()}")
