#!/usr/bin/env python3
"""Offline regression tests for the bounded model-routing canary."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest
from unittest import mock


REPO = pathlib.Path(__file__).resolve().parents[1]
RUNNER = REPO / "evals/model-routing/run.py"
SPEC = importlib.util.spec_from_file_location("model_routing_eval", RUNNER)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
PROFILE_SPEC = importlib.util.spec_from_file_location(
    "runtime_profile", REPO / "scripts/runtime-profile.py"
)
assert PROFILE_SPEC and PROFILE_SPEC.loader
runtime_profile = importlib.util.module_from_spec(PROFILE_SPEC)
PROFILE_SPEC.loader.exec_module(runtime_profile)


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
        self.assertEqual(specs[0]["model"], "deepseek/deepseek-v4-flash-0731:floor")


class ContentAwareFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = json.loads((REPO / "oh-my-openagent.json").read_text(encoding="utf-8"))
        cls.profile_data = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))
        cls.profile = cls.profile_data["default_profile"]
        profiles = runtime_profile.RuntimeProfiles(REPO)
        for profile in ("normal", "pentest"):
            cls.profile_data[profile] = profiles.selected(profile)
            for section in ("agents", "categories"):
                for route in cls.profile_data[profile][section].values():
                    route.pop("effort", None)

    def _selected_profile(self) -> dict:
        selected = self.profile_data[self.profile]
        if "agents" not in selected and "categories" not in selected:
            return {"categories": selected}
        return selected

    def test_fast_security_fallback_matches_runtime_profile(self) -> None:
        expected = self._selected_profile()["categories"]["content-aware-fast"]
        actual = self.config["categories"]["content-aware-fast"]
        self.assertEqual(actual["model"], expected["model"])
        self.assertEqual(actual["fallback_models"], expected["fallback_models"])

    def test_deep_security_fallback_matches_runtime_profile(self) -> None:
        expected = self._selected_profile()["categories"]["content-aware-deep"]
        actual = self.config["categories"]["content-aware-deep"]
        self.assertEqual(actual["model"], expected["model"])
        self.assertEqual(actual["fallback_models"], expected["fallback_models"])

    def test_runtime_profile_routes_match_effective_config(self) -> None:
        selected = self._selected_profile()
        for section in ("agents", "categories"):
            with self.subTest(section=section):
                for name, expected in selected.get(section, {}).items():
                    actual = self.config[section][name]
                    self.assertEqual(actual["model"], expected["model"], name)
                    self.assertEqual(actual["fallback_models"], expected["fallback_models"], name)

    def test_pentest_profile_declared_routes_use_only_flash_then_pro_throughput(self) -> None:
        flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput"
        pro = "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput"
        selected = self.profile_data["pentest"]
        for section in ("agents", "categories"):
            self.assertEqual(
                set(selected.get(section, {})),
                set(self.config.get(section, {})),
                f"pentest profile must explicitly pin every {section[:-1]} route",
            )
            for name, expected in selected.get(section, {}).items():
                self.assertEqual(expected, {"model": flash, "fallback_models": [pro]}, f"{section}.{name}")

    def test_pentest_policy_snapshot_matches_reviewed_fixture(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        self.assertEqual(
            profiles.policy_snapshot_id("pentest"),
            "4df616a0795cb73855594c7dc0a061b16f08030f50337e18f7ea6e4d9dcb2af5",
        )

    def test_new_upstream_models_are_available(self) -> None:
        models = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))["provider"]["openrouter"]["models"]
        for model in (
            "poolside/laguna-s-2.1",
            "meituan/longcat-2.0",
            "qwen/qwen3.8-max-0902",
            "google/gemini-3.8-flash",
        ):
            with self.subTest(model=model):
                self.assertIn(model, models)
        self.assertNotIn("qwen/qwen3.8-max", models)

    def test_codex_subscription_is_local_and_has_no_retired_gateway_dependency(self) -> None:
        opencode = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))
        self.assertNotIn("subscription-gateway", opencode["enabled_providers"])
        self.assertNotIn("subscription-gateway", opencode["provider"])
        codex = opencode["provider"]["codex-subscription"]
        self.assertEqual(codex["options"]["baseURL"], "http://127.0.0.1:10100/v1")
        self.assertEqual(codex["options"]["timeout"], 3_600_000)
        self.assertEqual(codex["options"]["headerTimeout"], 3_600_000)
        self.assertEqual(codex["options"]["chunkTimeout"], 3_600_000)
        self.assertEqual(
            set(codex["models"]),
            {"gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol-review"},
        )
        self.assertEqual(codex["models"]["gpt-5.6-sol-review"]["id"], "openai/gpt-5.6-sol")
        active_sources = "\n".join(
            (REPO / name).read_text(encoding="utf-8")
            for name in (".env.example", "lib/common.sh", "oh-my-openagent.json")
        )
        self.assertNotIn("LLM_GATEWAY_", active_sources)

    def test_normal_quick_and_unspecified_low_use_metered_runtime_pool(self) -> None:
        expected = {
            "model": "openrouter/deepseek/deepseek-v4-flash-0731",
            "fallback_models": [
                "openrouter/z-ai/glm-5.3",
                "openrouter/minimax/minimax-m3",
            ],
        }
        normal = self.profile_data["normal"]["categories"]
        for name in ("quick", "unspecified-low"):
            with self.subTest(name=name):
                self.assertEqual(normal[name], expected)
                self.assertEqual(
                    self.config["categories"][name]["model"], expected["model"]
                )
                self.assertEqual(
                    self.config["categories"][name]["fallback_models"],
                    expected["fallback_models"],
                )

    def test_normal_profile_and_rendered_catalog_are_the_same_ssot(self) -> None:
        """The tracked baseline must exactly match the bounded normal profile."""
        current_opencode = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            rendered = json.loads(
                (runtime_profile.RuntimeProfiles(REPO).render("normal") / "opencode.json").read_text(encoding="utf-8")
            )
        self.assertEqual(rendered, current_opencode)

    def test_normal_machine_routes_use_surface_specific_runtime_fallbacks(self) -> None:
        normal = self.profile_data["normal"]
        flash = "openrouter/deepseek/deepseek-v4-flash-0731"
        sol = "codex-subscription/gpt-5.6-sol"
        astra = "codex-subscription/gpt-6-astra"
        for section, names in (
            ("agents", ("librarian", "sisyphus-junior", "explore")),
            ("categories", ("quick", "unspecified-low")),
        ):
            for name in names:
                self.assertEqual(normal[section][name], {
                    "model": flash,
                    "fallback_models": ["openrouter/z-ai/glm-5.3", "openrouter/minimax/minimax-m3"],
                }, name)
        for section, names in (
            ("agents", ("hephaestus", "atlas")),
            ("categories", ("deep", "bug-hunt", "refactor-safe")),
        ):
            for name in names:
                self.assertEqual(normal[section][name], {"model": sol, "fallback_models": [astra]}, name)
        for section, names in (
            ("agents", ("codex-router", "sisyphus", "prometheus", "oracle", "metis", "momus")),
            ("categories", ("ultrabrain", "unspecified-high", "arch-review")),
        ):
            for name in names:
                self.assertEqual(normal[section][name], {"model": astra, "fallback_models": [sol]}, name)
        for removed in ("codex-plan", "codex-implement", "codex-review"):
            self.assertNotIn(removed, normal["categories"])
            self.assertNotIn(removed, self.config["categories"])

    def test_specialized_normal_routes_remain_explicit_exceptions(self) -> None:
        normal = self.profile_data["normal"]
        self.assertEqual(normal["agents"]["multimodal-looker"]["model"], "openrouter/google/gemini-3.1-pro-preview")
        self.assertEqual(normal["categories"]["writing"]["model"], "openrouter/google/gemini-3.8-flash")
        self.assertEqual(normal["categories"]["agentic-deep-kimi"]["model"], "openrouter/moonshotai/kimi-k2.7-code")
        self.assertEqual(normal["agents"]["content-aware-research"]["model"], "venice/deepseek-v4-pro-0813")
        self.assertEqual(normal["categories"]["content-aware-fast"]["model"], "venice/deepseek-v4-1-flash")
        self.assertEqual(normal["categories"]["content-aware-deep"]["model"], "venice/deepseek-v4-pro-0813")

    def test_direct_normal_subscription_routes_never_fall_back_to_metered_api(self) -> None:
        normal = self.profile_data["normal"]
        for section in ("agents", "categories"):
            for name, route in normal[section].items():
                with self.subTest(section=section, name=name):
                    if route["model"].startswith("codex-subscription/"):
                        self.assertTrue(all(
                            fallback.startswith("codex-subscription/")
                            for fallback in route["fallback_models"]
                        ))
                    self.assertFalse(route["model"].startswith("claude-subscription/"))

    def test_project_scaffolds_do_not_restore_the_old_glm_default(self) -> None:
        expected = {
            "high": "codex-subscription/gpt-6-astra",
            "low": "openrouter/deepseek/deepseek-v4-flash-0731",
            "fast": "codex-subscription/gpt-5.6-sol",
            "research": "codex-subscription/gpt-6-astra",
            "debug": "codex-subscription/gpt-5.6-sol",
            "writing": "openrouter/google/gemini-3.8-flash",
        }
        for name, model in expected.items():
            with self.subTest(profile=name):
                profile = json.loads((REPO / "profiles" / f"{name}.json").read_text(encoding="utf-8"))
                self.assertEqual(profile["model"], model)
                self.assertNotIn("glm-5.3", profile["model"])

    def test_every_normal_openrouter_family_is_price_first_capped_without_allowlists(self) -> None:
        models = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))["provider"]["openrouter"]["models"]
        expected = {
            "z-ai/glm-5.3": (True, 1.40, 4.40),
            "google/gemini-3.1-pro-preview": (False, 3.60, 21.60),
            "google/gemini-3.7-flash": (False, 1.35, 6.75),
            "moonshotai/kimi-k2.7-code": (False, 0.95, 4.00),
            "minimax/minimax-m3": (True, 0.30, 1.20),
            "deepseek/deepseek-v4-pro-0813": (False, 1.32, 3.96),
            "deepseek/deepseek-v4-flash-0731": (False, 0.10, 0.30),
            "nousresearch/hermes-4-405b": (False, 1.00, 3.00),
        }
        for name, (requires_parameters, prompt, completion) in expected.items():
            with self.subTest(name=name):
                provider = models[name]["options"]["provider"]
                self.assertEqual(provider.get("data_collection"), "allow")
                self.assertTrue(provider.get("allow_fallbacks"))
                self.assertEqual(provider.get("require_parameters"), requires_parameters)
                self.assertEqual(provider.get("sort"), "price")
                self.assertEqual(provider.get("max_price"), {"prompt": prompt, "completion": completion})
                self.assertNotIn("only", provider)

    def test_normal_price_caps_and_pentest_zdr_throughput_aliases_are_separate(self) -> None:
        models = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))["provider"]["openrouter"]["models"]
        normal = models["deepseek/deepseek-v4-flash-0731"]
        throughput = models["deepseek/deepseek-v4-flash-0731-zdr-throughput"]
        self.assertEqual(normal["id"], "deepseek/deepseek-v4-flash-0731:floor")
        self.assertEqual(normal["options"]["provider"], {
            "require_parameters": False,
            "data_collection": "allow",
            "allow_fallbacks": True,
            "sort": "price",
            "max_price": {"prompt": 0.10, "completion": 0.30},
        })
        self.assertEqual(throughput["id"], "deepseek/deepseek-v4-flash-0731")
        self.assertEqual(
            throughput["options"]["provider"],
            {
                "require_parameters": True,
                "data_collection": "deny",
                "zdr": True,
                "allow_fallbacks": True,
                "sort": "throughput",
                "max_price": {"prompt": 0.50, "completion": 1.50},
            },
        )
        pro_throughput = models["deepseek/deepseek-v4-pro-0813-zdr-throughput"]
        self.assertEqual(pro_throughput["id"], "deepseek/deepseek-v4-pro-0813")
        self.assertEqual(pro_throughput["name"], "DeepSeek V4 Pro 0813 ZDR Throughput")
        self.assertEqual(
            pro_throughput["options"]["provider"],
            {
                "require_parameters": True,
                "data_collection": "deny",
                "zdr": True,
                "allow_fallbacks": True,
                "sort": "throughput",
                "max_price": {"prompt": 1.50, "completion": 4.50},
            },
        )

    def test_pentest_profile_pins_every_route_to_flash_then_pro_throughput(self) -> None:
        selected = self.profile_data["pentest"]
        flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput"
        pro = "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput"
        for section in ("agents", "categories"):
            for name, route in selected[section].items():
                with self.subTest(section=section, name=name):
                    self.assertEqual(route, {"model": flash, "fallback_models": [pro]})
        self.assertEqual(selected["small_model"], flash)
        self.assertEqual(selected["helper_model"], flash)

    def test_native_content_aware_surfaces_match_default_profile(self) -> None:
        expected = self._selected_profile()["agents"]["content-aware-research"]["model"]
        definition = (REPO / "agents/content-aware-research.md").read_text(encoding="utf-8")
        profile = json.loads((REPO / "profiles/content-aware.json").read_text(encoding="utf-8"))
        self.assertIn(f"model: {expected}", definition)
        self.assertEqual(profile["model"], expected)

    def test_sisyphus_runtime_profile_guard_matches_default_profile(self) -> None:
        prompt = (REPO / "prompts/agents/sisyphus.md").read_text(encoding="utf-8")
        selected = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))["default_profile"]
        self.assertIn(f"Runtime profile `{selected}`", prompt)
        if selected == "pentest":
            self.assertIn("Gemini, Claude/Opus, Kimi, Minimax, codex-subscription", prompt)
        else:
            self.assertNotIn("Runtime profile `pentest`", prompt)

    def test_rendered_pentest_sisyphus_prompt_requires_flash_retries_then_one_pro_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            rendered = runtime_profile.RuntimeProfiles(REPO).render("pentest", force=True)
            prompt = (rendered / "prompts/agents/sisyphus.md").read_text(encoding="utf-8")
            self.assertIn("canonical capability `private-text`", prompt)
            self.assertIn("model ref `deepseek-flash-zdr`", prompt)
            self.assertIn("4 total attempts (the initial attempt plus 3 retries)", prompt)
            self.assertIn("model ref `deepseek-pro-zdr` for exactly 1 attempt", prompt)
            self.assertIn("exhaustion is terminal", prompt)
            self.assertIn("Do not dispatch a model outside this canonical capability chain", prompt)
            self.assertNotIn("pentest-safe routes use only GLM 5.3", prompt)

    def test_profile_activation_renders_external_state_without_mutating_sources(self) -> None:
        tracked = (
            "opencode.json",
            "oh-my-openagent.json",
            "agents/codex-router.md",
            "agents/content-aware-research.md",
            "profiles/content-aware.json",
            "prompts/agents/sisyphus.md",
            "runtime-profile.json",
        )
        before = {name: (REPO / name).read_bytes() for name in tracked}
        with (
            tempfile.TemporaryDirectory() as state,
            tempfile.TemporaryDirectory() as native,
            tempfile.TemporaryDirectory() as source_xdg,
        ):
            env = os.environ.copy()
            env["OC_RUNTIME_STATE_DIR"] = state
            env["OC_NATIVE_OMO_PATH"] = str(pathlib.Path(native) / "omo.jsonc")
            env["OC_SOURCE_XDG_CONFIG_HOME"] = source_xdg
            (pathlib.Path(source_xdg) / "gh").mkdir()
            subprocess.run(
                [
                    "python3",
                    str(REPO / "scripts/runtime-profile.py"),
                    "--repo",
                    str(REPO),
                    "activate",
                    "pentest",
                ],
                check=True,
                env=env,
            )
            state_path = pathlib.Path(state)
            runtime = (state_path / "runtime/current").resolve()
            rendered = json.loads((runtime / "opencode.json").read_text(encoding="utf-8"))
            self.assertEqual(rendered["model"], "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput")
            self.assertEqual(rendered["small_model"], "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput")
            for helper_name in ("title", "summary", "compaction"):
                self.assertEqual(rendered["agent"][helper_name]["model"], "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput")
            self.assertEqual((state_path / "active-profile").read_text().strip(), "pentest")
            self.assertEqual((state_path / "runtime/current").resolve(), runtime.resolve())
            legacy_omo = json.loads((runtime / "oh-my-openagent.json").read_text(encoding="utf-8"))
            native_text = (state_path / "compat/current/.omo.jsonc").read_text(encoding="utf-8")
            native = json.loads(native_text.removeprefix("// OMO configuration\n"))
            self.assertTrue(
                {
                    "2026-07-opencode-config-unification",
                    "2026-08-reasoning-unification",
                }.issubset(native["_migrations"])
            )
            for section in ("agents", "categories"):
                for name, legacy_route in legacy_omo[section].items():
                    with self.subTest(native_section=section, route=name):
                        native_route = native["[opencode]"][section][name]
                        self.assertNotIn("model", native_route)
                        self.assertNotIn("fallback_models", native_route)
                        self.assertNotIn("reasoning", native_route)
                        self.assertNotIn("variant", native_route)
                        models = native_route["models"]
                        self.assertIsInstance(models, list)
                        self.assertGreater(len(models), 0)
                        primary = models[0]
                        self.assertEqual(
                            primary["model"] if isinstance(primary, dict) else primary,
                            legacy_route["model"],
                        )
                        self.assertEqual(models[1:], legacy_route["fallback_models"])
            xdg_result = subprocess.run(
                [
                    "python3",
                    str(REPO / "scripts/runtime-profile.py"),
                    "--repo",
                    str(REPO),
                    "xdg-path",
                    "pentest",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )
            xdg = pathlib.Path(xdg_result.stdout.strip())
            self.assertEqual(
                (xdg / "opencode").resolve(),
                (state_path / "compat/current").resolve(),
            )
            self.assertEqual((xdg / "gh").resolve(), (pathlib.Path(source_xdg) / "gh").resolve())
        after = {name: (REPO / name).read_bytes() for name in tracked}
        self.assertEqual(after, before)


class ExportRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile_data = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))

    def test_strix_policy_is_exported_only_from_normal(self) -> None:
        expected = {
            "primary": "openrouter/deepseek/deepseek-v4-flash-0731",
            "source_fallbacks": ["openrouter/deepseek/deepseek-v4-pro-0813"],
            "reasoning": "medium",
            "variant": "medium",
            "data_classification": "synthetic",
            "admission": "primary-only",
        }
        self.assertEqual(
            self.profile_data["export_routes"]["normal"]["security-strix-scan"],
            expected,
        )
        self.assertEqual(self.profile_data["export_routes"]["pentest"], {})
        config = json.loads((REPO / "oh-my-openagent.json").read_text(encoding="utf-8"))
        self.assertNotIn("security-strix-scan", config["categories"])
        profiles = runtime_profile.RuntimeProfiles(REPO)
        with self.assertRaisesRegex(
            SystemExit, "route not found: normal\\.categories\\.security-strix-scan"
        ):
            profiles.resolve("normal", "categories", "security-strix-scan")
        for profile in ("pentest",):
            with self.subTest(profile=profile), self.assertRaisesRegex(
                SystemExit, f"exported route not found: {profile}\\.security-strix-scan"
            ):
                profiles.export_route(profile, "security-strix-scan")

    def test_export_api_is_canonical_and_revision_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state"
            result = subprocess.run(
                [str(REPO / "oc"), "profile", "export-route", "normal", "security-strix-scan"],
                check=True,
                capture_output=True,
                text=True,
                env={**os.environ, "OC_RUNTIME_STATE_DIR": str(state)},
            )
            self.assertFalse(state.exists(), "export-route must not create runtime state")
        payload = json.loads(result.stdout)
        revision = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "-C", str(REPO), "status", "--porcelain", "--untracked-files=normal"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
        self.assertEqual(payload["repository_revision"], revision)
        self.assertEqual(payload["repository_dirty"], dirty)
        self.assertEqual(payload["primary"], "openrouter/deepseek/deepseek-v4-flash-0731")
        self.assertNotIn("-zdr-throughput", payload["primary"])
        self.assertEqual(payload["admission"], "primary-only")
        self.assertEqual(payload["data_classification"], "synthetic")
        self.assertEqual(
            result.stdout.strip(),
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
        )

    def test_routes_command_lists_every_resolved_route_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            for profile in ("normal", "pentest"):
                with self.subTest(profile=profile):
                    result = subprocess.run(
                        [str(REPO / "oc"), "profile", "routes", profile],
                        cwd=REPO, check=True, capture_output=True, text=True,
                    )
                    payload = json.loads(result.stdout)
                    selected = profiles.selected(profile)
                    self.assertEqual(payload["schema_version"], 1)
                    self.assertEqual(payload["profile"], profile)
                    for section in ("agents", "categories"):
                        self.assertEqual(sorted(payload[section]), sorted(selected[section]))
                        for name, route in payload[section].items():
                            resolved = profiles.resolve(profile, section, name)
                            self.assertEqual(route["model"], resolved["model"], name)
                            self.assertEqual(route["fallback_models"], resolved["fallback_models"], name)
                    self.assertEqual(list(pathlib.Path(state).iterdir()), [])

    def test_export_policy_never_renders_into_omo(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            for profile in ("normal", "pentest"):
                with self.subTest(profile=profile):
                    rendered = json.loads(
                        (profiles.render(profile, force=True) / "oh-my-openagent.json").read_text(
                            encoding="utf-8"
                        )
                    )
                    self.assertNotIn("security-strix-scan", rendered["categories"])

    def test_export_validation_rejects_collisions_duplicates_and_invalid_chains(self) -> None:
        mutations = []
        collision = json.loads(json.dumps(self.profile_data))
        collision["profiles"]["normal"]["bindings"]["categories"]["security-strix-scan"] = {
            "capability": "exploration", "effort": "low"
        }
        mutations.append((collision, "collides with runtime route"))
        duplicate = json.loads(json.dumps(self.profile_data))
        duplicate["export_routes"]["pentest"]["security-strix-scan"] = json.loads(
            json.dumps(duplicate["export_routes"]["normal"]["security-strix-scan"])
        )
        mutations.append((duplicate, "duplicate exported route name"))
        invalid_chain = json.loads(json.dumps(self.profile_data))
        invalid_chain["export_routes"]["normal"]["security-strix-scan"]["source_fallbacks"] *= 2
        mutations.append((invalid_chain, "invalid exported model chain"))
        for data, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                repo = pathlib.Path(directory)
                (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, message):
                    runtime_profile.RuntimeProfiles(repo)

    def test_repository_identity_reports_clean_and_dirty_states(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "OpenConfig Test"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
            tracked = repo / "tracked.txt"
            tracked.write_text("clean\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "tracked.txt"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "fixture"], check=True)
            revision, dirty = runtime_profile.repository_identity(repo)
            self.assertFalse(dirty)
            self.assertEqual(
                revision,
                subprocess.run(
                    ["git", "-C", str(repo), "rev-parse", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
            )
            tracked.write_text("dirty\n", encoding="utf-8")
            dirty_revision, dirty = runtime_profile.repository_identity(repo)
            self.assertEqual(dirty_revision, revision)
            self.assertTrue(dirty)


class WorkflowRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile_data = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))

    def _write_profile(self, directory: str, data: dict) -> pathlib.Path:
        repo = pathlib.Path(directory)
        (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
        return repo

    def test_v4_export_is_revision_bound_and_has_exact_route_contract(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        payload = profiles.export_workflow_routes("normal")
        self.assertEqual(payload["schema_version"], 4)
        self.assertRegex(payload["policy_snapshot_id"], r"^[0-9a-f]{64}$")
        self.assertEqual(set(payload["routes"]), {"exploration", "implementation", "architecture", "review", "adjudication"})
        expected_keys = {"model_ref", "provider", "model", "transport", "billing", "active", "qualified", "fallbacks"}
        for route in payload["routes"].values():
            self.assertEqual(set(route), expected_keys)
        self.assertEqual(payload["routes"]["exploration"]["model_ref"], "deepseek-flash-openrouter")
        self.assertEqual(payload["routes"]["implementation"]["model_ref"], "sol-subscription")
        self.assertEqual(payload["routes"]["architecture"]["model_ref"], "astra-subscription")
        self.assertEqual(payload["routes"]["review"]["model_ref"], "opus-subscription")
        self.assertEqual(payload["routes"]["adjudication"]["model_ref"], "opus-subscription")

    def test_workflow_export_cli_is_observational_and_defaults_to_v4(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state"
            result = subprocess.run(
                [str(REPO / "oc"), "profile", "export-workflow-routes", "normal"],
                check=True, capture_output=True, text=True,
                env={**os.environ, "OC_RUNTIME_STATE_DIR": str(state)},
            )
            self.assertFalse(state.exists())
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], 4)
        self.assertEqual(result.stdout.strip(), json.dumps(payload, ensure_ascii=False, sort_keys=True))

    def test_policy_manifest_exports_canonical_surface_bindings_without_reclassifying_agents(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        with mock.patch.object(runtime_profile, "repository_identity", return_value=("0" * 40, False)):
            payload = profiles.export_policy_manifest("normal")
        self.assertEqual(
            set(payload),
            {
                "schema_version", "repository_revision", "repository_dirty", "profile",
                "policy_snapshot_id", "manifest_snapshot_id", "routes", "surfaces",
            },
        )
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(set(payload["routes"]), set(runtime_profile.WORKFLOW_ROUTE_NAMES))
        self.assertEqual(set(payload["surfaces"]), {"opencode", "factory-archon"})
        opencode = payload["surfaces"]["opencode"]
        self.assertEqual(
            set(opencode), {"entry_agent", "small_model", "helper_model", "bindings"}
        )
        self.assertEqual(
            opencode["bindings"]["agents"]["metis"],
            {"capability": "architecture", "effort": "medium"},
        )
        self.assertEqual(
            opencode["bindings"]["agents"]["momus"],
            {"capability": "architecture", "effort": "medium"},
        )
        aliases = payload["surfaces"]["factory-archon"]["aliases"]
        for binding in aliases.values():
            self.assertEqual(set(binding), {"capability", "default_effort"})
        self.assertEqual(
            {alias: binding["capability"] for alias, binding in aliases.items()},
            {
                "@explorer": "exploration",
                "@implementer": "implementation",
                "@architect": "architecture",
                "@reviewer": "review",
                "@adjudicator": "adjudication",
            },
        )
        semantic = {
            key: payload[key]
            for key in ("schema_version", "profile", "policy_snapshot_id", "routes", "surfaces")
        }
        expected_digest = hashlib.sha256(
            json.dumps(
                semantic, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(payload["manifest_snapshot_id"], expected_digest)

    def test_policy_manifest_cli_is_observational_and_canonical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state"
            result = subprocess.run(
                [str(REPO / "oc"), "profile", "export-policy-manifest", "normal"],
                check=True, capture_output=True, text=True,
                env={**os.environ, "OC_RUNTIME_STATE_DIR": str(state)},
            )
            self.assertFalse(state.exists())
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(result.stdout.strip(), json.dumps(payload, ensure_ascii=False, sort_keys=True))

    def test_manifest_snapshot_covers_alias_declarations_but_v4_export_stays_unchanged(self) -> None:
        baseline = runtime_profile.RuntimeProfiles(REPO)
        before_manifest = baseline.manifest_snapshot_id("normal")
        before_v4 = baseline.export_workflow_routes("normal")
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            data["surface_bindings"]["factory-archon"]["aliases"]["@reviewer"]["default_effort"] = "xhigh"
            with self.assertRaisesRegex(SystemExit, "alias default effort mismatch"):
                runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            aliases = data["surface_bindings"]["factory-archon"]["aliases"]
            aliases["@reviewer"]["capability"], aliases["@adjudicator"]["capability"] = (
                aliases["@adjudicator"]["capability"], aliases["@reviewer"]["capability"],
            )
            changed_aliases = runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
            self.assertNotEqual(changed_aliases.manifest_snapshot_id("normal"), before_manifest)
            with mock.patch.object(runtime_profile, "repository_identity", return_value=("0" * 40, False)):
                alias_v4 = changed_aliases.export_workflow_routes("normal")
            self.assertEqual(alias_v4["routes"], before_v4["routes"])
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            data["profiles"]["normal"]["bindings"]["agents"]["metis"]["effort"] = "high"
            changed = runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
            self.assertNotEqual(changed.manifest_snapshot_id("normal"), before_manifest)
            with mock.patch.object(runtime_profile, "repository_identity", return_value=("0" * 40, False)):
                changed_v4 = changed.export_workflow_routes("normal")
        self.assertEqual(changed_v4["routes"], before_v4["routes"])

    def test_policy_manifest_alias_contract_rejects_missing_extra_and_mismatched_bindings(self) -> None:
        mutations = []
        missing = json.loads(json.dumps(self.profile_data))
        missing["surface_bindings"]["factory-archon"]["aliases"].pop("@reviewer")
        mutations.append((missing, "canonical workflow aliases"))
        extra = json.loads(json.dumps(self.profile_data))
        extra["surface_bindings"]["factory-archon"]["aliases"]["@planner"] = {
            "capability": "architecture", "default_effort": "high",
        }
        mutations.append((extra, "canonical workflow aliases"))
        mismatch = json.loads(json.dumps(self.profile_data))
        mismatch["surface_bindings"]["factory-archon"]["aliases"]["@reviewer"]["capability"] = "architecture"
        mutations.append((mismatch, "invalid factory-archon alias capability"))
        for data, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(SystemExit, message):
                    runtime_profile.RuntimeProfiles(self._write_profile(directory, data))

    def test_pentest_policy_manifest_fails_closed(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        for profile in ("pentest",):
            with self.subTest(profile=profile), self.assertRaisesRegex(SystemExit, "policy manifest unavailable"):
                profiles.export_policy_manifest(profile)

    def test_legacy_v1_and_v3_exports_are_derived_rollback_views(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        v1 = profiles.export_workflow_routes("normal", 1)
        v3 = profiles.export_workflow_routes("normal", 3)
        self.assertEqual(set(v1["routes"]), {"standard", "frontier"})
        self.assertEqual(v1["routes"]["standard"]["model"], "gpt-5.6-sol")
        self.assertEqual(v1["routes"]["frontier"]["model"], "gpt-6-astra")
        self.assertNotIn("model_ref", v3["routes"]["exploration"])
        self.assertNotIn("transport", v3["routes"]["exploration"])
        self.assertNotIn("policy_snapshot_id", v3)
        self.assertEqual(set(v3["routes"]), {"exploration", "implementation", "architecture", "adjudication"})

    def test_legacy_v3_adjudication_projects_adjudication_not_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            data["capabilities"]["review"]["primary"] = "astra-subscription"
            profiles = runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
            with mock.patch.object(runtime_profile, "repository_identity", return_value=("0" * 40, True)):
                v4 = profiles.export_workflow_routes("normal", 4)
                v3 = profiles.export_workflow_routes("normal", 3)
        self.assertEqual(v4["routes"]["review"]["model_ref"], "astra-subscription")
        self.assertEqual(v4["routes"]["adjudication"]["model_ref"], "opus-subscription")
        self.assertEqual(v3["routes"]["adjudication"]["model"], "claude-opus-5-5")

    def test_single_exploration_binding_swap_updates_every_consumer_and_export(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            before = runtime_profile.RuntimeProfiles(REPO).policy_snapshot_id("normal")
            data["capabilities"]["exploration"]["primary"] = "sol-subscription"
            repo = self._write_profile(directory, data)
            profiles = runtime_profile.RuntimeProfiles(repo)
            selected = profiles.selected("normal")
            consumers = [
                ("agents", "librarian"), ("agents", "explore"),
                ("agents", "sisyphus-junior"), ("categories", "quick"),
                ("categories", "unspecified-low"),
            ]
            for section, name in consumers:
                self.assertEqual(selected[section][name]["model"], "codex-subscription/gpt-5.6-sol")
            self.assertEqual(selected["small_model"], "codex-subscription/gpt-5.6-sol")
            self.assertEqual(selected["helper_model"], "codex-subscription/gpt-5.6-sol")
            with mock.patch.object(runtime_profile, "repository_identity", return_value=("0" * 40, True)):
                exported = profiles.export_workflow_routes("normal")
            self.assertEqual(exported["routes"]["exploration"]["model_ref"], "sol-subscription")
            self.assertEqual(exported["routes"]["exploration"]["billing"], "subscription")
            self.assertNotEqual(exported["policy_snapshot_id"], before)
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            profiles.capabilities["exploration"]["primary"] = "sol-subscription"
            generation = profiles.render("normal", force=True)
            omo = json.loads((generation / "oh-my-openagent.json").read_text())
            opencode = json.loads((generation / "opencode.json").read_text())
            for section, name in consumers:
                self.assertEqual(omo[section][name]["model"], "codex-subscription/gpt-5.6-sol")
            self.assertEqual(opencode["small_model"], "codex-subscription/gpt-5.6-sol")
            for helper in ("title", "summary", "compaction"):
                self.assertEqual(opencode["agent"][helper]["model"], "codex-subscription/gpt-5.6-sol")

    def test_rejects_unqualified_effort_privacy_and_modality_incompatibility(self) -> None:
        mutations = []
        unqualified = json.loads(json.dumps(self.profile_data))
        unqualified["qualified_models"]["deepseek-flash-openrouter"]["qualified"] = False
        mutations.append((unqualified, "inactive or unqualified model"))
        effort = json.loads(json.dumps(self.profile_data))
        effort["profiles"]["normal"]["bindings"]["agents"]["explore"]["effort"] = "xhigh"
        mutations.append((effort, "effort incompatibility"))
        privacy = json.loads(json.dumps(self.profile_data))
        privacy["capabilities"]["exploration"]["required_privacy"] = "zdr"
        mutations.append((privacy, "privacy incompatibility"))
        modality = json.loads(json.dumps(self.profile_data))
        modality["capabilities"]["exploration"]["required_modalities"] = ["text", "multimodal"]
        mutations.append((modality, "modality incompatibility"))
        core_fallback = json.loads(json.dumps(self.profile_data))
        core_fallback["capabilities"]["implementation"]["fallbacks"] = ["deepseek-pro-openrouter"]
        core_fallback["capabilities"]["implementation"]["allow_metered_fallback"] = True
        mutations.append((core_fallback, "route_v4_fallback_forbidden"))
        implicit_metered = json.loads(json.dumps(self.profile_data))
        implicit_metered["capabilities"]["pasted-context"]["primary"] = "sol-subscription"
        implicit_metered["capabilities"]["pasted-context"]["fallbacks"] = ["deepseek-pro-openrouter"]
        mutations.append((implicit_metered, "subscription to metered fallback requires explicit authorization"))
        identity = json.loads(json.dumps(self.profile_data))
        identity["qualified_models"]["sol-subscription"]["runtime_model"] = "openrouter/evil/model"
        mutations.append((identity, "runtime model identity mismatch"))
        gated = json.loads(json.dumps(self.profile_data))
        gated["promotion_gates"]["opus-subscription"] = "qualification pending"
        mutations.append((gated, "promotion-gated model must remain unqualified"))
        factory_surface = json.loads(json.dumps(self.profile_data))
        factory_surface["capabilities"]["implementation"]["primary"] = "deepseek-pro-direct"
        mutations.append((factory_surface, "factory-archon surface incompatibility"))
        false_factory_surface = json.loads(json.dumps(self.profile_data))
        false_factory_surface["qualified_models"]["deepseek-pro-direct"]["execution_surfaces"].append("factory-archon")
        mutations.append((false_factory_surface, "unsupported factory-archon provider transport"))
        tools = json.loads(json.dumps(self.profile_data))
        tools["capabilities"]["pasted-context"]["requires_tools"] = True
        mutations.append((tools, "tool capability incompatibility"))
        workflow_effort = json.loads(json.dumps(self.profile_data))
        workflow_effort["qualified_models"]["opus-subscription"]["supported_efforts"] = ["low"]
        mutations.append((workflow_effort, "workflow effort incompatibility"))
        review_effort = json.loads(json.dumps(self.profile_data))
        review_effort["qualified_models"]["opus-subscription"]["supported_efforts"] = ["high"]
        mutations.append((review_effort, "workflow effort incompatibility"))
        duplicate_runtime = json.loads(json.dumps(self.profile_data))
        duplicate_runtime["qualified_models"]["deepseek-flash-openrouter-alias"] = json.loads(
            json.dumps(duplicate_runtime["qualified_models"]["deepseek-flash-openrouter"])
        )
        mutations.append((duplicate_runtime, "duplicate executable runtime_model identity"))
        for data, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                repo = self._write_profile(directory, data)
                with self.assertRaisesRegex(SystemExit, message):
                    runtime_profile.RuntimeProfiles(repo)

    def test_explicit_metered_fallback_opt_in_is_accepted_and_still_capability_checked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            capability = data["capabilities"]["pasted-context"]
            capability["primary"] = "sol-subscription"
            capability["fallbacks"] = ["deepseek-pro-openrouter"]
            capability["allow_metered_fallback"] = True
            profiles = runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
            route = profiles.selected("normal")["agents"]["context-aware-hermes"]
        self.assertEqual(route["model"], "codex-subscription/gpt-5.6-sol")
        self.assertEqual(route["fallback_models"], ["openrouter/deepseek/deepseek-v4-pro-0813"])

    def test_every_runtime_binding_is_producer_validated(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        for profile in ("normal", "pentest"):
            policy = profiles.data["profiles"][profile]
            for section in ("agents", "categories"):
                for name, binding in policy["bindings"][section].items():
                    capability = profiles.capabilities[binding["capability"]]
                    for reference in (capability["primary"], *capability["fallbacks"]):
                        model = profiles.models[reference]
                        with self.subTest(profile=profile, section=section, name=name, model=reference):
                            self.assertTrue(model["active"])
                            self.assertTrue(model["qualified"])
                            self.assertIn("opencode", model["execution_surfaces"])
                            self.assertIn(binding["effort"], model["supported_efforts"])
                            self.assertIn(capability["required_privacy"], model["privacy_classes"])
                            self.assertLessEqual(set(capability["required_modalities"]), set(model["modalities"]))
                            if capability["requires_tools"]:
                                self.assertTrue(model["tool_use"])
        for capability_name in runtime_profile.WORKFLOW_ROUTE_NAMES:
            capability = profiles.capabilities[capability_name]
            self.assertIn("factory-archon", profiles.models[capability["primary"]]["execution_surfaces"])

    def test_generic_agent_documents_are_model_neutral(self) -> None:
        generic = (
            "atlas", "codex-router", "explore", "hephaestus", "librarian", "metis",
            "momus", "multimodal-looker", "oracle", "prometheus", "sisyphus-junior", "sisyphus",
        )
        physical = re.compile(r"openrouter/|codex-subscription/|gpt-[0-9]|deepseek-v[0-9]|gemini-[0-9]|glm-[0-9]|claude-opus", re.I)
        for name in generic:
            text = (REPO / "agents" / f"{name}.md").read_text()
            with self.subTest(agent=name):
                self.assertIsNone(physical.search(text))

    def test_provider_bound_agent_bodies_do_not_claim_other_lanes(self) -> None:
        provider_bound = (
            "content-aware-fast", "content-aware-research", "context-aware-hermes",
            "sisyphus-deepseek", "sisyphus-deepseek-junior",
            "sisyphus-venice-deepseek", "sisyphus-venice-deepseek-flash-junior",
        )
        identity = re.compile(r"(?:openrouter|codex-subscription|deepseek|venice)/[a-z0-9._/-]+", re.I)
        stale = re.compile(r"default (?:openconfig )?lead remains|not openrouter|not venice|\(venice, tools\)", re.I)
        for name in provider_bound:
            text = (REPO / "agents" / f"{name}.md").read_text()
            frontmatter, body = text.split("---", 2)[1:]
            own = re.search(r"^model:\s*(\S+)\s*$", frontmatter, re.M)
            with self.subTest(agent=name):
                self.assertIsNotNone(own)
                self.assertTrue(all(value == own.group(1) for value in identity.findall(body)))
                self.assertIsNone(stale.search(body))
                prompt_path = REPO / "prompts" / "agents" / f"{name}.md"
                if prompt_path.is_file():
                    prompt = prompt_path.read_text()
                    provider_prefix = own.group(1).split("/", 1)[0] + "/"
                    self.assertTrue(all(value.startswith(provider_prefix) for value in identity.findall(prompt)))
                    self.assertIsNone(stale.search(prompt))

    def test_generic_profile_prompts_are_model_neutral(self) -> None:
        provider_bound_allowlist = {"content-aware"}
        physical = re.compile(
            r"\b(?:astra|sol|deepseek|gemini|glm|kimi|minimax|hermes|opus)\b|"
            r"(?:openrouter|codex-subscription|deepseek|venice)/|gpt-[0-9]",
            re.I,
        )
        for path in sorted((REPO / "prompts/profiles").glob("*.md")):
            if path.stem in provider_bound_allowlist:
                continue
            with self.subTest(profile=path.stem):
                self.assertIsNone(physical.search(path.read_text()))

    def test_rendered_routes_use_canonical_effort(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            rendered = json.loads((profiles.render("normal", force=True) / "oh-my-openagent.json").read_text())
        self.assertEqual(rendered["agents"]["momus"]["reasoning"], "medium")
        self.assertEqual(rendered["categories"]["agentic-deep-kimi"]["reasoning"], "medium")
        self.assertEqual(rendered["categories"]["agentic-deep-kimi"]["variant"], "medium")

    def test_resolve_reports_binding_effort_not_baseline_omo_reasoning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            data = json.loads(json.dumps(self.profile_data))
            omo = json.loads((REPO / "oh-my-openagent.json").read_text())
            omo["agents"]["momus"]["reasoning"] = "low"
            (repo / "runtime-profile.json").write_text(json.dumps(data))
            (repo / "oh-my-openagent.json").write_text(json.dumps(omo))
            resolved = runtime_profile.RuntimeProfiles(repo).resolve("normal", "agents", "momus")
        self.assertEqual(resolved["reasoning"], "medium")
        self.assertEqual(resolved["variant"], "medium")

    def test_runtime_policy_contract_is_model_neutral_and_pentest_snapshot_ignores_unexported_workflow(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        contract = profiles.runtime_policy("normal")
        self.assertEqual(set(contract), {"schema_version", "profile", "entry_agent", "policy_snapshot_id", "privacy", "admission"})
        self.assertEqual(set(contract["admission"]), {"attachments", "multimodal", "unqualified_models", "capability_mismatch", "metered_fallback"})
        serialized = json.dumps(contract).lower()
        for identifier in ("deepseek", "gpt-", "claude", "gemini", "openrouter", "codex-subscription"):
            self.assertNotIn(identifier, serialized)
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(json.dumps(self.profile_data))
            pentest_before = profiles.policy_snapshot_id("pentest")
            data["capabilities"]["exploration"]["primary"] = "sol-subscription"
            changed = runtime_profile.RuntimeProfiles(self._write_profile(directory, data))
            self.assertEqual(changed.policy_snapshot_id("pentest"), pentest_before)

    def test_policy_snapshot_hashes_only_effective_transitive_closure(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        before = profiles.policy_snapshot_id("normal")
        with tempfile.TemporaryDirectory() as directory:
            unrelated = json.loads(json.dumps(self.profile_data))
            unused = json.loads(json.dumps(unrelated["qualified_models"]["minimax-openrouter"]))
            unused["runtime_model"] = "openrouter/example/unused"
            unused["model"] = "openrouter/example/unused"
            unrelated["qualified_models"]["unused-catalog-entry"] = unused
            unrelated_profiles = runtime_profile.RuntimeProfiles(self._write_profile(directory, unrelated))
            self.assertEqual(unrelated_profiles.policy_snapshot_id("normal"), before)
        with tempfile.TemporaryDirectory() as directory:
            relevant = json.loads(json.dumps(self.profile_data))
            relevant["qualified_models"]["sol-subscription"]["modalities"].append("multimodal")
            relevant_profiles = runtime_profile.RuntimeProfiles(self._write_profile(directory, relevant))
            self.assertNotEqual(relevant_profiles.policy_snapshot_id("normal"), before)
        with tempfile.TemporaryDirectory() as directory:
            wording_only = json.loads(json.dumps(self.profile_data))
            unused = json.loads(
                json.dumps(wording_only["qualified_models"]["minimax-openrouter"])
            )
            unused["runtime_model"] = "openrouter/example/gated-unused"
            unused["model"] = "openrouter/example/gated-unused"
            unused["qualified"] = False
            wording_only["qualified_models"]["gated-unused"] = unused
            wording_only["promotion_gates"]["gated-unused"] = (
                "human-only qualification explanation"
            )
            wording_profiles = runtime_profile.RuntimeProfiles(self._write_profile(directory, wording_only))
            self.assertEqual(wording_profiles.policy_snapshot_id("normal"), before)

    def test_pentest_workflow_exports_fail_closed(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        for profile in ("pentest",):
            with self.subTest(profile=profile), self.assertRaisesRegex(SystemExit, "workflow routes unavailable"):
                profiles.export_workflow_routes(profile)

    def test_runtime_contract_is_separate_from_omo(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            generation = profiles.render("normal", force=True)
            rendered = json.loads((generation / "oh-my-openagent.json").read_text())
            contract = json.loads((generation / ".runtime-policy.json").read_text())
            metadata = json.loads((generation / ".runtime-profile.json").read_text())
        self.assertNotIn("policy_snapshot_id", json.dumps(rendered))
        self.assertEqual(contract["policy_snapshot_id"], profiles.policy_snapshot_id("normal"))
        self.assertEqual(metadata["schema_version"], 4)

    def test_opus_live_qualification_is_promoted_without_a_stale_gate(self) -> None:
        self.assertTrue(
            self.profile_data["qualified_models"]["opus-subscription"]["qualified"]
        )
        self.assertNotIn("opus-subscription", self.profile_data["promotion_gates"])


class NativeOmoMigrationTests(unittest.TestCase):
    def test_native_models_preserve_route_settings_and_normalize_matching_aliases(self) -> None:
        route = {
            "model": "openrouter/example/primary",
            "fallback_models": ["openrouter/example/fallback"],
            "reasoning": " HIGH ",
            "reasoningEffort": "high",
            "variant": "HIGH",
            "maxTokens": 8192,
            "temperature": 0.2,
            "ultrawork": {"model": "openrouter/example/ultra", "variant": "max"},
        }
        migrated = runtime_profile._native_models(route, "agents")
        self.assertEqual(
            migrated["models"],
            [{"model": "openrouter/example/primary", "reasoning": "high"}, "openrouter/example/fallback"],
        )
        self.assertEqual(migrated["maxTokens"], 8192)
        self.assertEqual(migrated["temperature"], 0.2)
        self.assertEqual(
            migrated["ultrawork"],
            {"model": "openrouter/example/ultra", "variant": "max"},
        )
        for legacy in ("model", "fallback_models", "reasoning", "reasoningEffort", "variant"):
            self.assertNotIn(legacy, migrated)

    def test_native_models_reject_conflicts_and_preexisting_models(self) -> None:
        base = {
            "model": "openrouter/example/primary",
            "fallback_models": ["openrouter/example/fallback"],
        }
        for extra in (
            {"reasoning": "low", "variant": "high"},
            {"reasoning": "low", "reasoningEffort": "high"},
            {"models": ["openrouter/example/old"]},
        ):
            with self.subTest(extra=extra), self.assertRaises(SystemExit):
                runtime_profile._native_models({**base, **extra}, "agents")


class PentestPromptOverlayTests(unittest.TestCase):
    effective_paths = (
        "agents/codex-router.md",
        "prompts/categories/content-aware-deep.md",
    )
    router_mirror = "prompts/agents/codex-router.md"

    def test_normal_generation_preserves_effective_baselines_and_pentest_adds_only_overlay(self) -> None:
        source = {name: (REPO / name).read_bytes() for name in self.effective_paths}
        mirror_source = (REPO / self.router_mirror).read_bytes()
        routes_before = (REPO / "runtime-profile.json").read_bytes()
        with tempfile.TemporaryDirectory() as state:
            environment = os.environ.copy()
            environment["OC_RUNTIME_STATE_DIR"] = state
            with mock.patch.dict(os.environ, environment, clear=True):
                profiles = runtime_profile.RuntimeProfiles(REPO)
                normal = profiles.render("normal", force=True)
                pentest = profiles.render("pentest", force=True)
            normal_router = runtime_profile.update_frontmatter_model(
                (REPO / "agents/codex-router.md").read_text(encoding="utf-8"),
                profiles.selected("normal")["agents"]["codex-router"]["model"],
                REPO / "agents/codex-router.md",
            ).encode("utf-8")
            self.assertEqual((normal / "agents/codex-router.md").read_bytes(), normal_router)
            self.assertEqual(
                (normal / "prompts/categories/content-aware-deep.md").read_bytes(),
                source["prompts/categories/content-aware-deep.md"],
            )
            self.assertEqual((normal / self.router_mirror).read_bytes(), mirror_source)
            self.assertEqual((pentest / self.router_mirror).read_bytes(), mirror_source)
            router = (pentest / "agents/codex-router.md").read_text(encoding="utf-8")
            deep = (pentest / "prompts/categories/content-aware-deep.md").read_text(encoding="utf-8")
            for prompt in (router, deep):
                self.assertIn("canonical capability `private-text`", prompt)
                self.assertIn("model ref `deepseek-flash-zdr`", prompt)
                self.assertIn("4 total attempts (the initial attempt plus 3 retries)", prompt)
                self.assertIn("model ref `deepseek-pro-zdr` for exactly 1 attempt", prompt)
                self.assertIn("exhaustion is terminal", prompt)
                self.assertIn("Do not dispatch a model outside this canonical capability chain", prompt)
                self.assertNotIn("at most one", prompt)
                self.assertNotIn("may be resumed once", prompt)
        self.assertEqual((REPO / "runtime-profile.json").read_bytes(), routes_before)
        self.assertEqual({name: (REPO / name).read_bytes() for name in self.effective_paths}, source)
        self.assertEqual((REPO / self.router_mirror).read_bytes(), mirror_source)

    def test_unknown_profile_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            with self.assertRaisesRegex(SystemExit, "profile must be one of normal, pentest"):
                runtime_profile.RuntimeProfiles(REPO).selected("unknown")

    def test_overlay_helper_is_idempotent(self) -> None:
        relative = pathlib.Path("agents/codex-router.md")
        source = (REPO / relative).read_text(encoding="utf-8")
        policy = runtime_profile.RuntimeProfiles(REPO).pentest_policy_prose()
        once = runtime_profile.render_pentest_prompt_overlay(source, "pentest", relative, policy)
        twice = runtime_profile.render_pentest_prompt_overlay(once, "pentest", relative, policy)
        self.assertEqual(twice, once)
        self.assertEqual(runtime_profile.render_pentest_prompt_overlay(source, "normal", relative), source)

    def test_pentest_prompt_render_follows_canonical_model_ref_swap(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            capability = profiles.capabilities["private-text"]
            capability["primary"], capability["fallbacks"] = "deepseek-pro-zdr", ["deepseek-flash-zdr"]
            generation = profiles.render("pentest", force=True)
            router = (generation / "agents/codex-router.md").read_text(encoding="utf-8")
            sisyphus = (generation / "prompts/agents/sisyphus.md").read_text(encoding="utf-8")
        for prompt in (router, sisyphus):
            self.assertIn("model ref `deepseek-pro-zdr` for 4 total attempts", prompt)
            self.assertIn("model ref `deepseek-flash-zdr` for exactly 1 attempt", prompt)
            self.assertNotIn("model ref `deepseek-flash-zdr` for 4 total attempts", prompt)


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
