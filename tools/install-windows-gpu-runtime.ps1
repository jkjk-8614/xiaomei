[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$DataRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $AppRoot) { $AppRoot = Split-Path -Parent $PSScriptRoot }
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
if (-not $DataRoot) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $DataRoot = Join-Path $localAppData '小美画布'
}
$runtime = Join-Path $AppRoot 'bundled\win-api\python.exe'
$script = Join-Path $AppRoot 'tools\install_windows_gpu_runtime.py'
if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw "未找到内置 Python：$runtime" }
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "未找到 GPU 组件安装脚本：$script" }
& $runtime $script $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'GPU 组件安装失败。' }
Write-Host 'GPU 组件安装完成。请重启小美画布。'
