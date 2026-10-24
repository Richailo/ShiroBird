# ShiroBird Windows Filtering Platform event parsing (PowerShell 5.1+).
Set-StrictMode -Version Latest

function Test-ShiroBirdAddress {
    param([string]$Ip, [string[]]$Networks)
    $address = [System.Net.IPAddress]::None
    if (-not [System.Net.IPAddress]::TryParse($Ip, [ref]$address)) { return $false }
    $addressBytes = $address.GetAddressBytes()
    foreach ($cidr in $Networks) {
        $parts = ([string]$cidr).Trim().Split('/')
        if ($parts.Count -ne 2) { continue }
        $network = [System.Net.IPAddress]::None
        if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$network)) { continue }
        $networkBytes = $network.GetAddressBytes()
        if ($networkBytes.Length -ne $addressBytes.Length) { continue }
        $prefix = 0
        if (-not [int]::TryParse($parts[1], [ref]$prefix)) { continue }
        if ($prefix -lt 0 -or $prefix -gt $networkBytes.Length * 8) { continue }
        $full = [int][math]::Floor($prefix / 8)
        $remaining = $prefix % 8
        $match = $true
        for ($i = 0; $i -lt $full; $i++) {
            if ($addressBytes[$i] -ne $networkBytes[$i]) { $match = $false; break }
        }
        if ($match -and $remaining -gt 0) {
            $mask = (0xff -shl (8 - $remaining)) -band 0xff
            if (($addressBytes[$full] -band $mask) -ne
                ($networkBytes[$full] -band $mask)) { $match = $false }
        }
        if ($match) { return $true }
    }
    return $false
}

function ConvertTo-ShiroBirdWfpEvent {
    param([Parameter(Mandatory=$true)][string]$EventXml,
          [string[]]$Networks = @('100.64.0.0/10'))
    try {
        [xml]$xml = $EventXml
        $eventId = [int]$xml.Event.System.EventID
        if ($eventId -notin @(5156, 5157, 5152)) { return $null }
        $values = @{}
        foreach ($item in $xml.Event.EventData.Data) {
            $name = [string]$item.GetAttribute('Name')
            if ($name) { $values[$name] = [string]$item.InnerText }
        }
        $source = [string]$values['SourceAddress']
        $dest = [string]$values['DestAddress']
        if (-not ((Test-ShiroBirdAddress $source $Networks) -or
                  (Test-ShiroBirdAddress $dest $Networks))) { return $null }
        $sourceAddress = [System.Net.IPAddress]::Parse($source).ToString()
        $destAddress = [System.Net.IPAddress]::Parse($dest).ToString()
        $proto = switch ([string]$values['Protocol']) {
            '6' {'tcp'} '17' {'udp'} '1' {'icmp'} '58' {'icmpv6'} '132' {'sctp'}
            default {$null}
        }
        if (-not $proto) { return $null }
        $type = switch ($eventId) {
            5156 {'ALLOW'} 5157 {'BLOCK'} 5152 {'DROP'}
        }
        $direction = switch -Regex ([string]$values['Direction']) {
            '^(%%14592|inbound)$' {'inbound'; break}
            '^(%%14593|outbound)$' {'outbound'; break}
            default {'unknown'}
        }
        $sport = 0; $dport = 0
        if ($values['SourcePort']) {
            $sport = [int]$values['SourcePort']
        }
        if ($values['DestPort']) {
            $dport = [int]$values['DestPort']
        }
        if ($sport -lt 0 -or $sport -gt 65535 -or
            $dport -lt 0 -or $dport -gt 65535) { return $null }
        $recordId = [long]$xml.Event.System.EventRecordID
        if ($recordId -lt 1) { return $null }
        $timestamp = [datetimeoffset]::Parse(
            [string]$xml.Event.System.TimeCreated.SystemTime,
            [globalization.cultureinfo]::InvariantCulture)
        $app = [string]$values['Application']
        if ($app.Length -gt 320) { $app = $app.Substring(0, 320) }
        $filterId = [string]$values['FilterRTID']
        if ($filterId -notmatch '^\d{1,30}$') { $filterId = '' }
        return @{
            ts = [long]$timestamp.ToUnixTimeSeconds()
            type = $type
            source = 'windows_wfp'
            proto = $proto
            src = $sourceAddress
            dst = $destAddress
            sport = $sport
            dport = $dport
            packets = $(if ($type -eq 'DROP') { 1 } else { 0 })
            bytes = 0
            direction = [string]$direction
            application = $app
            filter_id = $filterId
            event_ref = ('security:' + $recordId)
        }
    } catch {
        # Never mislabel a malformed event or invent a firewall verdict.
        return $null
    }
}

Export-ModuleMember -Function Test-ShiroBirdAddress, ConvertTo-ShiroBirdWfpEvent
