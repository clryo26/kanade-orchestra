from pathlib import Path


def test_deploy_to_test_uses_and_waits_for_auto_merge():
    script = Path("scripts/deploy_to_test.ps1").read_text(encoding="utf-8-sig")

    merge_command = "gh pr merge $prNumber --merge --auto"
    assert merge_command in script
    assert "--admin" not in script

    auto_merge_section = script[script.index(merge_command):script.index("$mergeSha")]
    assert "$mergeDeadline = (Get-Date).AddSeconds($RunDiscoveryTimeoutSeconds)" in auto_merge_section
    assert "while ((Get-Date) -lt $mergeDeadline)" in auto_merge_section
    assert "gh pr view $prNumber --json state,mergedAt,mergeCommit,url" in auto_merge_section
    assert 'if ($mergedPr.state -eq "MERGED")' in auto_merge_section
    assert "Start-Sleep -Seconds $PollIntervalSeconds" in auto_merge_section
    assert "Timed out waiting for PR #$prNumber to reach MERGED state." in auto_merge_section


def test_deploy_to_test_reads_merge_metadata_only_after_merged_check():
    script = Path("scripts/deploy_to_test.ps1").read_text(encoding="utf-8-sig")

    merged_check = 'if ($null -eq $mergedPr -or $mergedPr.state -ne "MERGED")'
    assert merged_check in script
    assert script.index(merged_check) < script.index("$mergeSha = [string]$mergedPr.mergeCommit.oid")
    assert "$mergeSha = [string]$mergedPr.mergeCommit.oid" in script
    assert "$mergedAt = [datetime]$mergedPr.mergedAt" in script
