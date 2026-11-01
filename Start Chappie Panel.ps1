$ErrorActionPreference = 'Stop'
$panelAddress = 'http://127.0.0.1:37841'
try {
    $panelHealth = Invoke-RestMethod "$panelAddress/health" -TimeoutSec 2
    if ($panelHealth.app -eq 'chappie-panel') { Start-Process $panelAddress; exit }
} catch { }
$relayNode = (Get-Command node -ErrorAction Stop).Source
$relayLogDir = Join-Path $PSScriptRoot '.logs'
New-Item -ItemType Directory -Path $relayLogDir -Force | Out-Null
Start-Process -FilePath $relayNode -ArgumentList @('"node_modules/tsx/dist/cli.mjs"', '"src/bot.ts"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $relayLogDir 'bot.log') -RedirectStandardError (Join-Path $relayLogDir 'bot-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $panelHealth = Invoke-RestMethod "$panelAddress/health" -TimeoutSec 1
        if ($panelHealth.app -eq 'chappie-panel') { Start-Process $panelAddress; exit }
    } catch { }
}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show("Chappie could not start. Check .logs\bot-error.log in the project folder.", 'Chappie') | Out-Null
