from __future__ import annotations

import importlib.util
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "check_workflow_static.py"


def load_checker_module():
    spec = importlib.util.spec_from_file_location("workflow_static_checker", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load workflow static checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkflowStaticCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_checker_module()
        self.original_workflow_dir = self.module.WORKFLOW_DIR
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workflow_dir = Path(self.temp_dir.name)
        self.module.WORKFLOW_DIR = self.workflow_dir

    def tearDown(self) -> None:
        self.module.WORKFLOW_DIR = self.original_workflow_dir
        self.temp_dir.cleanup()

    def _write_valid_workflows(self) -> None:
        files = {
            "deploy-test.yml": """name: deploy\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n# Template guard\n# latest tag only\n# TEST_CLOUD_RUN_SERVICE ARTIFACT_REGISTRY_REPOSITORY DEPLOY_SERVICE_ACCOUNT WIF_PROVIDER\n      - run: exit 1\n""",
            "promote-production.yml": """name: promote\non: workflow_dispatch\njobs:\n  prod:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n# Template guard\n# latest tag only\n# PROD_CLOUD_RUN_SERVICE ARTIFACT_REGISTRY_REPOSITORY DEPLOY_SERVICE_ACCOUNT WIF_PROVIDER\n      - run: exit 1\n""",
            "sync-prod-to-test.yml": """name: sync\non: workflow_dispatch\njobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n# Template guard\n# Allowed direction only: production -> test\n# Reverse sync (test -> production) must not be implemented.\n# CLOUD_SQL_INSTANCE DB_NAME_PROD DB_NAME_TEST GCS_BUCKET_PROD GCS_BUCKET_TEST DEPLOY_SERVICE_ACCOUNT WIF_PROVIDER\n      - run: exit 1\n""",
        }
        for name, content in files.items():
            (self.workflow_dir / name).write_text(content, encoding="utf-8")

    def _run_checker(self) -> tuple[int, str]:
        output = StringIO()
        with redirect_stdout(output):
            result = self.module.main()
        return result, output.getvalue()

    def test_valid_workflows_pass(self) -> None:
        self._write_valid_workflows()
        result, output = self._run_checker()
        self.assertEqual(result, 0, output)

    def test_invalid_yaml_fails(self) -> None:
        self._write_valid_workflows()
        path = self.workflow_dir / "deploy-test.yml"
        path.write_text("name: broken\non: [\njobs:\n", encoding="utf-8")
        result, output = self._run_checker()
        self.assertEqual(result, 1)
        self.assertIn("invalid YAML", output)

    def test_secret_expression_in_run_block_fails(self) -> None:
        self._write_valid_workflows()
        path = self.workflow_dir / "promote-production.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                "- run: echo safe", "- run: |\n          printf '%s\\n' '${{ secrets.DEPLOY_SERVICE_ACCOUNT }}'"
            ),
            encoding="utf-8",
        )
        result, output = self._run_checker()
        self.assertEqual(result, 1)
        self.assertIn("direct secret expression in run block", output)


if __name__ == "__main__":
    unittest.main()
