@echo off
chcp 65001 >nul
title Antigravity Status Bar Uninstaller

set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel%==0 goto NODE_READY

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;%PATH%"
    goto NODE_READY
)
if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    goto NODE_READY
)
if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
    set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
    goto NODE_READY
)

echo.
echo [Error] Node.js not found!
pause
exit /b 1

:NODE_READY
echo.
echo ====================================================
echo   Antigravity Status Bar - Restore Official Backup
echo ====================================================
echo.
"%NODE_CMD%" "%~dp0installer.js" --uninstall %*

if %errorlevel% neq 0 goto FAIL

echo.
echo Restored! Closing in 5 seconds...
ping -n 5 127.0.0.1 >nul
exit /b 0

:FAIL
echo.
echo [Error] Restore failed. Please check the message above.
echo.
pause
exit /b 1
