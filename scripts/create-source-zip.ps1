$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$pythonScript = Join-Path $scriptDir 'create-source-zip.py'

$commands = @(
    @('py', '-3'),
    @('python'),
    @('uv', 'run', 'python')
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
    $args += $pythonScript

    Push-Location $repoRoot
    try {
        & $name @args
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

Write-Error "Python runtime not found. Install or enable py, python, or uv."
exit 1
