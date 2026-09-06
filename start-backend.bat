@echo off
setlocal

title Silipower Backend :3090

echo.
echo ==========================================================
echo   Silipower 后端启动器
echo ==========================================================
echo   后端类型 : DSH (profile=silipower)
echo   端口     : 3090
echo   访问地址 : http://127.0.0.1:3090
echo   健康检查 : http://127.0.0.1:3090/api/silipower/health
echo   停止后端 : 按 Ctrl+C
echo ==========================================================
echo.
echo 正在启动，首次加载约需 10-30 秒，请稍候...
echo 当下方出现 "dsh web: http://127.0.0.1:3090" 即表示启动成功。
echo.

cd /d "%~dp0"
set "DSH_HOME=%~dp0.dsh"
node --import tsx/esm apps/cli/src/bin.ts --profile silipower --port 3090 --no-open