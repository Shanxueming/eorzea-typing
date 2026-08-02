$ErrorActionPreference = 'Stop'
$gameRoot = Split-Path -Parent $PSScriptRoot
Set-Location $gameRoot

function Fail([string]$message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Test-GameServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8799/healthz'
    return $response.Content -match '"ok":true'
  } catch {
    return $false
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found. Install Node.js LTS, then run the launcher again.'
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$useCorepack = $false
if (-not $pnpmCommand) {
  if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    Fail 'pnpm or Corepack was not found. Install pnpm, then run the launcher again.'
  }
  $useCorepack = $true
}

function Invoke-Pnpm([string[]]$arguments) {
  if ($useCorepack) {
    & corepack pnpm @arguments
  } else {
    & pnpm @arguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

try {
  Write-Host '[1/3] Checking dependencies...'
  if (-not (Test-Path 'node_modules/.modules.yaml')) {
    Write-Host 'First launch: installing dependencies...'
    Invoke-Pnpm @('install')
  }

  Write-Host '[2/3] Building the game...'
  Invoke-Pnpm @('build')

  Write-Host '[3/3] Starting the local game server...'
  if (-not (Test-GameServer)) {
    if (Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue) {
      Fail 'Port 8799 is occupied by a process that is not the game server.'
    }
    $startCommand = if ($useCorepack) { 'call corepack pnpm start' } else { 'call pnpm start' }
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $startCommand) -WorkingDirectory $gameRoot -WindowStyle Minimized
    $ready = $false
    foreach ($attempt in 1..15) {
      Start-Sleep -Seconds 1
      if (Test-GameServer) {
        $ready = $true
        break
      }
    }
    if (-not $ready) {
      Fail 'The game server did not start within 15 seconds.'
    }
  }

  Write-Host 'Ready: http://localhost:8799/' -ForegroundColor Green
  if (-not $env:EORZEA_NO_BROWSER) {
    Start-Process 'http://localhost:8799/'
  }
} catch {
  Fail $_.Exception.Message
}
