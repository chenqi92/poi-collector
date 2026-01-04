#!/usr/bin/env python3
"""
POI管理系统 - 交互式管理脚本
支持启动、停止、重启服务，查看状态等操作
"""
import os
import sys
import signal
import subprocess
import time
import json
import socket
import requests
from pathlib import Path
from typing import Optional

# 配置
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5000
DB_FILE = "funing_poi.db"
PID_FILE = "server.pid"
LOG_FILE = "server.log"

# 颜色输出（Windows支持）
try:
    import colorama
    colorama.init()
    COLORS = {
        'green': '\033[92m',
        'red': '\033[91m',
        'yellow': '\033[93m',
        'blue': '\033[94m',
        'cyan': '\033[96m',
        'reset': '\033[0m',
        'bold': '\033[1m'
    }
except ImportError:
    COLORS = {k: '' for k in ['green', 'red', 'yellow', 'blue', 'cyan', 'reset', 'bold']}


def color(text: str, color_name: str) -> str:
    return f"{COLORS.get(color_name, '')}{text}{COLORS['reset']}"


def print_header():
    """打印标题"""
    print()
    print(color("=" * 50, 'cyan'))
    print(color("  阜宁县POI管理系统 - 服务管理工具", 'bold'))
    print(color("=" * 50, 'cyan'))
    print()


def print_menu():
    """打印菜单"""
    print(color("可用命令:", 'bold'))
    print(f"  {color('1', 'green')} | {color('start', 'green')}    - 启动Web服务")
    print(f"  {color('2', 'green')} | {color('stop', 'green')}     - 停止Web服务")
    print(f"  {color('3', 'green')} | {color('restart', 'green')}  - 重启Web服务")
    print(f"  {color('4', 'green')} | {color('status', 'green')}   - 查看服务状态")
    print(f"  {color('5', 'green')} | {color('logs', 'green')}     - 查看最近日志")
    print(f"  {color('6', 'green')} | {color('stats', 'green')}    - 查看数据统计")
    print(f"  {color('7', 'green')} | {color('collect', 'green')}  - 管理数据采集")
    print(f"  {color('8', 'green')} | {color('config', 'green')}   - 配置管理")
    print(f"  {color('0', 'red')} | {color('quit', 'red')}     - 退出")
    print()


