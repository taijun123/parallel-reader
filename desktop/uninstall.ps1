$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
Add-Type -AssemblyName System.Windows.Forms
$appName = '对读 PDF 阅读器'
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$mutexSuffix = $env:USERNAME
$testRoot = $env:PARALLEL_READER_TEST_ROOT
$expected = [IO.Path]::GetFullPath((Join-Path $local 'Programs\ParallelReader'))
if ($testRoot) {
    $expected = [IO.Path]::GetFullPath((Join-Path $testRoot 'program'))
    # .NET Framework and PowerShell 5.1 use the same string hash as the launcher.
    $mutexSuffix = $testRoot.GetHashCode().ToString('X8')
}
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne $expected) {
    throw 'Unexpected application directory.'
}
$mutex = [Threading.Mutex]::new($false, "Local\ParallelReader-$mutexSuffix")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        [void][Windows.Forms.MessageBox]::Show('请关闭对读窗口，再卸载。', $appName)
        exit 1
    }
    Remove-Item -LiteralPath $expected -Recurse -Force
    if (!$testRoot) {
        $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
        Remove-Item -LiteralPath (Join-Path $programs "$appName.lnk") -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ParallelReader' -Force -ErrorAction SilentlyContinue
    }
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
