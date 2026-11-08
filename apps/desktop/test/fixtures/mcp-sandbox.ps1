$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    if ($null -eq $request.id) { continue }
    $result = switch ($request.method) {
        'initialize' { @{ protocolVersion = '2024-11-05'; capabilities = @{ tools = @{} }; serverInfo = @{ name = 'contained-powershell'; version = '1' } } }
        'tools/list' { @{ tools = @(@{ name = 'echo'; description = 'Controlled response'; inputSchema = @{ type = 'object'; properties = @{ text = @{ type = 'string' } }; required = @('text'); additionalProperties = $false } }) } }
        'tools/call' { @{ content = @(@{ type = 'text'; text = 'TROOP_CONTAINED_POWERSHELL' }) } }
        default { @{} }
    }
    @{ jsonrpc = '2.0'; id = $request.id; result = $result } | ConvertTo-Json -Depth 12 -Compress | ForEach-Object { [Console]::WriteLine($_) }
}
