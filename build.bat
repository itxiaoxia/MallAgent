@echo off
setlocal EnableExtensions

if /I not "%OS%"=="Windows_NT" (
    echo build.bat must run on Windows. 1>&2
    endlocal & exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found on PATH. Install Node.js before building MallAgent. 1>&2
    endlocal & exit /b 1
)

set "ROOT=%~dp0"
for %%I in ("%ROOT%.") do set "ROOT=%%~fI"

echo [MallAgent] Building Windows desktop package...
node "%ROOT%\scripts\build-desktop.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
