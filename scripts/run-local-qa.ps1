$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$distDir = Join-Path $repoRoot 'dist/source-share'
$qaArtifactDir = Join-Path $repoRoot 'dist/qa'

Set-Location $repoRoot

function Test-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-PythonReady {
    return (Test-Path (Join-Path $repoRoot 'uv.lock')) -or (Test-Path (Join-Path $repoRoot '.venv'))
}

function Test-NodeReady {
    return (Test-Path (Join-Path $repoRoot 'node_modules')) -or (Test-Path (Join-Path $repoRoot 'package-lock.json'))
}

$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param(
        [string]$Step,
        [bool]$Success,
        [string]$Hint,
        [string]$ErrorText
    )
    $results.Add([pscustomobject]@{
        step = $Step
        success = $Success
        hint = $Hint
        error = $ErrorText
    })
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Hint
    )

    Write-Host "[RUN] $Name" -ForegroundColor Cyan
    try {
        $global:LASTEXITCODE = 0
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "Command exited with code $LASTEXITCODE"
        }
        Write-Host "[OK ] $Name" -ForegroundColor Green
        Add-Result -Step $Name -Success $true -Hint $Hint -ErrorText ''
    }
    catch {
        Write-Host "[NG ] $Name" -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "      Manual command: $Hint" -ForegroundColor Yellow
        Add-Result -Step $Name -Success $false -Hint $Hint -ErrorText $_.Exception.Message
    }
}

if (-not (Test-CommandAvailable -Name 'uv')) {
    Write-Host '[ERROR] uv command not found. Run setup:local first.' -ForegroundColor Red
    Write-Host 'Manual command: npm run setup:local' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-CommandAvailable -Name 'npm')) {
    Write-Host '[ERROR] npm command not found. Install Node.js first.' -ForegroundColor Red
    Write-Host 'Manual command: npm run setup:local' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-PythonReady)) {
    Write-Host '[WARN] Python dependencies may be missing.' -ForegroundColor Yellow
    Write-Host 'Manual command: uv sync --extra dev' -ForegroundColor Yellow
}

if (-not (Test-NodeReady)) {
    Write-Host '[WARN] Node dependencies may be missing.' -ForegroundColor Yellow
    Write-Host 'Manual command: npm install' -ForegroundColor Yellow
}

if (-not (Test-Path $qaArtifactDir)) {
    New-Item -ItemType Directory -Path $qaArtifactDir | Out-Null
}

Invoke-Step -Name 'python -m compileall -q src/backend tests' -Action { uv run python -m compileall -q src/backend tests } -Hint 'uv run python -m compileall -q src/backend tests'
Invoke-Step -Name 'npm run check:release-safety' -Action { npm run check:release-safety } -Hint 'npm run check:release-safety'
Invoke-Step -Name 'npm run check:security:python' -Action { npm run check:security:python } -Hint 'npm run check:security:python'
Invoke-Step -Name 'npm run check:types:backend' -Action { npm run check:types:backend } -Hint 'npm run check:types:backend'
Invoke-Step -Name 'npm run check:frontend:syntax' -Action { npm run check:frontend:syntax } -Hint 'npm run check:frontend:syntax'
Invoke-Step -Name 'npm run check:frontend:load-order' -Action { npm run check:frontend:load-order } -Hint 'npm run check:frontend:load-order'
Invoke-Step -Name 'npm run check:frontend:state-access' -Action { npm run check:frontend:state-access } -Hint 'npm run check:frontend:state-access'
Invoke-Step -Name 'npm run check:ops:checklists' -Action { npm run check:ops:checklists } -Hint 'npm run check:ops:checklists'
Invoke-Step -Name 'npm run check:tenant:migration' -Action { npm run check:tenant:migration } -Hint 'npm run check:tenant:migration'
Invoke-Step -Name 'npm run check:decision-log' -Action { npm run check:decision-log } -Hint 'npm run check:decision-log'
Invoke-Step -Name 'pytest' -Action { uv run pytest } -Hint 'uv run pytest'
Invoke-Step -Name 'npm run test:frontend' -Action { npm run test:frontend } -Hint 'npm run test:frontend'
Invoke-Step -Name 'npm run test:e2e' -Action { npm run test:e2e } -Hint 'npx playwright install --with-deps chromium ; npm run test:e2e'
Invoke-Step -Name 'python scripts/create-source-zip.py' -Action { uv run python scripts/create-source-zip.py } -Hint 'uv run python scripts/create-source-zip.py'
Invoke-Step -Name 'npm run zip:source' -Action { npm run zip:source } -Hint 'npm run zip:source'
Invoke-Step -Name 'npm run check:release:readiness' -Action { npm run check:release:readiness } -Hint 'npm run check:release:readiness'

