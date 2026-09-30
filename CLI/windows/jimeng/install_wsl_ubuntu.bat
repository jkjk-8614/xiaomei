@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "Install WSL Ubuntu" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0install_wsl_ubuntu.ps1"

