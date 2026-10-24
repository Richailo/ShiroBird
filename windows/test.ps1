$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($path in @('ShiroBird.Wfp.psm1', 'shirobird-wfp-collector.ps1', 'install.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $root $path), [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw ("PowerShell syntax error in " + $path + ": " + $errors[0].Message)
    }
}
Import-Module (Join-Path $root "ShiroBird.Wfp.psm1") -Force
function Check([bool]$ok, [string]$name) {
    if (-not $ok) { throw "Failed: $name" }
    Write-Host "PASS: $name"
}
Check (Test-ShiroBirdAddress '100.64.1.2' @('100.64.0.0/10')) 'IPv4 VPN CIDR'
Check (-not (Test-ShiroBirdAddress '8.8.8.8' @('100.64.0.0/10'))) 'CIDR excludes internet'
Check (Test-ShiroBirdAddress 'fdba:3a54::2' @('fdba:3a54::/32')) 'IPv6 VPN CIDR'
$xml = @'
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System>
    <Provider Name="Microsoft-Windows-Security-Auditing"/>
    <EventID>5157</EventID><EventRecordID>13245</EventRecordID>
    <TimeCreated SystemTime="2026-10-24T18:22:11.2340000Z"/>
  </System>
  <EventData>
    <Data Name="ProcessID">1234</Data>
    <Data Name="Application">C:\Windows\System32\test.exe</Data>
    <Data Name="Direction">%%14593</Data>
    <Data Name="SourceAddress">100.64.177.75</Data>
    <Data Name="SourcePort">51235</Data>
    <Data Name="DestAddress">100.64.177.76</Data>
    <Data Name="DestPort">443</Data>
    <Data Name="Protocol">6</Data>
    <Data Name="FilterRTID">70201</Data>
  </EventData>
</Event>
'@
$result = ConvertTo-ShiroBirdWfpEvent -EventXml $xml -Networks @('100.64.0.0/10')
Check ($null -ne $result) 'Windows WFP XML parsing'
Check ($result.type -eq 'BLOCK') '5157 is blocked connection'
Check ($result.direction -eq 'outbound') 'WFP outbound direction'
Check ($result.filter_id -eq '70201') 'Runtime filter reference'
Check ($result.event_ref -eq 'security:13245') 'Stable record cursor'
Check ($result.source -eq 'windows_wfp') 'Explicit telemetry source'
Check ((ConvertTo-ShiroBirdWfpEvent -EventXml $xml -Networks @('10.0.0.0/8')) -eq $null) 'Out-of-VPN filtering'
$allowed = ConvertTo-ShiroBirdWfpEvent -EventXml ($xml.Replace('5157','5156')) -Networks @('100.64.0.0/10')
Check ($allowed.type -eq 'ALLOW') '5156 permitted connection'
$dropped = ConvertTo-ShiroBirdWfpEvent -EventXml ($xml.Replace('5157','5152')) -Networks @('100.64.0.0/10')
Check ($dropped.type -eq 'DROP' -and $dropped.packets -eq 1) '5152 packet-drop event'
Write-Host 'All ShiroBird Windows WFP parser tests passed.'
