$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$pythonScript = Join-Path $scriptDir 'create-source-zip.py'
$releaseSafetyScript = Join-Path $scriptDir 'check_release_safety.py'

$commands = @(
    @('py', '-3'),
    @('python')
)

foreach ($cmd in $commands) {
    $name = $cmd[0]
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        continue
    }

    $args = @()
    if ($cmd.Length -gt 1) {
        $args += $cmd[1..($cmd.Length - 1)]
    }
    $runtimeArgs = @($args)
    $zipArgs = @($runtimeArgs)
    $zipArgs += $pythonScript

    Push-Location $repoRoot
    try {
        if (Test-Path $releaseSafetyScript) {
            & $name @runtimeArgs $releaseSafetyScript
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Release safety check failed before ZIP creation."
                exit $LASTEXITCODE
            }
        }
        & $name @zipArgs
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

Write-Host '[ERROR] Python runtime not found.' -ForegroundColor Red
Write-Host 'Next action: install Python 3.10+ (or run npm run setup:local after Python install).' -ForegroundColor Yellow
exit 1
