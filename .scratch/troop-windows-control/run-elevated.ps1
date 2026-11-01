# THROWAWAY. Windows UAC must be confirmed by the human; no security UI automation.
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
cargo build --offline --locked --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir (Join-Path $root '.tmp-host-control/build')
if($LASTEXITCODE -ne 0){throw 'Build failed'}
$output=Join-Path $root ('.tmp-host-control/elevated-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
@{directory=$output} | ConvertTo-Json | Set-Content (Join-Path $root '.tmp-host-control/latest-elevated-run.json') -Encoding utf8
try {
 $fixture=Start-Process -FilePath (Join-Path $root '.tmp-host-control/build/debug/elevated-fixture.exe') -ArgumentList ('"'+$output+'"') -Verb RunAs -PassThru -WindowStyle Normal
 # A visible interactive fixture is the explicit subject of this user-authorized drill.
 $identity=Join-Path $output 'elevated-target.json'
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(-not(Test-Path -LiteralPath $identity) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if(-not(Test-Path -LiteralPath $identity)){throw 'Elevated fixture did not report identity'}
 $target=Get-Content -LiteralPath $identity -Raw | ConvertFrom-Json
 if($target.pid -ne $fixture.Id){throw 'Fixture PID mismatch'}
 $result=& (Join-Path $root '.tmp-host-control/build/debug/integrity-inspector.exe') $identity
 $code=$LASTEXITCODE
 $result | Set-Content (Join-Path $output 'integrity-result.json') -Encoding utf8
 if($code -ne 0){throw 'Expected actual higher-integrity denial was not observed'}
 $deadline=[DateTime]::UtcNow.AddSeconds(70)
 while(-not(Test-Path -LiteralPath (Join-Path $output 'elevated-target-closed.json')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
 $closed=Test-Path -LiteralPath (Join-Path $output 'elevated-target-closed.json')
 @{passed=$closed;target=$target;inspection=($result | ConvertFrom-Json);selfClosed=$closed;scope='Human-approved UAC; passive own fixture; ordinary-inspector read-only refusal';utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'elevated-results.json') -Encoding utf8
 if(-not $closed){throw 'Fixture self-close not observed; human should close its window'}
 Get-Content (Join-Path $output 'elevated-results.json')
} catch {
 @{passed=$false;error=$_.Exception.Message;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $output 'elevated-failure.json') -Encoding utf8
 throw
}
