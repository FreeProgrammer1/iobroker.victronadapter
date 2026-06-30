# Run from repository root before copying the new source files.
$ErrorActionPreference = "Stop"

$files = @(
    ".npmignore",
    ".prettierignore",
    "CHANGELOG.md",
    "ADAPTER_CHECK_REPORT.md",
    "admin/index.html"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        Remove-Item $file -Force
    }
}

$langDirs = @("de","en","ru","pt","nl","fr","it","es","pl","uk","zh-cn")
foreach ($lang in $langDirs) {
    $path = Join-Path "admin/i18n" $lang
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
    }
}

Write-Host "Old ioBroker checker problem files removed."
