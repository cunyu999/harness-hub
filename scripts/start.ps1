# 启动后端。做两件事: 1) 关掉 Windows 的硬错误弹窗(0xC0000142 这类) 2) 用当前控制台跑 node。
# SetErrorMode 会被子进程继承, 于是 node -> harness -> python 这条链上再出现 DLL 初始化失败时,
# 只会安静地以退出码失败, 不会弹「应用程序无法正常启动」的模态框挡在人前面。
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Win32ErrorMode {
    [DllImport("kernel32.dll")]
    public static extern uint SetErrorMode(uint uMode);
}
'@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null

$SEM_FAILCRITICALERRORS = 0x0001
$SEM_NOGPFAULTERRORBOX = 0x0002
$SEM_NOOPENFILEERRORBOX = 0x8000
[Win32ErrorMode]::SetErrorMode($SEM_FAILCRITICALERRORS -bor $SEM_NOGPFAULTERRORBOX -bor $SEM_NOOPENFILEERRORBOX) | Out-Null

# 告诉 node 入口"已经被包装过", 免得它又用本脚本重新拉起自己
$env:HH_ERROR_MODE = '1'

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'dist/apps/server/src/index.js'
if (-not (Test-Path $entry)) {
  Write-Host "找不到 $entry, 先运行 npm run build" -ForegroundColor Yellow
  exit 1
}

# 便携包自带 node.exe: 优先用包内的, 不依赖用户 PATH 里的 node 版本.
$node = Join-Path $root 'node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

& $node $entry @args
exit $LASTEXITCODE
