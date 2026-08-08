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
