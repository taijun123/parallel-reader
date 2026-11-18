param(
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,
    [string] $NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [string] $ExistingLibrary,
    [string] $OfflineRuntimeInstaller
)

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$webViewVersion = '1.0.2903.40'
$cache = Join-Path $env:LOCALAPPDATA 'ParallelReaderBuildTools'
$webViewArchive = Join-Path $cache "webview2-$webViewVersion.zip"
$build = Join-Path ([IO.Path]::GetTempPath()) ("parallel-reader-" + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $build 'payload'

function Download-Dependency([string] $Url, [string] $File) {
    if (Test-Path -LiteralPath $File) { return }
    $pending = "$File.$([guid]::NewGuid().ToString('N')).download"
    try {
        & curl.exe -fLsS --retry 2 $Url -o $pending
        if ($LASTEXITCODE -ne 0) { throw "Dependency download failed: $Url" }
        Move-Item -LiteralPath $pending -Destination $File -Force
    }
    finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Compile-Desktop([string] $Source, [string] $Target, [string[]] $References) {
    $referenceOptions = @($References | ForEach-Object { "/reference:$_" })
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/win32icon:$build\reader.ico" "/out:$Target" @referenceOptions $Source
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $Source" }
}

function Write-Icon([string] $File) {
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new(64, 64)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $frame = [Drawing.Drawing2D.GraphicsPath]::new()
    $background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(101, 80, 231))
    $png = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $frame.AddArc(0, 0, 30, 30, 180, 90)
        $frame.AddArc(34, 0, 30, 30, 270, 90)
        $frame.AddArc(34, 34, 30, 30, 0, 90)
        $frame.AddArc(0, 34, 30, 30, 90, 90)
        $frame.CloseFigure()
        $graphics.FillPath($background, $frame)
        $graphics.FillRectangle([Drawing.Brushes]::White, 17, 16, 11, 32)
        $graphics.FillRectangle([Drawing.Brushes]::White, 36, 16, 11, 32)
        $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
        $writer = [IO.BinaryWriter]::new([IO.File]::Create($File))
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]1)
            $writer.Write([byte[]](64, 64, 0, 0))
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$png.Length)
            $writer.Write([uint32]22)
            $writer.Write($png.ToArray())
        }
        finally { $writer.Dispose() }
    }
    finally {
        $png.Dispose()
        $background.Dispose()
        $frame.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

if (!(Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) { throw 'Run npm run build first.' }
$nodeVersion = (& $NodePath -p 'process.arch === "x64" && typeof require("node:sqlite").DatabaseSync === "function" ? process.version : ""')
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'A Windows x64 Node.js runtime with node:sqlite is required.' }
New-Item -ItemType Directory -Force $cache, $payload, $OutputDirectory | Out-Null
try {
    $webViewUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webViewVersion/microsoft.web.webview2.$webViewVersion.nupkg"
    Download-Dependency $webViewUrl $webViewArchive
    $nodeLicense = Join-Path $cache "Node-$nodeVersion-LICENSE.txt"
    Download-Dependency "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" $nodeLicense
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $webViewFiles = Join-Path $build 'webview2'
    [IO.Compression.ZipFile]::ExtractToDirectory($webViewArchive, $webViewFiles)
    foreach ($file in @('lib\net462\Microsoft.Web.WebView2.Core.dll', 'lib\net462\Microsoft.Web.WebView2.WinForms.dll', 'build\native\x64\WebView2Loader.dll')) {
        Copy-Item -LiteralPath (Join-Path $webViewFiles $file) -Destination $payload
    }
    Copy-Item -LiteralPath (Join-Path $webViewFiles 'LICENSE.txt') -Destination (Join-Path $payload 'WebView2-SDK-LICENSE.txt')
    Copy-Item -LiteralPath $nodeLicense -Destination $payload
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payload 'node.exe')
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $payload -Recurse
    foreach ($file in @('server.mjs', 'library-api.mjs', 'marks-api.mjs', 'THIRD_PARTY_NOTICES.txt')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payload
    }
    $uninstall = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Encoding UTF8 -Raw
    [IO.File]::WriteAllText((Join-Path $payload 'uninstall.ps1'), $uninstall, [Text.UTF8Encoding]::new($true))
    if ($ExistingLibrary) {
        $documents = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) + '\'
        $existing = (Resolve-Path -LiteralPath $ExistingLibrary).Path
        if (!$existing.StartsWith($documents, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The optional existing library must be under the current Documents directory.'
        }
        [IO.File]::WriteAllText((Join-Path $payload 'source-library.txt'), $existing.Substring($documents.Length))
    }
    if ($OfflineRuntimeInstaller) {
        $runtime = Get-Item -LiteralPath $OfflineRuntimeInstaller
        $signature = Get-AuthenticodeSignature -LiteralPath $runtime.FullName
        if ($runtime.Name -ne 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' -or
            $signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
            throw 'Provide the Microsoft-signed Evergreen standalone WebView2 x64 installer.'
        }
        Copy-Item -LiteralPath $runtime.FullName -Destination $payload
    }
    Write-Icon (Join-Path $build 'reader.ico')
    Compile-Desktop (Join-Path $PSScriptRoot 'Reader.cs') (Join-Path $payload 'ParallelReader.exe') @(
        'System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
        (Join-Path $payload 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $payload 'Microsoft.Web.WebView2.WinForms.dll')
    )
    $setupName = if ($OfflineRuntimeInstaller) { 'ParallelReader-Offline-Setup-x64.exe' } else { 'ParallelReader-Setup-x64.exe' }
    $setup = Join-Path $build $setupName
    Compile-Desktop (Join-Path $PSScriptRoot 'Setup.cs') $setup @(
        'System.dll', 'System.Windows.Forms.dll', 'System.IO.Compression.FileSystem.dll', 'Microsoft.CSharp.dll'
    )
    $zip = Join-Path $build 'payload.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($payload, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $writer = [IO.BinaryWriter]::new([IO.File]::Open($setup, [IO.FileMode]::Append))
    $archive = [IO.File]::OpenRead($zip)
    try {
        $archive.CopyTo($writer.BaseStream)
        $writer.Write([long]$archive.Length)
        $writer.Write([long]0x5245414445525A50)
    }
    finally {
        $archive.Dispose()
        $writer.Dispose()
    }
    Copy-Item -LiteralPath $setup -Destination $OutputDirectory -Force
    Get-Item -LiteralPath (Join-Path $OutputDirectory $setupName)
}
finally {
    $actual = [IO.Path]::GetFullPath($build)
    if ($actual.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $actual) -match '^parallel-reader-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $actual)) {
        Remove-Item -LiteralPath $actual -Recurse -Force
    }
}
