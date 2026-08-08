[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$JobZip,

    [switch]$AllowStateChange
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Resolve repository root from this script's own installed location.
$repo = Split-Path -Parent $PSScriptRoot
if (-not $repo) {
    throw "[AI-WORKFLOW-GATE] Repository root could not be resolved from PSScriptRoot."
}

$runner = Join-Path $PSScriptRoot "ai_workflow_gate.py"

if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "[AI-WORKFLOW-GATE] Runner not found: $runner"
}

$resolvedJob = (Resolve-Path -LiteralPath $JobZip -ErrorAction Stop).Path

$args = @(
    $runner,
    $resolvedJob
)

if ($AllowStateChange) {
    $args += "--allow-state-change"
}

Push-Location $repo
try {
    & python @args
    $gateExit = $LASTEXITCODE
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "AI_WORKFLOW_GATE_PROCESS_EXIT=$gateExit"

if ($gateExit -ne 0) {
    throw "[AI-WORKFLOW-GATE] Job was rejected or failed. No later operation was executed."
}
