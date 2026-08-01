[CmdletBinding()]
param(
    [string]$BaseBranch = "main",
    [string]$ProjectId = "kanade-orchestra",
    [string]$Region = "asia-northeast2",
    [string]$TestService = "kanade-orchestra-test",
    [int]$RunDiscoveryTimeoutSeconds = 900,
    [int]$PollIntervalSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message"
}

function Stop-Deploy {
    param([string]$Message)
    throw "[ERROR] $Message"
}

function Require-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-Deploy "Required command not found: $Name"
    }
}

function Invoke-GhApiJson {
    param([string]$Endpoint)

    $output = gh api --method GET $Endpoint
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "GitHub API request failed: $Endpoint"
    }

    return ($output | ConvertFrom-Json)
}

function Wait-WorkflowRun {
    param(
        [string]$Repo,
        [string]$WorkflowFile,
        [string]$Event,
        [string]$Branch = "",
        [string]$HeadSha = "",
        [int]$PullRequestNumber = 0,
        [datetime]$NotBefore
    )

    $deadline = (Get-Date).AddSeconds($RunDiscoveryTimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        $query = @(
            "event=$([uri]::EscapeDataString($Event))",
            "per_page=50"
        )

        if ($Branch) {
            $query += "branch=$([uri]::EscapeDataString($Branch))"
        }

        if ($HeadSha) {
            $query += "head_sha=$([uri]::EscapeDataString($HeadSha))"
        }

        $endpoint = "repos/$Repo/actions/workflows/$WorkflowFile/runs?" + ($query -join "&")
        $response = Invoke-GhApiJson $endpoint

        $runs = @(
            @($response.workflow_runs) | Where-Object {
                $createdAt = [datetime]$_.created_at
                if ($createdAt -lt $NotBefore) {
                    return $false
                }

                if ($PullRequestNumber -gt 0) {
                    $numbers = @($_.pull_requests | ForEach-Object { [int]$_.number })
                    return $numbers -contains $PullRequestNumber
                }

                return $true
            } | Sort-Object { [datetime]$_.created_at } -Descending
        )

        if ($runs.Count -gt 0) {
            return $runs[0]
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    Stop-Deploy "Timed out waiting for workflow: $WorkflowFile / event=$Event"
}

function Watch-WorkflowRun {
    param(
        [long]$RunId,
        [string]$Label
    )

    Write-Step "Waiting for $Label (run $RunId)"
    gh run watch $RunId --exit-status
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "$Label failed. Run ID: $RunId"
    }

    Write-Ok "$Label succeeded (run $RunId)"
}

try {
    Write-Step "Checking prerequisites"

    Require-Command git
    Require-Command gh
    Require-Command gcloud

    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Current directory is not a Git repository."
    }

    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "GitHub CLI is not authenticated."
    }

    $branch = (git branch --show-current).Trim()
    if (-not $branch) {
        Stop-Deploy "Current Git branch could not be determined."
    }

    if ($branch -eq "main" -or $branch -eq "master") {
        Stop-Deploy "Deployment automation cannot run directly from $branch."
    }

    $status = @(git status --porcelain)
    if ($status.Count -gt 0) {
        Stop-Deploy "Working tree is not clean. Commit or restore all changes before deployment."
    }

    $headSha = (git rev-parse HEAD).Trim()
    if (-not $headSha) {
        Stop-Deploy "Current HEAD SHA could not be determined."
    }

    $repo = (gh repo view --json nameWithOwner --jq ".nameWithOwner").Trim()
    if ($LASTEXITCODE -ne 0 -or -not $repo) {
        Stop-Deploy "GitHub repository could not be determined."
    }

    Write-Ok "Repository: $repo"
    Write-Ok "Branch: $branch"
    Write-Ok "HEAD: $headSha"

    Write-Step "Fetching $BaseBranch"

    git fetch origin $BaseBranch
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "git fetch failed."
    }

    $baseSha = (git rev-parse "origin/$BaseBranch").Trim()
    git merge-base --is-ancestor $baseSha $headSha
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Current branch is not based on latest origin/$BaseBranch. Rebase or recreate the branch before deployment."
    }

    Write-Ok "Current branch contains latest origin/$BaseBranch ($baseSha)"

    Write-Step "Pushing branch"

    git push -u origin $branch
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "git push failed."
    }

    Write-Ok "Push completed"

    Write-Step "Creating or locating pull request"

    $existingPrJson = gh pr list `
        --head $branch `
        --base $BaseBranch `
        --state open `
        --limit 1 `
        --json number,url

    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Failed to query existing pull requests."
    }

    $existingPrJsonText = [string]$existingPrJson
    $existingPrListIsEmpty = [string]::IsNullOrWhiteSpace($existingPrJsonText) -or ($existingPrJsonText.Trim() -eq "[]")

    if ($existingPrListIsEmpty) {
        $existingPr = @()
    }
    else {
        $existingPr = @($existingPrJsonText | ConvertFrom-Json)
    }

    if ($existingPr.Count -gt 0) {
        $prNumber = [int]$existingPr[0].number
        $prUrl = [string]$existingPr[0].url
        Write-Ok "Using existing PR #$prNumber"
    }
    else {
        $title = (git log -1 --pretty=%s).Trim()
        $prBody = @"
Automated test deployment PR.

Source branch: $branch
Source commit: $headSha

After PR CI succeeds, this automation merges the PR and waits for main CI and Deploy Test.
"@

        gh pr create `
            --base $BaseBranch `
            --head $branch `
            --title $title `
            --body $prBody *> $null

        if ($LASTEXITCODE -ne 0) {
            Stop-Deploy "PR creation failed."
        }

        $prInfo = gh pr view $branch --json number,url | ConvertFrom-Json
        $prNumber = [int]$prInfo.number
        $prUrl = [string]$prInfo.url

        Write-Ok "Created PR #$prNumber"
    }

    Write-Host "PR: $prUrl"

    $prCreatedAt = (Get-Date).ToUniversalTime().AddMinutes(-2)

    Write-Step "Waiting for PR CI to start"

    $prCiRun = Wait-WorkflowRun `
        -Repo $repo `
        -WorkflowFile "ci.yml" `
        -Event "pull_request" `
        -Branch $branch `
        -PullRequestNumber $prNumber `
        -NotBefore $prCreatedAt

    Write-Ok "PR CI detected (run $($prCiRun.id))"

    Watch-WorkflowRun `
        -RunId ([long]$prCiRun.id) `
        -Label "PR CI"

    Write-Step "Merging PR #$prNumber"

    gh pr merge $prNumber --merge
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "PR merge failed. PR #$prNumber"
    }

    $mergedPr = gh pr view $prNumber --json state,mergedAt,mergeCommit,url | ConvertFrom-Json

    if ($mergedPr.state -ne "MERGED") {
        Stop-Deploy "PR #$prNumber did not reach MERGED state."
    }

    $mergeSha = [string]$mergedPr.mergeCommit.oid
    if (-not $mergeSha) {
        Stop-Deploy "Merge commit SHA could not be determined."
    }

    $mergedAt = [datetime]$mergedPr.mergedAt

    Write-Ok "PR merged"
    Write-Ok "Merge SHA: $mergeSha"

    Write-Step "Waiting for main CI to start"

    $mainCiRun = Wait-WorkflowRun `
        -Repo $repo `
        -WorkflowFile "ci.yml" `
        -Event "push" `
        -Branch $BaseBranch `
        -HeadSha $mergeSha `
        -NotBefore $mergedAt.AddMinutes(-1)

    Write-Ok "Main CI detected (run $($mainCiRun.id))"

    Watch-WorkflowRun `
        -RunId ([long]$mainCiRun.id) `
        -Label "Main CI"

    Write-Step "Waiting for Deploy Test to start"

    $deployRun = Wait-WorkflowRun `
        -Repo $repo `
        -WorkflowFile "deploy-test.yml" `
        -Event "workflow_run" `
        -Branch $BaseBranch `
        -HeadSha $mergeSha `
        -NotBefore $mergedAt.AddMinutes(-1)

    Write-Ok "Deploy Test detected (run $($deployRun.id))"

    Watch-WorkflowRun `
        -RunId ([long]$deployRun.id) `
        -Label "Deploy Test"

    Write-Step "Verifying Cloud Run deployment"

    $serviceJsonText = gcloud run services describe $TestService `
        --project $ProjectId `
        --region $Region `
        --format=json

    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Failed to read Cloud Run service."
    }

    $service = $serviceJsonText | ConvertFrom-Json

    $revisionName = [string]$service.status.latestReadyRevisionName
    if (-not $revisionName) {
        Stop-Deploy "Latest Ready revision could not be determined."
    }

    $latestTraffic = @($service.status.traffic) | Where-Object {
        $_.latestRevision -eq $true -or $_.revisionName -eq $revisionName
    } | Sort-Object percent -Descending | Select-Object -First 1

    if (-not $latestTraffic -or [int]$latestTraffic.percent -ne 100) {
        Stop-Deploy "Latest Ready revision is not serving 100 percent of TEST traffic."
    }

    $revisionJsonText = gcloud run revisions describe $revisionName `
        --project $ProjectId `
        --region $Region `
        --format=json

    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Failed to read Cloud Run revision $revisionName."
    }

    $revision = $revisionJsonText | ConvertFrom-Json

    $gitShaEnv = @($revision.spec.containers[0].env) |
        Where-Object { $_.name -eq "GIT_SHA" } |
        Select-Object -First 1

    if (-not $gitShaEnv) {
        Stop-Deploy "GIT_SHA is missing from deployed TEST revision."
    }

    $deployedGitSha = [string]$gitShaEnv.value

    if ($deployedGitSha -ne $mergeSha) {
        Stop-Deploy "TEST GIT_SHA mismatch. Expected $mergeSha but deployed $deployedGitSha."
    }

    $imageDigest = [string]$revision.status.imageDigest

    if (-not $imageDigest) {
        $containerImage = [string]$revision.spec.containers[0].image
        if ($containerImage -match "@(sha256:[0-9a-fA-F]{64})$") {
            $imageDigest = $Matches[1]
        }
    }

    if (-not $imageDigest -or $imageDigest -notmatch "^sha256:[0-9a-fA-F]{64}$") {
        Stop-Deploy "Deployed image digest could not be verified."
    }

    $deployLog = gh run view ([long]$deployRun.id) --log
    if ($LASTEXITCODE -ne 0) {
        Stop-Deploy "Deploy Test logs could not be read."
    }

    $deployLogText = ($deployLog -join "`n")

    if ($deployLogText -notmatch [regex]::Escape($imageDigest)) {
        Stop-Deploy "Cloud Run image digest was not found in Deploy Test logs."
    }

    if ($deployLogText -notmatch [regex]::Escape($revisionName)) {
        Stop-Deploy "Cloud Run revision name was not found in Deploy Test logs."
    }

    $testUrl = [string]$service.status.url

    Write-Host ""
    Write-Host "========================================"
    Write-Host "TEST DEPLOYMENT COMPLETED"
    Write-Host "========================================"
    Write-Ok "Push"
    Write-Ok "PR #$prNumber"
    Write-Ok "PR CI run: $($prCiRun.id)"
    Write-Ok "Merge SHA: $mergeSha"
    Write-Ok "Main CI run: $($mainCiRun.id)"
    Write-Ok "Deploy Test run: $($deployRun.id)"
    Write-Ok "Revision: $revisionName"
    Write-Ok "GIT_SHA: $deployedGitSha"
    Write-Ok "Image digest: $imageDigest"
    Write-Ok "TEST traffic: 100%"
    Write-Host "TEST URL: $testUrl"
    Write-Host ""
    Write-Host "Production was not changed."
    Write-Host "DB/GCS synchronization was not executed."
}
catch {
    Write-Host ""
    Write-Host $_.Exception.Message
    Write-Host ""
    Write-Host "Automation stopped. No further deployment steps were executed."
    exit 1
}
