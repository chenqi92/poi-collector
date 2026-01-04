@echo off
chcp 65001 >nul
title POI管理系统
cd /d "%~dp0"

if "%1"=="" (
    python manage.py
) else (
    python manage.py %*
)

if errorlevel 1 (
    echo.
    echo 如果提示缺少依赖，请运行: pip install -r requirements.txt
    pause
)
