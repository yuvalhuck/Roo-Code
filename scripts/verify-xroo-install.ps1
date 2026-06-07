#requires -Version 5.1
# Verifies that the XRoo extension installed in VS Code matches the freshly
# built VSIX in ./bin. Compares timestamps + SHA-256 of the built extension.js
# against the copy VS Code has unpacked under ~/.vscode/extensions.

$ErrorActionPreference = 'Stop'

$ext = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter 'yuvalhuck.xroo-*' |
       Sort-Object LastWriteTime -Descending |
       Select-Object -First 1

if (-not $ext) {
    Write-Host "No yuvalhuck.xroo-* folder found under $env:USERPROFILE\.vscode\extensions" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Installed XRoo extension on disk ===" -ForegroundColor Cyan
Write-Host ("Folder       : " + $ext.FullName)
Write-Host ("Installed at : " + $ext.LastWriteTime)

$pkgPath = Join-Path $ext.FullName 'package.json'
if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    Write-Host ("Name         : " + $pkg.name)
    Write-Host ("Version      : " + $pkg.version)
    Write-Host ("Publisher    : " + $pkg.publisher)
}

$dist = Join-Path $ext.FullName 'dist\extension.js'
$installedHash = $null
if (Test-Path $dist) {
    $installedHash = (Get-FileHash $dist -Algorithm SHA256).Hash
    Write-Host ("extension.js : " + (Get-Item $dist).LastWriteTime + "  sha256=" + $installedHash.Substring(0,16) + "...")
}

Write-Host ""
Write-Host "=== Built VSIX (source of truth) ===" -ForegroundColor Cyan
$vsixPath = Join-Path $PSScriptRoot '..\bin\xroo-0.1.0.vsix'
if (-not (Test-Path $vsixPath)) {
    Write-Host "No bin/xroo-0.1.0.vsix found. Run 'pnpm vsix:xroo' first." -ForegroundColor Red
    exit 1
}
$vsix = Get-Item $vsixPath
Write-Host ("VSIX         : " + $vsix.FullName)
Write-Host ("Built at     : " + $vsix.LastWriteTime)
Write-Host ("Size         : " + ('{0:N0}' -f $vsix.Length) + " bytes")
$vsixHash = (Get-FileHash $vsix.FullName -Algorithm SHA256).Hash
Write-Host ("sha256       : " + $vsixHash.Substring(0,16) + "...")

# Extract extension/dist/extension.js from the VSIX (a zip) and hash it for
# a direct byte-equality check against the installed copy.
Write-Host ""
Write-Host "=== Comparing built VSIX -> installed extension ===" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ("xroo-verify-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($vsix.FullName)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'extension/dist/extension.js' }
        if (-not $entry) {
            Write-Host "VSIX did not contain extension/dist/extension.js (unexpected)" -ForegroundColor Red
            exit 1
        }
        $out = Join-Path $tmp 'extension.js'
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $true)
        $builtHash = (Get-FileHash $out -Algorithm SHA256).Hash
        Write-Host ("VSIX extension.js sha256 : " + $builtHash.Substring(0,16) + "...")
        Write-Host ("Installed   sha256       : " + $installedHash.Substring(0,16) + "...")
        if ($builtHash -eq $installedHash) {
            Write-Host "MATCH: the installed extension is the freshly built VSIX." -ForegroundColor Green
            exit 0
        } else {
            Write-Host "MISMATCH: VS Code is running a DIFFERENT extension.js than the latest VSIX." -ForegroundColor Yellow
            Write-Host "Reinstall with: code --install-extension bin\xroo-0.1.0.vsix --force" -ForegroundColor Yellow
            exit 2
        }
    } finally {
        $zip.Dispose()
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
