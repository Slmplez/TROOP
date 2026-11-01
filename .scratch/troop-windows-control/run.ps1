param([switch]$Probe)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
cargo build --offline --locked --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir (Join-Path $root '.tmp-host-control/build')
if($LASTEXITCODE -ne 0){throw 'Prototype compilation failed; offline Rust dependencies and MSVC linker required'}
$runDir=Join-Path $root ('.tmp-host-control/manual-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$protoArgs=@('"'+$runDir+'"')
if($Probe){$protoArgs+='--probe'}
Start-Process -FilePath (Join-Path $root '.tmp-host-control/build/debug/troop-host-control-prototype.exe') -ArgumentList $protoArgs -WorkingDirectory $root -PassThru | Select-Object Id,ProcessName
Write-Output ('Evidence directory: '+$runDir)
