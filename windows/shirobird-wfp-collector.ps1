# ShiroBird WFP collector. Runs under the scheduled SYSTEM task installed separately.
# Does not change NetBird, firewall settings, or Windows auditing.
param([string]$Root = "$env:ProgramData\ShiroBird")
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $Root "ShiroBird.Wfp.psm1") -Force

$config = Get-Content (Join-Path $Root "collector.json") -Raw | ConvertFrom-Json
$endpoint = ([string]$config.server).TrimEnd('/')
if ($endpoint -notmatch '^https://') {
    throw 'Remote collection requires HTTPS'
}
$token = [string]$config.ingest_token
if ($token.Length -lt 32) { throw 'Sensor token missing or too short' }
$sensor = [string]$config.sensor
$networks = [string[]]$config.networks
$stateFile = Join-Path $Root "cursor.json"
$headers = @{ Authorization = 'Bearer ' + $token }
$cursor = [long]0
if (Test-Path $stateFile) {
    try { $cursor = [long]((Get-Content $stateFile -Raw | ConvertFrom-Json).last_record) }
    catch { throw 'Unable to read existing cursor safely. Review the cursor file.' }
} else {
    # Start at current Security log position: no surprising full-log backfill.
    $latest = Get-WinEvent -LogName Security -MaxEvents 1 -ErrorAction Stop
    $cursor = [long]$latest.RecordId
    @{last_record=$cursor} | ConvertTo-Json -Compress | Set-Content -Path $stateFile -Encoding UTF8
}
$lastHeartbeat = [datetime]::MinValue

function Save-Cursor([long]$newCursor) {
    $temporary = $stateFile + '.new'
    @{last_record=$newCursor} | ConvertTo-Json -Compress | Set-Content -Path $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}
function Send-Events([object[]]$events, [long]$to) {
    if ($events.Count -gt 0) {
        $json = @{ sensor=$sensor; events=@($events) } | ConvertTo-Json -Depth 6 -Compress
        Invoke-RestMethod -Uri ($endpoint + '/api/ingest') -Method Post -Headers $headers `
            -ContentType 'application/json' -Body $json -TimeoutSec 15 | Out-Null
    }
    Save-Cursor $to
}
function Send-Heartbeat {
    $json = @{ sensor=$sensor; source='windows_wfp'; accounting_enabled=$false } |
        ConvertTo-Json -Compress
    Invoke-RestMethod -Uri ($endpoint + '/api/sensors/heartbeat') -Method Post `
        -Headers $headers -ContentType 'application/json' -Body $json -TimeoutSec 10 | Out-Null
}
while ($true) {
    try {
        if (([datetime]::UtcNow - $lastHeartbeat).TotalSeconds -ge 30) {
            Send-Heartbeat
            $lastHeartbeat = [datetime]::UtcNow
        }

        # EventLogReader is forward-only; never request the last N newest events,
        # which would silently discard intermediate high-volume audit events.
        $xpath = "*[System[((EventID=5156) or (EventID=5157) or (EventID=5152)) and (EventRecordID > $cursor)]]"
        $query = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery(
            'Security', [System.Diagnostics.Eventing.Reader.PathType]::LogName, $xpath)
        $query.ReverseDirection = $false
        $reader = New-Object System.Diagnostics.Eventing.Reader.EventLogReader($query)
        $batch = New-Object System.Collections.ArrayList
        $batchCursor = $cursor
        try {
            while ($batchCursor -ge $cursor) {
                $record = $reader.ReadEvent()
                if ($null -eq $record) { break }
                try {
                    $batchCursor = [long]$record.RecordId
                    $ev = ConvertTo-ShiroBirdWfpEvent -EventXml ($record.ToXml()) -Networks $networks
                    if ($null -ne $ev) { [void]$batch.Add($ev) }
                    if ($batch.Count -ge 100) {
                        Send-Events -events @($batch.ToArray()) -to $batchCursor
                        $cursor = $batchCursor
                        $batch.Clear()
                    }
                } finally { $record.Dispose() }
                if (($batchCursor - $cursor) -gt 10000) {
                    # Progress for large runs of non-NetBird events.
                    Send-Events -events @($batch.ToArray()) -to $batchCursor
                    $cursor = $batchCursor
                    $batch.Clear()
                }
            }
        } finally { $reader.Dispose() }
        if ($batchCursor -gt $cursor) {
            Send-Events -events @($batch.ToArray()) -to $batchCursor
            $cursor = $batchCursor
        }
        Start-Sleep -Seconds 5
    } catch {
        # No cursor advance after a failed upload: retry from last committed batch.
        Write-Warning ("WFP collector retry: " + $_.Exception.Message)
        Start-Sleep -Seconds 10
    }
}