$latestZip = $null
if (Test-Path $distDir) {
    $latestZip = Get-ChildItem (Join-Path $distDir '*.zip') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

$dangerPatterns = @(
    '\\.env$',
    '/\\.git/',
    '/node_modules/',
    '/\\.venv/',
    '\\.(wav|mp3|m4a|flac)$',
    '\\.(db|sqlite|sqlite3)$',
    'credentials',
    'service-account'
)

$dangerHits = @()
if ($latestZip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($latestZip.FullName)
    try {
        foreach ($entry in $zip.Entries) {
            $entryName = $entry.FullName
            foreach ($pattern in $dangerPatterns) {
                if ($entryName -match $pattern) {
                    $dangerHits += $entryName
                    break
                }
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

Write-Host ''
Write-Host '===== QA Local Summary =====' -ForegroundColor Cyan
foreach ($item in $results) {
    $mark = if ($item.success) { '[PASS]' } else { '[FAIL]' }
    Write-Host "$mark $($item.step)"
}

$failed = @($results | Where-Object { -not $_.success })
Write-Host ''
if ($latestZip) {
    $sizeMB = [Math]::Round($latestZip.Length / 1MB, 2)
    $entriesCount = 0
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip2 = [System.IO.Compression.ZipFile]::OpenRead($latestZip.FullName)
    try {
        $entriesCount = $zip2.Entries.Count
    }
    finally {
        $zip2.Dispose()
    }

    Write-Host "ZIP file: $($latestZip.Name)"
    Write-Host "ZIP path: $($latestZip.FullName)"
    Write-Host "ZIP size: ${sizeMB}MB"
    Write-Host "ZIP entry count: $entriesCount"

    if ($dangerHits.Count -eq 0) {
        Write-Host 'Dangerous file scan: PASS (none found)' -ForegroundColor Green
    }
    else {
        Write-Host 'Dangerous file scan: FAIL (found entries)' -ForegroundColor Red
        $dangerHits | Select-Object -Unique | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    }
}
else {
    Write-Host 'ZIP file: not found' -ForegroundColor Yellow
}

if ($failed.Count -eq 0 -and $dangerHits.Count -eq 0) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $artifact = [pscustomobject]@{
        generatedAt = (Get-Date).ToString('o')
        summary = 'PASS'
        totalSteps = $results.Count
        failedSteps = 0
        zipFile = if ($latestZip) { $latestZip.Name } else { '' }
        zipPath = if ($latestZip) { $latestZip.FullName } else { '' }
        dangerHits = @()
        steps = $results
    }
    $artifactPath = Join-Path $qaArtifactDir "qa-local-result-$timestamp.json"
    $artifact | ConvertTo-Json -Depth 6 | Set-Content -Path $artifactPath -Encoding UTF8
    Write-Host "QA artifact: $artifactPath"

    Write-Host ''
    Write-Host '[DONE] qa:local completed successfully.' -ForegroundColor Green
    exit 0
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$artifact = [pscustomobject]@{
    generatedAt = (Get-Date).ToString('o')
    summary = 'FAIL'
    totalSteps = $results.Count
    failedSteps = $failed.Count
    zipFile = if ($latestZip) { $latestZip.Name } else { '' }
    zipPath = if ($latestZip) { $latestZip.FullName } else { '' }
    dangerHits = @($dangerHits | Select-Object -Unique)
    steps = $results
}
$artifactPath = Join-Path $qaArtifactDir "qa-local-result-$timestamp.json"
$artifact | ConvertTo-Json -Depth 6 | Set-Content -Path $artifactPath -Encoding UTF8
Write-Host "QA artifact: $artifactPath"

Write-Host ''
Write-Host '[WARN] qa:local finished with failures. Review FAIL entries above.' -ForegroundColor Yellow
exit 1
