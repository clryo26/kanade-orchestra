$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir

Set-Location $repoRoot

function Test-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$FailureHint
    )

    Write-Host "[RUN] $Name" -ForegroundColor Cyan
    try {
        $global:LASTEXITCODE = 0
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "Command exited with code $LASTEXITCODE"
        }
        Write-Host "[OK ] $Name" -ForegroundColor Green
        return $true
    }
    catch {
        Write-Host "[NG ] $Name" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "      Manual command: $FailureHint" -ForegroundColor Yellow
        return $false
    }
}

$allSucceeded = $true

if (-not (Test-CommandAvailable -Name 'uv')) {
    Write-Host '[ERROR] uv command not found.' -ForegroundColor Red
    Write-Host 'Install hint (PowerShell): irm https://astral.sh/uv/install.ps1 | iex' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-CommandAvailable -Name 'npm')) {
    Write-Host '[ERROR] npm command not found. Install Node.js first.' -ForegroundColor Red
    Write-Host 'Manual command: winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
    exit 1
}

$stepOk = Invoke-Step -Name 'uv sync --extra dev' -Action { uv sync --extra dev } -FailureHint 'uv sync --extra dev'
if (-not $stepOk) { $allSucceeded = $false }

$stepOk = Invoke-Step -Name 'npm install' -Action { npm install } -FailureHint 'npm install --verbose'
if (-not $stepOk) { $allSucceeded = $false }

if (-not (Test-CommandAvailable -Name 'npx')) {
    Write-Host '[NG ] npx command not found. Check npm installation.' -ForegroundColor Red
    Write-Host 'Manual command: npm install -g npm' -ForegroundColor Yellow
    $allSucceeded = $false
}
else {
    $stepOk = Invoke-Step -Name 'npx playwright install' -Action { npx playwright install } -FailureHint 'npx playwright install --with-deps chromium'
    if (-not $stepOk) {
        Write-Host 'Playwright browser install is required before npm run test:e2e.' -ForegroundColor Yellow
        $allSucceeded = $false
    }
}

if ($allSucceeded) {
    Write-Host ''
    Write-Host '[DONE] setup:local completed successfully.' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host '[WARN] setup:local finished with failures. See manual commands above.' -ForegroundColor Yellow
exit 1
