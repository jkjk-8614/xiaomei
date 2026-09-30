@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0..\..\.."

if exist "%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\OpenAI\Codex\bin;%PATH%"
)

where codex >nul 2>nul
if errorlevel 1 (
    echo Codex CLI was not found in PATH.
    echo Please run CLI\windows\openai\1-install_openai_codex_cli.bat first, then open a new terminal.
    echo.
    pause
    exit /b 1
)

codex
