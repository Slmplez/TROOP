param([ValidateSet('normal','focus-pulse','stale-observation','capture-hang','capture-exit','channel-eof','lease-timeout','helper-crash','target-crash','output-backpressure','stop-transport','capture-lifecycle','capture-soak','permission','partial-result','hotkey-stop','button-stop','manual-lock','all')][string]$Scenario='all')
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
cargo build --offline --locked --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir (Join-Path $root '.tmp-host-control/build')
if($LASTEXITCODE -ne 0){throw 'Build failed'}
# Reuse the already isolated Electron carrier; contains no original application code.
$shellDir=Join-Path $root '.tmp-host-control/electron-shell'
if(-not(Test-Path -LiteralPath (Join-Path $shellDir 'troop-capture-prototype.exe'))){throw 'Prepare carrier with run-capture.ps1 first'}
$appDir=Join-Path $root '.tmp-host-control/isolation-app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'isolation-capture.cjs') -Destination (Join-Path $appDir 'main.cjs')
'{"name":"troop-isolation-capture-prototype","version":"0.0.0","main":"main.cjs"}' | Set-Content -LiteralPath (Join-Path $appDir 'package.json') -Encoding utf8NoBOM
$env:TROOP_PACK_SOURCE=$appDir
$env:TROOP_PACK_DESTINATION=Join-Path $shellDir 'resources/app.asar'
& (Join-Path $root 'offline/vendor/node/win32-x64/node.exe') -e "import('@electron/asar').then(a=>a.createPackage(process.env.TROOP_PACK_SOURCE,process.env.TROOP_PACK_DESTINATION))"
if($LASTEXITCODE -ne 0){throw 'Packaging failed'}
& (Join-Path $root 'offline/vendor/node/win32-x64/node.exe') (Join-Path $PSScriptRoot 'isolation-driver.mjs') $root $Scenario
if($LASTEXITCODE -ne 0){throw 'Probe failed; inspect captured evidence'}
