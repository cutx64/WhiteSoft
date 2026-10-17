# 构建 WhiteSoft 桌面端（在 desktop 目录下运行）
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Release
#
# -Release 额外去掉控制台窗口（双击只开窗口）。
# 需要 Go 1.25+ 与 CGO（WebView2 绑定用 C 头文件；Windows 上用 MinGW-w64 的 gcc）。
param(
    [switch]$Release,
    [string]$Output = "whitesoft.exe"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# The client lives at the repository root; go:embed cannot reach outside its own
# package, so the tree is mirrored into internal/webapp/web first.
Write-Host "Synchronizing web client: public/ -> internal/webapp/web ..."
go run ./tools/copyweb -src ../public -dst ./internal/webapp/web
if ($LASTEXITCODE -ne 0) { throw "copying the web client failed" }

$ldflags = ""
if ($Release) {
    # -H windowsgui hides the console window; it is a separate, deliberate choice.
    $ldflags = "-s -w -H windowsgui"
}

Write-Host "Building $Output ..."
$goArgs = @("build", "-trimpath")
if ($ldflags) { $goArgs += @("-ldflags", $ldflags) }
$goArgs += @("-o", $Output, ".")
& go @goArgs
if ($LASTEXITCODE -ne 0) { throw "go build failed" }

$size = [math]::Round((Get-Item $Output).Length / 1MB, 1)
Write-Host "Done: $Output ($size MB, web client embedded, Node.js not required)"
