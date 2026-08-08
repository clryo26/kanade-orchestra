from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_improvement_suggestion_migration_contract():
    sql = (ROOT / 'db/migrations/013_improvement_suggestions.sql').read_text(encoding='utf-8')
    assert 'CREATE TABLE IF NOT EXISTS improvement_suggestions' in sql
    assert "CHECK (status IN ('未対応', '修正中', '対応済'))" in sql
    assert 'CHECK (length(trim(suggestion)) > 0)' in sql


def test_improvement_suggestion_router_permission_contract():
    source = (ROOT / 'src/backend/routers/improvement_suggestions.py').read_text(encoding='utf-8')
    assert 'Depends(get_device_auth)' in source
    assert source.count('Depends(get_system_admin_device_auth)') >= 3
    assert '@router.post("/api/improvement-suggestions")' in source
    assert '@router.put("/api/system/improvement-suggestions/{item_id}")' in source
    assert '@router.delete("/api/system/improvement-suggestions/{item_id}")' in source

def test_deploy_test_runs_improvement_migrations_before_cloud_run_deploy():
    workflow = (ROOT / '.github/workflows/deploy-test.yml').read_text(encoding='utf-8')

    build_step = '- name: Build and push tested image'
    migration_step = '- name: Apply DB migrations to test'
    deploy_step = '- name: Deploy tested image to test Cloud Run'

    assert workflow.count(migration_step) == 1
    assert workflow.index(build_step) < workflow.index(migration_step) < workflow.index(deploy_step)

    assert 'TEST_DB_URL: ${{ secrets.TEST_DB_URL }}' in workflow
    assert '-v "${GITHUB_WORKSPACE}/scripts:/app/scripts:ro"' in workflow
    assert '.venv/bin/python scripts/migrate_db.py' in workflow

def test_promote_production_runs_migrations_before_cloud_run_deploy():
    workflow = (ROOT / '.github/workflows/promote-production.yml').read_text(
        encoding='utf-8'
    )

    resolve_step = '- name: Resolve currently deployed test image'
    migration_step = '- name: Apply DB migrations to production'
    deploy_step = '- name: Promote same digest to production Cloud Run'

    assert workflow.count(migration_step) == 1
    assert (
        workflow.index(resolve_step)
        < workflow.index(migration_step)
        < workflow.index(deploy_step)
    )
    assert '- name: Configure Docker for Artifact Registry' in workflow
    assert 'PROD_DB_URL: ${{ secrets.PROD_DB_URL }}' in workflow
    assert '-v "${GITHUB_WORKSPACE}/scripts:/app/scripts:ro"' in workflow
    assert '.venv/bin/python scripts/migrate_db.py' in workflow
