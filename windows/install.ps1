# Windows ShiroBird installer. Run elevated PowerShell 5.1+ on a NetBird peer.
# Never installs/patches the official NetBird client.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServerUrl,
    [string[]]$Networks = @('100.64.0.0/10'),
    [switch]$EnableBlockedConnectionAudit,
    [switch]$EnableAllowedConnectionAudit,
    [switch]$EnablePacketDropAudit
)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:ProgramData "ShiroBird"
if (-not $ServerUrl.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The collector requires an HTTPS server endpoint"
}
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator rights required to register the scheduled task"
}
$secure = Read-Host "ShiroBird ingest secret (from the server .env)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ($token.Length -lt 32) { throw "The ingest secret must be at least 32 characters" }
New-Item -ItemType Directory -Path $root -Force | Out-Null
# Restrict tokens and local Security event snapshots to SYSTEM and local Administrators.
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to secure ShiroBird data directory" }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($file in @("ShiroBird.Wfp.psm1", "shirobird-wfp-collector.ps1")) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $root $file) -Force
}
@{
    server = $ServerUrl.TrimEnd('/')
    ingest_token = $token
    sensor = $env:COMPUTERNAME.ToLowerInvariant()
    networks = @($Networks)
} | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $root "collector.json") -Encoding UTF8
Remove-Variable token -ErrorAction SilentlyContinue
if ($EnableBlockedConnectionAudit -or $EnableAllowedConnectionAudit) {
    $subcategory = '{0CCE9226-69AE-11D9-BED3-505054503030}'
    $argsList = @('/set',('/subcategory:' + $subcategory))
    if ($EnableBlockedConnectionAudit) { $argsList += '/failure:enable' }
    if ($EnableAllowedConnectionAudit) { $argsList += '/success:enable' }
    & auditpol.exe @argsList | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to enable WFP Connection audit category" }
}
if ($EnablePacketDropAudit) {
    & auditpol.exe '/set' '/subcategory:{0CCE9225-69AE-11D9-BED3-505054503030}' '/failure:enable' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to enable packet-drop auditing" }
}
$script = Join-Path $root "shirobird-wfp-collector.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$who = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "ShiroBird WFP Collector" -Action $action `
    -Trigger $trigger -Principal $who -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "ShiroBird WFP Collector"
Write-Host "ShiroBird WFP sensor configured. No NetBird client or firewall rule was modified."
Write-Host "Audit success enabled:" ([bool]$EnableAllowedConnectionAudit)
Write-Host "Audit connection failure enabled:" ([bool]$EnableBlockedConnectionAudit)
Write-Host "Audit packet-drop failure enabled:" ([bool]$EnablePacketDropAudit)
Write-Host "Verify sensor heartbeat in ShiroBird > Traffic Flow > Collector coverage."
Write-Warning "WFP Security audit events can be extremely high-volume. Monitor Security log size and disk activity."
