param(
  [string]$BuildPython = 'python'
)

$ErrorActionPreference = 'Stop'

# The zip and interpreter are downloaded from python.org during the CI build.
# Keep the version and digest together so a release cannot silently switch to
# an unreviewed runtime.
$pythonVersion = '3.13.16'
$buildVersion = & $BuildPython -c "import sys; print('.'.join(map(str, sys.version_info[:3])))"
if ($LASTEXITCODE -ne 0 -or $buildVersion.Trim() -ne $pythonVersion) {
  throw "Windows dependency build requires Python $pythonVersion, got $buildVersion"
}
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip"
$pythonSha256 = '97DAE5274CC54867065E8D5A3226E48C35017ED332A0FDB0E27D5B5821961297'
$runtimeRoot = Join-Path (Get-Location) 'bundled/win-api'
if (Test-Path -LiteralPath $runtimeRoot) {
  throw "Build runtime directory already exists; use a clean release checkout: $runtimeRoot"
}
$downloadPath = Join-Path $env:RUNNER_TEMP "python-$pythonVersion-embed-amd64.zip"

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path -LiteralPath $downloadPath -PathType Leaf) {
  $actual = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $pythonSha256) { Remove-Item -LiteralPath $downloadPath -Force }
}
if (-not (Test-Path -LiteralPath $downloadPath -PathType Leaf)) {
  Invoke-WebRequest -Uri $pythonUrl -OutFile $downloadPath
}
$actual = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $pythonSha256) {
  throw "Python embedded runtime hash mismatch: expected $pythonSha256, got $actual"
}

Expand-Archive -LiteralPath $downloadPath -DestinationPath $runtimeRoot -Force

$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $runtimeRoot 'python.exe')
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
  throw "The embedded Python executable is not signed by Python Software Foundation: $($signature.Status)"
}

$pth = Get-ChildItem -LiteralPath $runtimeRoot -Filter 'python*._pth' -File | Select-Object -First 1
if (-not $pth) { throw 'The embedded Python path configuration is missing' }
@(
  'python313.zip'
  '.'
  'Lib/site-packages'
  'import site'
) | Set-Content -LiteralPath $pth.FullName -Encoding ascii

$sitePackages = Join-Path $runtimeRoot 'Lib/site-packages'
New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
& $BuildPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Unable to update pip for the Windows release build' }
& $BuildPython -m pip install --no-cache-dir --disable-pip-version-check --no-compile --only-binary=:all: --target $sitePackages -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Unable to vendor Windows API dependencies' }

$entry = Join-Path (Get-Location) 'windows_api_entry.py'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Windows API entry point is missing' }
Write-Host "Prepared official Python $pythonVersion runtime in $runtimeRoot"
