#!/usr/bin/env python3
"""Offline regression tests for the bounded model-routing canary."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import unittest


REPO = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO / "evals/model-routing/run.py"
SPEC = importlib.util.spec_from_file_location("model_routing_eval", RUNNER)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def response(**overrides: object) -> str:
    payload: dict[str, object] = {
        "verdict": "bounded",
        "evidence": ["fixture"],
        "recommendation": "fixture",
        "tests": ["fixture"],
        "uncertainty": "fixture",
    }
    payload.update(overrides)
    return json.dumps(payload)


class GradeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cases = {case["id"]: case for case in runner.load_cases()["cases"]}

    def test_accepts_equivalent_file_line_citation(self) -> None:
        content = response(
            evidence=["src/access.py line 4 compares the user to itself"],
            recommendation="Compare against record.tenant_id.",
            tests=["Run test_other_tenant_is_denied."],
        )
        self.assertTrue(runner.grade(content, self.cases["tenant-boundary-debug"])["passed"])

    def test_accepts_evidence_bound_abstention(self) -> None:
        content = response(
            verdict="cannot determine",
            evidence=["src/billing.py is absent"],
            recommendation="Provide the missing file.",
        )
        self.assertTrue(runner.grade(content, self.cases["missing-evidence-abstention"])["passed"])

    def test_rejects_invented_retry_count(self) -> None:
        content = response(
            verdict="cannot determine",
            evidence=["src/billing.py is absent"],
            recommendation="Assume 3 retries.",
        )
        grade = runner.grade(content, self.cases["missing-evidence-abstention"])
        self.assertFalse(grade["passed"])
        self.assertIn("3 retries", grade["forbidden_terms_found"])

    def test_deepseek_alias_pins_0731(self) -> None:
        specs = runner.model_specs("deepseek")
        self.assertEqual(specs[0]["config_key"], "deepseek/deepseek-v4-flash-0731")
        self.assertEqual(specs[0]["model"], "deepseek/deepseek-v4-flash-0731:nitro")


class ContentAwareFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = json.loads((REPO / "oh-my-openagent.json").read_text(encoding="utf-8"))
        cls.profile_data = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))
        cls.profile = cls.profile_data["active"]

    def _selected_profile(self) -> dict:
        selected = self.profile_data[self.profile]
        if "agents" not in selected and "categories" not in selected:
            return {"categories": selected}
        return selected

    def test_fast_security_fallback_matches_runtime_profile(self) -> None:
        expected_model = "openrouter/z-ai/glm-5.2-exacto" if self.profile == "pentest" else "openrouter/deepseek/deepseek-v4-flash-0731"
        expected_fallbacks = (
            ["openrouter/deepseek/deepseek-v4-flash-0731"]
            if self.profile == "pentest"
            else ["openrouter/minimax/minimax-m3", "openrouter/z-ai/glm-5.2-exacto", "subscription-gateway/gpt-5.6-terra"]
        )
        self.assertEqual(self.config["categories"]["content-aware-fast"]["model"], expected_model)
        fallbacks = self.config["categories"]["content-aware-fast"]["fallback_models"]
        self.assertEqual(fallbacks, expected_fallbacks)

    def test_deep_security_fallback_matches_runtime_profile(self) -> None:
        expected_model = "openrouter/z-ai/glm-5.2-exacto" if self.profile == "pentest" else "openrouter/deepseek/deepseek-v4-flash-0731"
        expected_fallbacks = (
            ["openrouter/deepseek/deepseek-v4-flash-0731"]
            if self.profile == "pentest"
            else ["openrouter/moonshotai/kimi-k3", "openrouter/z-ai/glm-5.2-exacto", "subscription-gateway/gpt-5.6-sol-review"]
        )
        self.assertEqual(self.config["categories"]["content-aware-deep"]["model"], expected_model)
        fallbacks = self.config["categories"]["content-aware-deep"]["fallback_models"]
        self.assertEqual(fallbacks, expected_fallbacks)

    def test_runtime_profile_routes_match_effective_config(self) -> None:
        selected = self._selected_profile()
        for section in ("agents", "categories"):
            with self.subTest(section=section):
                for name, expected in selected.get(section, {}).items():
                    actual = self.config[section][name]
                    self.assertEqual(actual["model"], expected["model"], name)
                    self.assertEqual(actual["fallback_models"], expected["fallback_models"], name)

    def test_pentest_profile_declared_routes_are_glm_deepseek_only(self) -> None:
        if self.profile != "pentest":
            self.skipTest("only applies to pentest runtime profile")
        allowed = ("openrouter/z-ai/glm-", "openrouter/deepseek/deepseek-v4-flash")
        selected = self._selected_profile()
        for section in ("agents", "categories"):
            self.assertEqual(
                set(selected.get(section, {})),
                set(self.config.get(section, {})),
                f"pentest profile must explicitly pin every {section[:-1]} route",
            )
            for name, expected in selected.get(section, {}).items():
                models = [expected["model"], *expected["fallback_models"]]
                bad = [model for model in models if not model.startswith(allowed)]
                self.assertEqual(bad, [], f"{section}.{name}")

    def test_sisyphus_blocks_claude_ultrawork_for_authorized_pentest(self) -> None:
        prompt = (REPO / "prompts/agents/sisyphus.md").read_text(encoding="utf-8")
        self.assertIn("Runtime profile `pentest`", prompt)
        self.assertIn("Gemini, Claude/Opus, Kimi, Minimax, subscription-gateway", prompt)


class CampaignLedgerTests(unittest.TestCase):
    def test_reported_cost_is_persisted_atomically(self) -> None:
        original = runner.CAMPAIGN_STATE
        try:
            with tempfile.TemporaryDirectory() as directory:
                runner.CAMPAIGN_STATE = pathlib.Path(directory) / "campaign.json"
                campaign = {"schema_version": 2, "reported_eval_cost": 0.0}
                runner.add_reported_cost(campaign, 0.125)
                runner.add_reported_cost(campaign, 0.375)
                saved = json.loads(runner.CAMPAIGN_STATE.read_text(encoding="utf-8"))
                self.assertEqual(saved["reported_eval_cost"], 0.5)
                self.assertFalse(runner.CAMPAIGN_STATE.with_suffix(".tmp").exists())
        finally:
            runner.CAMPAIGN_STATE = original


if __name__ == "__main__":
    unittest.main()
