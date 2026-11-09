#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$runner = Join-Path $PSScriptRoot 'event-deployment.mjs'
$nodePath = (Get-Command $Node -ErrorAction Stop).Source
& $nodePath $runner preflight $configPath
if ($LASTEXITCODE -ne 0) { throw '部署预检失败。' }
$starts = [System.Collections.Generic.List[datetime]]::new()
$ownedProcess = $null
$heartbeatAgeLimit = [Math]::Max(20, 3 * $(if ($settings.health_interval_ms) { $settings.health_interval_ms / 1000 } else { 5 }))

function Stop-OwnedHost {
    if ($null -eq $script:ownedProcess -or $script:ownedProcess.HasExited) { return }
    try {
        $script:ownedProcess.StandardInput.WriteLine('{"id":"host-stop","method":"deployment.shutdown"}')
        $script:ownedProcess.StandardInput.Flush()
        if ($script:ownedProcess.WaitForExit(8000)) { return }
    } catch { Write-Warning '正常退出未确认，正在停止当前托管进程树。' }
    if (-not $script:ownedProcess.HasExited) {
        $script:ownedProcess.Kill($true)
        $script:ownedProcess.WaitForExit()
    }
}

try {
    while ($true) {
        $now = [datetime]::UtcNow
        $starts.RemoveAll([Predicate[datetime]]{ param($stamp) ($now - $stamp).TotalSeconds -ge 60 }) | Out-Null
        if ($starts.Count -ge 3) { throw '一分钟内已启动三次，请检查部署健康记录。' }
        $starts.Add($now)
        $info = [System.Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $nodePath
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true
        foreach ($argument in @($runner, 'run', $configPath)) { $info.ArgumentList.Add($argument) }
        $ownedProcess = [System.Diagnostics.Process]::Start($info)
        @{ event = 'host_start'; attempt = $starts.Count; pid = $ownedProcess.Id } | ConvertTo-Json -Compress | Write-Output
        $started = [datetime]::UtcNow
        while (-not $ownedProcess.WaitForExit(1000)) {
            # Only inspect this invocation's heartbeat, never an earlier host's.
            $healthy = $false
            try {
                $health = Get-Content -LiteralPath $settings.health_file -Raw | ConvertFrom-Json
                $checkedAt = [datetimeoffset]$health.checked_at
                $age = ([datetimeoffset]::UtcNow - $checkedAt.ToUniversalTime()).TotalSeconds
                $healthy = $health.host_pid -eq $ownedProcess.Id -and $health.ready -and $age -ge 0 -and $age -lt $heartbeatAgeLimit
            } catch { $healthy = $false }
            if ($healthy) { $started = [datetime]::UtcNow }
            if (([datetime]::UtcNow - $started).TotalSeconds -gt 30) {
                Write-Warning '部署健康检查持续失败，停止后按启动频率限制重新启动。'
                Stop-OwnedHost
            }
        }
        $code = $ownedProcess.ExitCode
        $ownedProcess.Dispose()
        $ownedProcess = $null
        Write-Warning "部署进程已退出，退出码 $code。两秒后重新启动。"
        Start-Sleep -Seconds 2
    }
} finally {
    Stop-OwnedHost
    if ($null -ne $ownedProcess) { $ownedProcess.Dispose() }
}
