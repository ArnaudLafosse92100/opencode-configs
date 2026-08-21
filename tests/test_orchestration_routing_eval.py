#!/usr/bin/env python3
"""Offline tests for the Sisyphus orchestration-routing canary."""

from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest


REPO = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO / "evals/orchestration-routing/run.py"
SPEC = importlib.util.spec_from_file_location("orchestration_routing_eval", RUNNER)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class SelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.suite = runner.load_cases()

    def test_default_is_single_implicit_security_case(self) -> None:
        self.assertEqual([case["id"] for case in runner.select_cases(self.suite, None)], ["security-recon"])

    def test_unknown_case_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown cases"):
            runner.select_cases(self.suite, "missing")

    def test_dotenv_value_handles_quotes_without_exposing_other_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / ".env"
            path.write_text("OTHER=hidden\nOPENROUTER_API_KEY='test-key'\n", encoding="utf-8")
            self.assertEqual(runner.dotenv_value(path, "OPENROUTER_API_KEY"), "test-key")
            self.assertEqual(runner.dotenv_value(path, "MISSING"), "")


class GradeTests(unittest.TestCase):
    def test_accepts_expected_category_skill_and_terminal_model(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "security-recon")
        evidence = {
            "root": {"agent": "codex-router"},
            "tasks": [{"category": "content-aware-fast", "load_skills": ["content-aware-recon"], "status": "completed"}],
            "children": [{
                "terminal_provider": "openrouter",
                "terminal_model": "z-ai/glm-5.2-exacto",
                "terminal_finish": "stop",
                "terminal_error": None,
            }],
        }
        self.assertTrue(runner.grade(case, evidence)["passed"])

    def test_loading_skill_without_category_fails(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "security-recon")
        evidence = {"root": {"agent": "codex-router"}, "tasks": [], "children": []}
        grade = runner.grade(case, evidence)
        self.assertFalse(grade["passed"])
        self.assertFalse(grade["checks"]["category_task"])

    def test_embedded_category_contract_survives_omitted_skill_argument(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "security-recon")
        evidence = {
            "root": {"agent": "codex-router"},
            "tasks": [{"category": "content-aware-fast", "load_skills": [], "status": "completed"}],
            "children": [{
                "terminal_provider": "openrouter",
                "terminal_model": "z-ai/glm-5.2-exacto",
                "terminal_finish": "stop",
                "terminal_error": None,
            }],
        }
        grade = runner.grade(case, evidence)
        self.assertTrue(grade["passed"])
        self.assertFalse(grade["explicit_skill_loaded"])
        self.assertTrue(grade["checks"]["specialization_contract"])

    def test_service_role_recovery_case_requires_content_aware_deep(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "security-recovery-deep")
        self.assertEqual(case["expected_category"], "content-aware-deep")
        self.assertEqual(case["expected_skill"], "content-aware-audit")
        self.assertIn("service-role key", case["prompt"])
        evidence = {
            "root": {"agent": "codex-router"},
            "tasks": [{"category": "content-aware-deep", "load_skills": ["content-aware-audit"], "status": "completed"}],
            "children": [{
                "terminal_provider": "openrouter",
                "terminal_model": "z-ai/glm-5.2-exacto",
                "terminal_finish": "stop",
                "terminal_error": None,
            }],
        }
        self.assertTrue(runner.grade(case, evidence)["passed"])

    def test_trivial_case_rejects_child_session(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "trivial-direct")
        grade = runner.grade(
            case,
            {"root": {"agent": "codex-router"}, "tasks": [], "children": [{"id": "ses_child"}]},
        )
        self.assertFalse(grade["passed"])

    def test_accepts_category_without_a_skill_contract(self) -> None:
        case = next(case for case in runner.load_cases()["cases"] if case["id"] == "architecture-review")
        evidence = {
            "root": {"agent": "codex-router"},
            "tasks": [{"category": "arch-review", "load_skills": [], "status": "completed"}],
            "children": [{
                "terminal_provider": "subscription-gateway",
                "terminal_model": "gpt-5.6-sol-review",
                "terminal_finish": "stop",
                "terminal_error": None,
            }],
        }
        self.assertTrue(runner.grade(case, evidence)["passed"])


class PromptContractTests(unittest.TestCase):
    def test_sisyphus_contract_requires_category_and_drops_denied_tool(self) -> None:
        prompt = (REPO / "prompts/agents/sisyphus.md").read_text(encoding="utf-8")
        self.assertIn('task(category="content-aware-fast", load_skills=["content-aware-recon"]', prompt)
        self.assertIn('task(category="content-aware-deep", load_skills=["content-aware-audit"]', prompt)
        self.assertIn("does not satisfy this route and does not change the model", prompt)
        self.assertNotIn("call_omo_agent", prompt)

    def test_codex_router_is_task_only_and_routes_security_categories(self) -> None:
        definition = (REPO / "agents/codex-router.md").read_text(encoding="utf-8")
        prompt = (REPO / "prompts/agents/codex-router.md").read_text(encoding="utf-8")
        self.assertIn('"*": deny', definition)
        self.assertIn("task: allow", definition)
        self.assertIn("Every request that needs tools **must**", definition)
        self.assertIn("When using `category`, do not also set `subagent_type`", definition)
        self.assertIn("content-aware-fast", definition)
        self.assertIn("content-aware-deep", definition)
        self.assertIn("service-role keys", definition)
        self.assertIn("Do not route these briefs to generic `deep`", definition)
        self.assertIn("Every request that needs tools **must**", prompt)
        self.assertIn("content-aware-fast", prompt)
        self.assertIn("content-aware-deep", prompt)
        self.assertIn("service-role keys", prompt)
        self.assertIn("Do not route these briefs to generic `deep`", prompt)

    def test_live_canary_targets_codex_router(self) -> None:
        self.assertEqual(runner.DEFAULT_AGENT, "codex-router")


if __name__ == "__main__":
    unittest.main()
