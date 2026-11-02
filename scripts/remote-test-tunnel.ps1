param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$relayStatePath = Join-Path $projectRoot '.remote-host.json'
$relayToolDir = Join-Path $projectRoot 'tools\cloudflared'
$relayExecutable = Join-Path $relayToolDir 'cloudflared.exe'
if (Test-Path -LiteralPath $relayStatePath) {
    $relaySaved = Get-Content -LiteralPath $relayStatePath -Raw | ConvertFrom-Json
    $relayRunning = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$relaySaved.processId)" -ErrorAction SilentlyContinue
    if ($relayRunning -and $relayRunning.ExecutablePath -eq $relayExecutable) {
        if ($Stop) { Stop-Process -Id $relayRunning.ProcessId; Remove-Item -LiteralPath $relayStatePath; Write-Output 'Temporary Chappie tunnel stopped.'; exit }
        try { $health = Invoke-RestMethod "$($relaySaved.url)/health" -TimeoutSec 5; if ($health.service -eq 'chappie-remote') { Write-Output $relaySaved.url; exit } } catch { }
        throw 'A tunnel process is still running but not healthy. Run this script with -Stop before starting another.'
    }
}
if ($Stop) { Write-Output 'No verified Chappie tunnel process is running.'; exit }
$relayLocalHealth = Invoke-RestMethod 'http://127.0.0.1:37842/health' -TimeoutSec 3
if ($relayLocalHealth.service -ne 'chappie-remote') { throw 'Start the Chappie host first.' }
New-Item -ItemType Directory -Path $relayToolDir -Force | Out-Null
$relayExpectedHash = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'
if (-not (Test-Path -LiteralPath $relayExecutable)) {
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe' -OutFile $relayExecutable
}
if ((Get-FileHash -LiteralPath $relayExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $relayExpectedHash) { throw 'cloudflared checksum mismatch. No tunnel was started.' }
$relayLogs = Join-Path $projectRoot '.logs'
New-Item -ItemType Directory -Path $relayLogs -Force | Out-Null
$relayOut = Join-Path $relayLogs 'tunnel-output.log'
$relayErr = Join-Path $relayLogs 'tunnel-error.log'
$relayProcess = Start-Process -FilePath $relayExecutable -ArgumentList @('tunnel','--url','http://127.0.0.1:37842','--no-autoupdate','--protocol','http2') -WindowStyle Hidden -RedirectStandardOutput $relayOut -RedirectStandardError $relayErr -PassThru
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Seconds 1
    $relayText = (Get-Content -LiteralPath $relayErr -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $relayOut -Raw -ErrorAction SilentlyContinue)
    $relayMatch = [regex]::Match($relayText, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($relayMatch.Success) {
        $relayAddress = $relayMatch.Value
        try {
            $health = Invoke-RestMethod "$relayAddress/health" -TimeoutSec 5
            if ($health.service -eq 'chappie-remote') {
                @{url=$relayAddress;processId=$relayProcess.Id;version='2026.10.7';startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $relayStatePath -Encoding UTF8
                Write-Output $relayAddress
                exit
            }
        } catch { }
    }
    if ($relayProcess.HasExited) { throw 'The tunnel process exited. Check .logs\tunnel-error.log.' }
}
Stop-Process -Id $relayProcess.Id -ErrorAction SilentlyContinue
throw 'Temporary tunnel did not become healthy. No public address was saved.'
