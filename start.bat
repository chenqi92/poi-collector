@echo off
chcp 65001 >nul
title POI管理系统 - 启动服务
cd /d "%~dp0"

echo ====================================
echo   阜宁县POI管理系统
echo ====================================
echo.

echo [启动] 正在启动Web服务...
echo [访问] http://localhost:5000
echo.
echo 按 Ctrl+C 停止服务
echo.

python.exe web_server.py -p 5000

if errorlevel 1 (
    echo.
    echo [错误] 启动失败，请检查:
    echo   1. Python是否已安装并加入PATH
    echo   2. 依赖是否已安装: pip install -r requirements.txt
    pause
)