def is_port_in_use(port: int) -> bool:
    """检查端口是否被占用"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


def get_server_pid() -> Optional[int]:
    """获取服务器PID"""
    pid_path = Path(PID_FILE)
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            # 检查进程是否存在
            if sys.platform == 'win32':
                result = subprocess.run(['tasklist', '/FI', f'PID eq {pid}'],
                                       capture_output=True, text=True)
                if str(pid) in result.stdout:
                    return pid
            else:
                os.kill(pid, 0)
                return pid
        except (ValueError, OSError, ProcessLookupError):
            pass
        pid_path.unlink(missing_ok=True)
    return None


def check_service_health(port: int) -> dict:
    """检查服务健康状态"""
    try:
        resp = requests.get(f"http://127.0.0.1:{port}/api/health", timeout=5)
        return resp.json()
    except:
        return {"success": False, "status": "unreachable"}


def start_server(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, background: bool = True):
    """启动服务器"""
    pid = get_server_pid()
    if pid:
        print(color(f"服务已在运行中 (PID: {pid})", 'yellow'))
        return False

    if is_port_in_use(port):
        print(color(f"端口 {port} 已被占用", 'red'))
        return False

    print(f"正在启动服务... (端口: {port})")

    if background:
        # 后台运行
        if sys.platform == 'win32':
            # Windows: 使用pythonw或start命令
            log_path = Path(LOG_FILE).absolute()
            cmd = f'start /B python web_server.py -H {host} -p {port} > "{log_path}" 2>&1'
            process = subprocess.Popen(cmd, shell=True, cwd=Path(__file__).parent)

            # 等待服务启动
            for _ in range(10):
                time.sleep(0.5)
                if is_port_in_use(port):
                    # 尝试获取实际PID
                    result = subprocess.run(
                        f'netstat -ano | findstr ":{port}"',
                        shell=True, capture_output=True, text=True
                    )
                    for line in result.stdout.strip().split('\n'):
                        if 'LISTENING' in line:
                            parts = line.split()
                            if parts:
                                pid = int(parts[-1])
                                Path(PID_FILE).write_text(str(pid))
                                break
                    break

        else:
            # Unix: 使用nohup
            log_path = Path(LOG_FILE).absolute()
            cmd = f'nohup python web_server.py -H {host} -p {port} > {log_path} 2>&1 &'
            subprocess.Popen(cmd, shell=True, cwd=Path(__file__).parent)

            for _ in range(10):
                time.sleep(0.5)
                if is_port_in_use(port):
                    break

        if is_port_in_use(port):
            print(color(f"服务启动成功!", 'green'))
            print(f"访问地址: http://127.0.0.1:{port}")
            return True
        else:
            print(color("服务启动失败，请检查日志", 'red'))
            return False
    else:
        # 前台运行
        os.system(f'python web_server.py -H {host} -p {port}')
        return True


def stop_server():
    """停止服务器"""
    pid = get_server_pid()

    if pid:
        print(f"正在停止服务 (PID: {pid})...")
        try:
            if sys.platform == 'win32':
                subprocess.run(['taskkill', '/F', '/PID', str(pid)],
                              capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
                time.sleep(1)
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

            Path(PID_FILE).unlink(missing_ok=True)
            print(color("服务已停止", 'green'))
            return True
        except Exception as e:
            print(color(f"停止失败: {e}", 'red'))
            return False

    # 尝试通过端口查找并停止
    if is_port_in_use(DEFAULT_PORT):
        print(f"发现端口 {DEFAULT_PORT} 被占用，尝试停止...")
        if sys.platform == 'win32':
            result = subprocess.run(
                f'netstat -ano | findstr ":{DEFAULT_PORT}"',
                shell=True, capture_output=True, text=True
            )
            for line in result.stdout.strip().split('\n'):
                if 'LISTENING' in line:
                    parts = line.split()
                    if parts:
                        pid = int(parts[-1])
                        subprocess.run(['taskkill', '/F', '/PID', str(pid)],
                                       capture_output=True)
                        print(color("服务已停止", 'green'))
                        return True

    print(color("服务未运行", 'yellow'))
    return False


def restart_server():
    """重启服务器"""
    print("正在重启服务...")
    stop_server()
    time.sleep(1)
    return start_server()


def show_status():
    """显示服务状态"""
    print(color("\n服务状态", 'bold'))
    print("-" * 40)

    pid = get_server_pid()
    port_used = is_port_in_use(DEFAULT_PORT)

    if pid and port_used:
        health = check_service_health(DEFAULT_PORT)
        print(f"状态: {color('运行中', 'green')}")
        print(f"PID: {pid}")
        print(f"端口: {DEFAULT_PORT}")
        print(f"访问: http://127.0.0.1:{DEFAULT_PORT}")
        if health.get('success'):
            print(f"数据库: {health.get('database', 'N/A')}")
            print(f"POI总数: {health.get('total_pois', 'N/A')}")
    elif port_used:
        print(f"状态: {color('端口被占用', 'yellow')}")
        print(f"端口: {DEFAULT_PORT}")
    else:
        print(f"状态: {color('未运行', 'red')}")

    # 检查数据库文件
    db_path = Path(DB_FILE)
    if db_path.exists():
        size_mb = db_path.stat().st_size / (1024 * 1024)
        print(f"数据库: {db_path} ({size_mb:.2f} MB)")
    else:
        print(f"数据库: {color('不存在', 'yellow')}")

    print()


def show_logs(lines: int = 30):
    """显示最近日志"""
    log_path = Path(LOG_FILE)
    if not log_path.exists():
        print(color("日志文件不存在", 'yellow'))
        return

    print(color(f"\n最近 {lines} 行日志:", 'bold'))
    print("-" * 50)

    with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
        all_lines = f.readlines()
        for line in all_lines[-lines:]:
            print(line.rstrip())

    print()


def show_stats():
    """显示数据统计"""
    if not is_port_in_use(DEFAULT_PORT):
        print(color("服务未运行，无法获取统计", 'yellow'))
        return

    try:
        resp = requests.get(f"http://127.0.0.1:{DEFAULT_PORT}/api/stats", timeout=10)
        data = resp.json()

        if data.get('success'):
            print(color("\n数据统计", 'bold'))
            print("-" * 40)
            print(f"总数据量: {color(str(data.get('total', 0)), 'green')}")
            print()
            print("各平台数据:")

            for platform, count in data.get('by_platform', {}).items():
                name_map = {'tianditu': '天地图', 'amap': '高德地图', 'baidu': '百度地图'}
                name = name_map.get(platform, platform)
                print(f"  {name}: {count}")

            print()
            print("分类统计 (前10):")
            categories = list(data.get('by_category', {}).items())[:10]
            for cat, count in categories:
                print(f"  {cat}: {count}")

            print()

    except Exception as e:
        print(color(f"获取统计失败: {e}", 'red'))


def manage_collectors():
    """管理数据采集"""
    if not is_port_in_use(DEFAULT_PORT):
        print(color("服务未运行，请先启动服务", 'yellow'))
        return

    while True:
        print(color("\n采集管理", 'bold'))
        print("-" * 40)

        # 获取采集器状态
        try:
            resp = requests.get(f"http://127.0.0.1:{DEFAULT_PORT}/api/collector/status", timeout=10)
            data = resp.json()

            if data.get('success'):
                statuses = data.get('statuses', {})
                name_map = {'tianditu': '天地图', 'amap': '高德', 'baidu': '百度'}
                status_map = {
                    'idle': '未开始',
                    'running': color('采集中', 'green'),
                    'paused': color('已暂停', 'yellow'),
                    'completed': color('已完成', 'cyan'),
                    'error': color('出错', 'red')
                }

                for platform, status in statuses.items():
                    name = name_map.get(platform, platform)
                    st = status_map.get(status.get('status', 'idle'), status.get('status'))
                    count = status.get('total_collected', 0)
                    print(f"  {name}: {st} (已采集: {count})")

        except Exception as e:
            print(color(f"获取状态失败: {e}", 'red'))

        print()
        print("操作:")
        print("  1. 启动天地图采集")
        print("  2. 启动高德采集")
        print("  3. 启动百度采集")
        print("  4. 停止所有采集")
        print("  5. 重置采集进度")
        print("  0. 返回主菜单")
        print()

        choice = input("请选择: ").strip()

        if choice == '0':
            break
        elif choice in ['1', '2', '3']:
            platforms = ['tianditu', 'amap', 'baidu']
            platform = platforms[int(choice) - 1]
            try:
                resp = requests.post(
                    f"http://127.0.0.1:{DEFAULT_PORT}/api/collector/{platform}/start",
                    json={"resume": True},
                    timeout=10
                )
                result = resp.json()
                if result.get('success'):
                    print(color(f"{platform} 采集已启动", 'green'))
                else:
                    print(color(f"启动失败: {result.get('error', '未知错误')}", 'red'))
            except Exception as e:
                print(color(f"请求失败: {e}", 'red'))

        elif choice == '4':
            for platform in ['tianditu', 'amap', 'baidu']:
                try:
                    requests.post(
                        f"http://127.0.0.1:{DEFAULT_PORT}/api/collector/{platform}/stop",
                        timeout=5
                    )
                except:
                    pass
            print(color("已发送停止命令", 'green'))

        elif choice == '5':
            confirm = input("确定要重置所有采集进度吗? (y/N): ").strip().lower()
            if confirm == 'y':
                for platform in ['tianditu', 'amap', 'baidu']:
                    try:
                        requests.post(
                            f"http://127.0.0.1:{DEFAULT_PORT}/api/collector/{platform}/reset",
                            timeout=5
                        )
                    except:
                        pass
                print(color("进度已重置", 'green'))

        time.sleep(1)


def manage_config():
    """配置管理"""
    if not is_port_in_use(DEFAULT_PORT):
        print(color("服务未运行，请先启动服务", 'yellow'))
        return

    print(color("\n配置管理", 'bold'))
    print("-" * 40)

    try:
        resp = requests.get(f"http://127.0.0.1:{DEFAULT_PORT}/api/keys", timeout=10)
        data = resp.json()

        if data.get('success'):
            configured = data.get('configured', [])
            print("API Key配置状态:")
            for platform in ['tianditu', 'amap', 'baidu']:
                name_map = {'tianditu': '天地图', 'amap': '高德地图', 'baidu': '百度地图'}
                name = name_map.get(platform, platform)
                if platform in configured:
                    print(f"  {name}: {color('已配置', 'green')}")
                else:
                    print(f"  {name}: {color('未配置', 'yellow')}")

            print()
            print("请通过Web界面配置API Key:")
            print(f"  访问 http://127.0.0.1:{DEFAULT_PORT} -> API Key设置")

    except Exception as e:
        print(color(f"获取配置失败: {e}", 'red'))

    print()
    input("按Enter返回...")


def interactive_mode():
    """交互模式"""
    print_header()

    while True:
        print_menu()
        choice = input("请选择操作: ").strip().lower()

        if choice in ['0', 'quit', 'exit', 'q']:
            print(color("\n再见!", 'cyan'))
            break
        elif choice in ['1', 'start']:
            start_server()
        elif choice in ['2', 'stop']:
            stop_server()
        elif choice in ['3', 'restart']:
            restart_server()
        elif choice in ['4', 'status']:
            show_status()
        elif choice in ['5', 'logs']:
            show_logs()
        elif choice in ['6', 'stats']:
            show_stats()
        elif choice in ['7', 'collect']:
            manage_collectors()
        elif choice in ['8', 'config']:
            manage_config()
        else:
            print(color("无效选项，请重试", 'yellow'))

        print()


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="POI管理系统服务管理工具")
    parser.add_argument("command", nargs="?", default="interactive",
                        choices=["start", "stop", "restart", "status", "logs", "interactive"],
                        help="命令: start|stop|restart|status|logs|interactive")
    parser.add_argument("-p", "--port", type=int, default=DEFAULT_PORT, help="服务端口")
    parser.add_argument("-H", "--host", default=DEFAULT_HOST, help="监听地址")
    parser.add_argument("-f", "--foreground", action="store_true", help="前台运行")
    parser.add_argument("-n", "--lines", type=int, default=30, help="日志行数")

    args = parser.parse_args()

    # 切换到脚本目录
    os.chdir(Path(__file__).parent)

    if args.command == "start":
        start_server(args.host, args.port, not args.foreground)
    elif args.command == "stop":
        stop_server()
    elif args.command == "restart":
        restart_server()
    elif args.command == "status":
        show_status()
    elif args.command == "logs":
        show_logs(args.lines)
    else:
        interactive_mode()


if __name__ == "__main__":
    main()
