param(
    [switch]$NonInteractive,
    [string]$Release = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("openai-codex-cli-install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logPath -Force | Out-Null

function Pause-End {
    Write-Host ""
    Write-Host "Log: $logPath"
    if (-not $NonInteractive) {
        Read-Host "Press Enter to close" | Out-Null
    }
    try {
        Stop-Transcript | Out-Null
    } catch {
        # The transcript may already be closed when the official installer exits.
    }
}

function Add-CodexInstallPathToSession {
    $codexBin = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexBin -PathType Container) {
        $segments = $env:Path -split ";" | Where-Object { $_ -and $_ -ne $codexBin }
        $env:Path = (($codexBin + $segments) -join ";")
    }
}

function Find-CodexExecutable {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"),
        (Join-Path $env:APPDATA "npm\codex.cmd"),
        (Join-Path $env:APPDATA "npm\codex.ps1")
    )
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    foreach ($name in @("codex.exe", "codex.cmd", "codex.ps1", "codex")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandType -in @("Application", "ExternalScript") } |
            Select-Object -First 1
        if ($command) {
            $path = $command.Source
            if (-not $path) { $path = $command.Path }
            if ($path) { return $path }
        }
    }
    return $null
}

function Wait-ForCodexExecutable {
    param([int]$Attempts = 30)

    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        Add-CodexInstallPathToSession
        $codex = Find-CodexExecutable
        if ($codex) { return $codex }
        if ($attempt -lt ($Attempts - 1)) {
            Start-Sleep -Milliseconds 500
        }
    }
    return $null
}

function Get-NpmCommand {
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmd) { return $npmCmd.Source }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) { return $npm.Source }

    return $null
}

function Add-NpmPrefixToPath {
    param([string]$NpmCommand)

    try {
        $prefix = (& $NpmCommand config get prefix 2>$null | Select-Object -First 1).Trim()
        if ($prefix -and (Test-Path -LiteralPath $prefix)) {
            $env:PATH = "$prefix;$env:PATH"
        }
    } catch {
        Write-Host "Could not read npm global prefix. Continuing with the current PATH."
    }
}

function Install-WithNpmFallback {
    $npm = Get-NpmCommand
    if (-not $npm) {
        throw "OpenAI standalone installer failed, and npm was not found for fallback install."
    }

    Write-Host "Falling back to npm package install: npm install -g @openai/codex"
    & $npm install -g "@openai/codex"
    if ($LASTEXITCODE -ne 0) {
        throw "npm fallback install failed with exit code $LASTEXITCODE."
    }
    Add-NpmPrefixToPath -NpmCommand $npm
}

function Install-GptImage2Skill {
    $npm = Get-NpmCommand
    if (-not $npm) {
        Write-Host "npm was not found. Skipping gpt-image-2-skill install."
        return
    }

    Write-Host "Installing/updating GPT Image 2 helper: npm install -g gpt-image-2-skill"
    & $npm install -g "gpt-image-2-skill"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "gpt-image-2-skill install failed with exit code $LASTEXITCODE. Codex CLI can still run, but Image 2 helper will be unavailable."
        return
    }
    Add-NpmPrefixToPath -NpmCommand $npm
}

try {
    Write-Host "=== OpenAI Codex CLI install/update ==="
    Write-Host "Workspace: $root"
    Write-Host ""

    if ($NonInteractive) {
        $env:CODEX_NON_INTERACTIVE = "1"
        Write-Host "CODEX_NON_INTERACTIVE=1"
    }

    if (-not [string]::IsNullOrWhiteSpace($Release)) {
        $env:CODEX_RELEASE = $Release
        Write-Host "CODEX_RELEASE=$Release"
    }

    Write-Host "Installing/updating Codex CLI with the official OpenAI standalone installer..."
    try {
        irm https://chatgpt.com/codex/install.ps1 | iex
    } catch {
        Write-Host "Standalone installer failed: $($_.Exception.Message)"
        Install-WithNpmFallback
    }
    Add-CodexInstallPathToSession
    Install-GptImage2Skill
    Add-CodexInstallPathToSession
    Write-Host ""

    # 官方安装器会先更新“未来 PowerShell 窗口”的 PATH；当前窗口可能还
    # 不能用 Get-Command 找到它，但官方安装路径下的 codex.exe 已经可用。
    $codex = Wait-ForCodexExecutable
    if (-not $codex) {
        Write-Host "Codex CLI was installed, but 'codex' is not available in this PowerShell PATH yet."
        Write-Host "Close this window, open a new PowerShell, then run: codex"
        Pause-End
        exit 2
    }

    Write-Host "Codex CLI found: $codex"
    try {
        & $codex --version
    } catch {
        Write-Host "Could not read Codex version in this session. Open a new PowerShell and run: codex --version"
    }
    $gptImage2Skill = Get-Command gpt-image-2-skill -ErrorAction SilentlyContinue
    if ($gptImage2Skill) {
        Write-Host "GPT Image 2 helper found: $($gptImage2Skill.Source)"
    } else {
        Write-Host "GPT Image 2 helper is not available in this PowerShell PATH yet."
    }

    Write-Host ""
    Write-Host "Done. Run 'codex' in PowerShell to sign in and start using OpenAI Codex CLI."
    Write-Host "You can also double-click CLI\windows\openai\2-start_openai_codex_cli.bat."
    Pause-End
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Pause-End
    exit 1
}
