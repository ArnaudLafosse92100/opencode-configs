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

    def test_fast_security_fallback_tries_openrouter_alternatives_before_gateway(self) -> None:
        fallbacks = self.config["categories"]["content-aware-fast"]["fallback_models"]
        self.assertEqual(fallbacks, [
            "openrouter/minimax/minimax-m3",
            "openrouter/z-ai/glm-5.2-exacto",
            "subscription-gateway/gpt-5.6-terra",
        ])

    def test_deep_security_fallback_tries_openrouter_alternatives_before_gateway(self) -> None:
        fallbacks = self.config["categories"]["content-aware-deep"]["fallback_models"]
        self.assertEqual(fallbacks, [
            "openrouter/moonshotai/kimi-k3",
            "openrouter/z-ai/glm-5.2-exacto",
            "subscription-gateway/gpt-5.6-sol-review",
        ])


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
