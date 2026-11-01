param([switch]$FrameProbe,[switch]$MappingOnly)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$carrier=Join-Path $root 'dist/Grok Bot 0.18 Reconstructed-win32-x64'
$shellDir=Join-Path $root '.tmp-host-control/electron-shell'
New-Item -ItemType Directory -Path $shellDir -Force | Out-Null
# Prototype only: reuse existing Electron carrier, NEVER copy app.asar or original app code.
$assets=@('chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','libEGL.dll','libGLESv2.dll','LICENSE.electron.txt','LICENSES.chromium.html','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader_icd.json','vk_swiftshader.dll','vulkan-1.dll')
foreach($asset in $assets){if(-not (Test-Path -LiteralPath (Join-Path $shellDir $asset))){Copy-Item -LiteralPath (Join-Path $carrier $asset) -Destination (Join-Path $shellDir $asset)}}
if(-not (Test-Path -LiteralPath (Join-Path $shellDir 'troop-capture-prototype.exe'))){Copy-Item -LiteralPath (Join-Path $carrier 'Grok Bot 0.18 Reconstructed.exe') -Destination (Join-Path $shellDir 'troop-capture-prototype.exe')}
if(-not (Test-Path -LiteralPath (Join-Path $shellDir 'locales'))){Copy-Item -LiteralPath (Join-Path $carrier 'locales') -Destination $shellDir -Recurse -Force}
$appDir=Join-Path $shellDir 'resources/app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'electron-capture.cjs') -Destination (Join-Path $appDir 'main.cjs')
'{"name":"troop-capture-prototype","version":"0.0.0","main":"main.cjs"}' | Set-Content -LiteralPath (Join-Path $appDir 'package.json') -Encoding utf8
$env:TROOP_PACK_SOURCE=$appDir
$env:TROOP_PACK_DESTINATION=Join-Path $shellDir 'resources/app.asar'
& (Join-Path $root 'offline/vendor/node/win32-x64/node.exe') -e "import('@electron/asar').then(a=>a.createPackage(process.env.TROOP_PACK_SOURCE,process.env.TROOP_PACK_DESTINATION))"
if($LASTEXITCODE -ne 0){throw 'Prototype ASAR packaging failed'}
$env:TROOP_PROTOTYPE_ROOT=$root
$env:TROOP_FRAME_PROBE=if($FrameProbe){'1'}else{'0'}
$env:TROOP_MAPPING_ONLY=if($MappingOnly){'1'}else{'0'}
$captureProcess=Start-Process -FilePath (Join-Path $shellDir 'troop-capture-prototype.exe') -WorkingDirectory $root -RedirectStandardError (Join-Path $root '.tmp-host-control/capture-stderr.log') -RedirectStandardOutput (Join-Path $root '.tmp-host-control/capture-stdout.log') -PassThru
$finished=$captureProcess.WaitForExit(15000)
[pscustomobject]@{finishedWithin15Seconds=$finished;exitCode=if($finished){$captureProcess.ExitCode}else{$null};pid=$captureProcess.Id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.tmp-host-control/capture-process.json') -Encoding utf8
Write-Output ('Capture PID: '+$captureProcess.Id+'; exited within 15 seconds: '+$finished)
