[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$JobZip,

    [switch]$AllowStateChange
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-FailureNextAction {
    Write-Host ""
    Write-Host "NEXT_ACTION_REQUIRED=1"
    Write-Host "NEXT_ACTION_INSTRUCTION=Paste the complete output into ChatGPT. Do not run another repository-changing operation until a concrete next step is provided."
    Write-Host "NEXT_ACTION_EXPECTED_RESULT=The failure is reviewed and the next required concrete operation is provided."
    Write-Host "NEXT_ACTION_STATE_CHANGE=false"
}

trap {
    Write-Host ""
    Write-Host $_.Exception.Message
    Write-FailureNextAction
    exit 1
}

# Resolve repository root from this script's own installed location.
$repo = Split-Path -Parent $PSScriptRoot
if (-not $repo) {
    throw "[AI-WORKFLOW-GATE] Repository root could not be resolved from PSScriptRoot."
}

$runner = Join-Path $PSScriptRoot "ai_workflow_gate.py"

if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "[AI-WORKFLOW-GATE] Runner not found: $runner"
}


function Install-PublishGuard {
    param([Parameter(Mandatory = $true)][string]$Repo)

    $marker = "# KANADE_AI_PUBLISH_GUARD_V2"
    $preCommitBridgeMarker = "# KANADE_AI_PRE_COMMIT_BRIDGE_V1"
    $tokenEnvName = "KANADE_AI_PUBLISH_TOKEN"
    $tokenFileName = "kanade-ai-publish-token"

    $commonDirRaw = (& git -C $Repo rev-parse --git-common-dir)
    if ($LASTEXITCODE -ne 0) {
        throw "[AI-WORKFLOW-GATE] Git common directory could not be resolved."
    }

    $commonDirText = ([string]$commonDirRaw).Trim()
    if ([string]::IsNullOrWhiteSpace($commonDirText)) {
        throw "[AI-WORKFLOW-GATE] Git common directory is empty."
    }

    if ([System.IO.Path]::IsPathRooted($commonDirText)) {
        $commonDir = [System.IO.Path]::GetFullPath($commonDirText)
    }
    else {
        $commonDir = [System.IO.Path]::GetFullPath((Join-Path $Repo $commonDirText))
    }

    $trackedPreCommitPath = Join-Path $Repo ".githooks\pre-commit"
    if (-not (Test-Path -LiteralPath $trackedPreCommitPath -PathType Leaf)) {
        throw "[AI-WORKFLOW-GATE] Required tracked pre-commit hook is missing: .githooks/pre-commit"
    }

    $managedHooksDir = Join-Path $commonDir "kanade-hooks"
    $prePushHookPath = Join-Path $managedHooksDir "pre-push"
    $preCommitHookPath = Join-Path $managedHooksDir "pre-commit"
    $legacyPrePushHookPath = Join-Path (Join-Path $commonDir "hooks") "pre-push"
    $tokenPath = Join-Path $commonDir $tokenFileName
    [System.IO.Directory]::CreateDirectory($managedHooksDir) | Out-Null

    $prePushLines = @(
        "#!/bin/sh",
        $marker,
        "TOKEN_FILE=`"`$(git rev-parse --git-common-dir 2>/dev/null)/$tokenFileName`"",
        "if [ ! -f `"`$TOKEN_FILE`" ]; then",
        "    echo `"[KAN-AI-PUBLISH-GUARD] Direct git push is blocked. Use scripts/run_ai_job.ps1 with an approved deploy_test job.`" >&2",
        "    exit 1",
        "fi",
        "EXPECTED_TOKEN=`"`$(cat `"`$TOKEN_FILE`")`"",
        "if [ -z `"`$EXPECTED_TOKEN`" ] || [ `"`${${tokenEnvName}:-}`" != `"`$EXPECTED_TOKEN`" ]; then",
        "    echo `"[KAN-AI-PUBLISH-GUARD] Direct git push is blocked. Use scripts/run_ai_job.ps1 with an approved deploy_test job.`" >&2",
        "    exit 1",
        "fi",
        "exit 0"
    )
    $expectedPrePush = ($prePushLines -join "`n") + "`n"

    $preCommitBridgeLines = @(
        "#!/bin/sh",
        $preCommitBridgeMarker,
        'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 2',
        'exec "$REPO_ROOT/.githooks/pre-commit" "$@"'
    )
    $expectedPreCommitBridge = ($preCommitBridgeLines -join "`n") + "`n"

    if (Test-Path -LiteralPath $prePushHookPath -PathType Leaf) {
        $existingPrePush = [System.IO.File]::ReadAllText($prePushHookPath)
        if (-not $existingPrePush.Contains($marker)) {
            throw "[AI-WORKFLOW-GATE] Existing unmanaged managed-directory pre-push hook detected. Refusing to overwrite it."
        }
    }

    if (Test-Path -LiteralPath $preCommitHookPath -PathType Leaf) {
        $existingPreCommit = [System.IO.File]::ReadAllText($preCommitHookPath)
        if (-not $existingPreCommit.Contains($preCommitBridgeMarker)) {
            throw "[AI-WORKFLOW-GATE] Existing unmanaged managed-directory pre-commit hook detected. Refusing to overwrite it."
        }
    }

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($prePushHookPath, $expectedPrePush, $utf8NoBom)
    [System.IO.File]::WriteAllText($preCommitHookPath, $expectedPreCommitBridge, $utf8NoBom)

    if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
        $token = [System.IO.File]::ReadAllText($tokenPath).Trim()
        if ($token -notmatch "^[0-9a-f]{64}$") {
            throw "[AI-WORKFLOW-GATE] Existing publish guard token is invalid."
        }
    }
    else {
        $token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).ToLowerInvariant()
        [System.IO.File]::WriteAllText($tokenPath, $token, $utf8NoBom)
    }

    $managedHooksConfigPath = ".git/kanade-hooks"

    & git -C $Repo config --local core.hooksPath $managedHooksConfigPath
    if ($LASTEXITCODE -ne 0) {
        throw "[AI-WORKFLOW-GATE] Failed to activate managed Git hooks."
    }

    $effectiveHooksPath = ([string](& git -C $Repo config --local --get core.hooksPath)).Trim().Replace("\", "/")
    if (-not [string]::Equals(
        $effectiveHooksPath,
        $managedHooksConfigPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "[AI-WORKFLOW-GATE] Managed Git hooks path verification failed."
    }

    if (Test-Path -LiteralPath $legacyPrePushHookPath -PathType Leaf) {
        $legacyHook = [System.IO.File]::ReadAllText($legacyPrePushHookPath)
        if ($legacyHook.Contains("# KANADE_AI_PUBLISH_GUARD_V1")) {
            Remove-Item -LiteralPath $legacyPrePushHookPath -Force
        }
    }

    return $token
}

$resolvedJob = (Resolve-Path -LiteralPath $JobZip -ErrorAction Stop).Path

$args = @(
    $runner,
    $resolvedJob
)

if ($AllowStateChange) {
    $args += "--allow-state-change"
}

$runnerTokenEnvName = "KANADE_AI_RUNNER_TOKEN"
$previousRunnerToken = [Environment]::GetEnvironmentVariable($runnerTokenEnvName, "Process")
$runnerTokenWasSet = $null -ne $previousRunnerToken

$runnerToken = Install-PublishGuard -Repo $repo
[Environment]::SetEnvironmentVariable($runnerTokenEnvName, $runnerToken, "Process")
Write-Host "PUBLISH_GUARD=ACTIVE"

Push-Location $repo
try {
    & python @args
    $gateExit = $LASTEXITCODE
}
finally {
    Pop-Location

    if ($runnerTokenWasSet) {
        [Environment]::SetEnvironmentVariable($runnerTokenEnvName, $previousRunnerToken, "Process")
    }
    else {
        [Environment]::SetEnvironmentVariable($runnerTokenEnvName, $null, "Process")
    }
}

Write-Host ""
Write-Host "AI_WORKFLOW_GATE_PROCESS_EXIT=$gateExit"

if ($gateExit -ne 0) {
    throw "[AI-WORKFLOW-GATE] Job was rejected or failed. No later operation was executed."
}
