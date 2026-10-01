[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [uri]$InstallerUrl,

    [string]$OutputPath = '.\update.json',

    [string[]]$Notes = @(),

    [switch]$Mandatory
)

if ($InstallerUrl.Scheme -ne 'https' -and $InstallerUrl.Host -notin @('localhost', '127.0.0.1', '::1')) {
    throw 'InstallerUrl 必须使用 HTTPS；仅允许 localhost 用于本地测试。'
}

$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Extension -ne '.exe') {
    throw 'InstallerPath 必须指向 Windows .exe 安装程序。'
}
$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

$manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    platform = 'win32'
    arch = 'x64'
    artifact = 'nsis'
    channel = 'stable'
    installerUrl = $InstallerUrl.AbsoluteUri
    fileName = $installer.Name
    sha256 = $hash
    size = [int64]$installer.Length
    publishedAt = (Get-Date).ToUniversalTime().ToString('o')
    mandatory = [bool]$Mandatory
    notes = @($Notes | Where-Object { $_ -and $_.Trim() })
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "已生成更新清单：$([IO.Path]::GetFullPath($OutputPath))"
Write-Host "版本：$Version"
Write-Host "SHA-256：$hash"
Write-Host "大小：$($installer.Length) 字节"
