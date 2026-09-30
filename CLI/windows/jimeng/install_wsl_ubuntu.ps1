$ErrorActionPreference = 'Continue'

function Pause-End {
    Write-Host ''
    Read-Host "Press Enter to close"
}

try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
    if (-not $isAdmin) {
        Write-Host "Requesting administrator permission..."
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
        ) | Out-Null
        exit 0
    }

    Write-Host "=== WSL Ubuntu check ==="
    Write-Host ''
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        Write-Host "WSL was not found. Installing Ubuntu; Windows may need to restart."
        & wsl.exe --install -d Ubuntu
        Write-Host ''
        Write-Host "If Windows asks for a restart, restart first, then open Ubuntu and finish username/password setup."
        Pause-End
        exit 0
    }

    $distros = @(& wsl.exe -l -q 2>$null | ForEach-Object {
        ($_ -replace "`0", '').Trim()
    } | Where-Object { $_ })
    $ubuntu = @($distros | Where-Object { $_ -eq 'Ubuntu' -or $_ -like 'Ubuntu-*' } | Select-Object -First 1)

    if (-not $ubuntu) {
        Write-Host "Ubuntu was not found. Installing Ubuntu..."
        & wsl.exe --install -d Ubuntu
        Write-Host ''
        Write-Host "After installation, open Ubuntu and finish username/password setup."
        Pause-End
        exit 0
    }

    $ubuntuName = [string]$ubuntu[0]
    Write-Host "Existing Ubuntu distribution detected: $ubuntuName"
    Write-Host "Skipping installation; the existing Ubuntu distribution will not be changed."
    Write-Host ''
    $probe = & wsl.exe -d $ubuntuName -e sh -lc 'printf WSL_READY' 2>&1
    $probeText = $probe -join ''
    if ($LASTEXITCODE -eq 0 -and $probeText.Contains('WSL_READY')) {
        Write-Host "Ubuntu is initialized. You can now run install_jimeng_cli.bat."
    } else {
        Write-Host "Ubuntu is not initialized yet. Opening Ubuntu."
        Write-Host "Create a Linux username and password in the new window, then run install_jimeng_cli.bat."
        try {
            Start-Process ubuntu.exe -ErrorAction Stop | Out-Null
        } catch {
            & wsl.exe -d $ubuntuName
        }
    }
    Pause-End
} catch {
    Write-Host "WSL check failed: $($_.Exception.Message)"
    Write-Host "Open Ubuntu manually to finish setup, then run install_jimeng_cli.bat."
    Pause-End
}
