# 构建 WhiteSoft 桌面端，在 desktop 目录下运行
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Console
#
# 默认产出双击就能用的窗口程序：没有控制台窗口，图标、版本信息和应用清单都嵌在
# exe 里，失败时会弹对话框说明原因。从命令行调用仍然能正常打印，程序会挂接到
# 调用方已有的控制台上。
#
# -Console 产出带控制台的调试版本，便于直接看到所有输出。
#
# 需要 Go 1.25+ 与 CGO，WebView2 绑定用 C 头文件，Windows 上用 MinGW-w64 的 gcc。
# 嵌入资源需要 windres，它随 MinGW-w64 一起安装。
# 默认是窗口程序：双击只开应用窗口，不闪控制台。-Console 保留控制台用于调试。
# -NoStrip 保留调试符号，文件会大 7 MB 左右；被杀毒软件误报时值得一试，
# 因为剥掉符号的 Go 程序熵更高，更容易撞上误报规则。
# -Sign 用一个代码签名证书签名，这是消除「未知发布者」一类提示的根治办法。
param(
    [switch]$Console,
    [switch]$Release,
    [switch]$NoStrip,
    [string]$Sign = "",
    [string]$Output = "whitesoft.exe"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# 网页界面在仓库根目录，go:embed 不能跨包，所以先镜像到 internal/webapp/web
Write-Host "同步网页界面：public/ -> internal/webapp/web ..."
go run ./tools/copyweb -src ../public -dst ./internal/webapp/web
if ($LASTEXITCODE -ne 0) { throw "同步网页界面失败" }

# third_party/webview_go 是本地副本。上游在 WebView2 起不来时会解引用空指针直接崩溃，
# 这个工具补上空指针保护和就绪查询。重复执行没有副作用。
Write-Host "修补 third_party/webview_go ..."
go run ./tools/patch-webview
if ($LASTEXITCODE -ne 0) { throw "修补 webview 依赖失败" }

# 图标、版本信息与应用清单。这些让 exe 在 Windows 里像一个正常的应用程序，
# 而不是一个没有来源信息的匿名二进制。
$syso = "app_windows_amd64.syso"
$windres = Get-Command windres -ErrorAction SilentlyContinue
if ($windres) {
    Write-Host "编译资源：winres/app.rc -> $syso ..."
    & $windres.Source --codepage=65001 -I winres -i winres/app.rc -O coff -o $syso
    if ($LASTEXITCODE -ne 0) { throw "windres 编译资源失败" }
} else {
    if (Test-Path $syso) {
        Write-Host "警告：找不到 windres，沿用已有的 $syso" -ForegroundColor Yellow
    } else {
        Write-Host "警告：找不到 windres，生成的 exe 将没有图标与版本信息" -ForegroundColor Yellow
    }
}

# 默认是窗口程序：双击只开应用窗口，不闪控制台。-Console 保留控制台用于调试。
# -Release 是旧名字，含义与默认值相同，保留以免旧命令失效。
$guiBuild = -not $Console
$flags = @()
if (-not $NoStrip) { $flags += @("-s", "-w") }
if ($guiBuild) { $flags += "-H", "windowsgui" }
$ldflags = $flags -join " "

# 同时放一份独立图标文件，方便给快捷方式指定图标：exe 内嵌图标在某些
# 环境里无法被「更改图标」对话框读取，独立 ico 文件没有这个问题。
Copy-Item ..\public\favicon.ico whitesoft.ico -Force
Write-Host "编译 $Output ..."
$goArgs = @("build", "-trimpath")
if ($ldflags) { $goArgs += @("-ldflags", $ldflags) }
$goArgs += @("-o", $Output, ".")
& go @goArgs
if ($LASTEXITCODE -ne 0) { throw "go build 失败" }

if ($Sign) {
    Write-Host "签名 $Output（证书指纹 $Sign）..."
    $cert = Get-ChildItem "Cert:\CurrentUser\My\$Sign" -CodeSigningCert -ErrorAction SilentlyContinue
    if (-not $cert) { throw "在 Cert:\CurrentUser\My 里找不到代码签名证书 $Sign" }
    $res = Set-AuthenticodeSignature -FilePath $Output -Certificate $cert `
        -TimestampServer "http://timestamp.digicert.com"
    if ($res.Status -ne "Valid") { throw "签名失败：$($res.Status) $($res.StatusMessage)" }
    Write-Host "签名完成"
}

$size = [math]::Round((Get-Item $Output).Length / 1MB, 1)
$kind = if ($guiBuild) { "窗口程序" } else { "控制台程序" }
Write-Host "完成：$Output（$size MB，$kind，网页界面已内嵌，不需要 Node.js）"
