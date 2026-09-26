#!/usr/bin/env python3
"""Offline regression tests for the bounded model-routing canary."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import pathlib
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

    def test_pentest_routes_match_approved_zdr_manifest(self) -> None:
        canonical = json.dumps(
            self.profile_data["pentest"], sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        self.assertEqual(
            hashlib.sha256(canonical).hexdigest(),
            "bddfae3efa857cb94a28bfdb1bbddc8e5d103d3f2c4330669edeae902fbb9f35",
        )

    def test_normal_private_routes_are_exclusively_openrouter(self) -> None:
        selected = runtime_profile.RuntimeProfiles(REPO).selected("normal-private")
        for section in ("agents", "categories"):
            for name, route in selected[section].items():
                with self.subTest(section=section, name=name):
                    chain = [route["model"], *route["fallback_models"]]
                    self.assertTrue(all(model.startswith("openrouter/") for model in chain))

    def test_normal_private_replaces_routes_without_an_openrouter_rung(self) -> None:
        replacement = self.profile_data["normal-private"]["non_openrouter_route"]
        selected = runtime_profile.RuntimeProfiles(REPO).selected("normal-private")
        expected = {
            "agents": {
                "content-aware-research",
                "sisyphus-venice-deepseek",
                "sisyphus-venice-deepseek-flash-junior",
                "content-aware-fast",
            },
            "categories": {"content-aware-fast", "content-aware-deep"},
        }
        for section, names in expected.items():
            for name in names:
                with self.subTest(section=section, name=name):
                    self.assertEqual(selected[section][name], replacement)

    def test_normal_private_rejects_an_invalid_replacement_route(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            data = json.loads(json.dumps(self.profile_data))
            data["normal-private"]["non_openrouter_route"]["model"] = "venice/deepseek-v4-pro"
            (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "invalid normal-private.non_openrouter_route"):
                runtime_profile.RuntimeProfiles(repo)

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

    def test_normal_quick_and_unspecified_low_use_flash_then_minimax(self) -> None:
        expected = {
            "model": "openrouter/deepseek/deepseek-v4-flash-0731",
            "fallback_models": [
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

    def test_normal_routes_are_bounded_by_role_and_capability(self) -> None:
        normal = self.profile_data["normal"]
        glm_chain = ["openrouter/moonshotai/kimi-k2.7-code", "openrouter/deepseek/deepseek-v4-pro-0813"]
        pro_glm = ["openrouter/deepseek/deepseek-v4-pro-0813", "openrouter/z-ai/glm-5.3"]
        self.assertEqual(normal["agents"]["explore"]["model"], "openrouter/deepseek/deepseek-v4-flash-0731")
        self.assertEqual(normal["categories"]["codex-implement"]["model"], "openrouter/z-ai/glm-5.3-flash")
        for name in ("codex-router", "sisyphus", "prometheus", "atlas"):
            self.assertEqual(normal["agents"][name]["fallback_models"], glm_chain, name)
        for name in ("bug-hunt", "refactor-safe", "unspecified-high"):
            self.assertEqual(normal["categories"][name]["fallback_models"], glm_chain, name)
        for name in ("oracle", "momus"):
            self.assertEqual(normal["agents"][name]["fallback_models"], pro_glm, name)
        for name in ("ultrabrain", "deep", "arch-review"):
            self.assertEqual(normal["categories"][name]["fallback_models"], pro_glm, name)
        self.assertEqual(normal["agents"]["hephaestus"]["fallback_models"], pro_glm)
        self.assertEqual(normal["agents"]["metis"]["fallback_models"], ["codex-subscription/gpt-5.6-sol", "openrouter/moonshotai/kimi-k2.7-code"])
        for section, names in (("agents", ("librarian", "sisyphus-junior", "explore")), ("categories", ("quick", "unspecified-low"))):
            for name in names:
                self.assertEqual(normal[section][name]["fallback_models"], ["openrouter/minimax/minimax-m3"], name)
        for section, names in (("agents", ("multimodal-looker",)), ("categories", ("visual-engineering", "artistry"))):
            for name in names:
                self.assertEqual(normal[section][name]["fallback_models"], ["openrouter/google/gemini-3.7-flash", "openrouter/minimax/minimax-m3"], name)
        self.assertEqual(normal["categories"]["writing"]["fallback_models"], ["openrouter/deepseek/deepseek-v4-flash-0731"])
        self.assertEqual(normal["categories"]["agentic-deep-kimi"]["fallback_models"], ["openrouter/deepseek/deepseek-v4-pro-0813", "openrouter/z-ai/glm-5.3"])
        self.assertEqual(normal["agents"]["content-aware-research"]["fallback_models"], ["venice/deepseek-v4-pro", "venice/deepseek-v4-1-flash"])
        self.assertEqual(normal["categories"]["content-aware-fast"]["fallback_models"], ["venice/deepseek-v4-pro-0813", "venice/deepseek-v4-pro"])
        self.assertEqual(normal["categories"]["content-aware-deep"]["fallback_models"], ["venice/deepseek-v4-pro", "venice/deepseek-v4-1-flash"])

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
            self.assertIn("starts on DeepSeek V4 Flash 0731 ZDR Throughput", prompt)
            self.assertIn("retries Flash exactly three times", prompt)
            self.assertIn("exactly one DeepSeek V4 Pro 0813 ZDR Throughput attempt", prompt)
            self.assertIn("that failure is terminal", prompt)
            self.assertIn("Do not dispatch GLM, GPT/codex-subscription, Kimi", prompt)
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
            "reasoning": "low",
            "variant": "low",
            "data_classification": "synthetic",
            "admission": "primary-only",
        }
        self.assertEqual(
            self.profile_data["export_routes"]["normal"]["security-strix-scan"],
            expected,
        )
        self.assertEqual(self.profile_data["export_routes"]["normal-private"], {})
        self.assertEqual(self.profile_data["export_routes"]["pentest"], {})
        config = json.loads((REPO / "oh-my-openagent.json").read_text(encoding="utf-8"))
        self.assertNotIn("security-strix-scan", config["categories"])
        profiles = runtime_profile.RuntimeProfiles(REPO)
        with self.assertRaisesRegex(
            SystemExit, "route not found: normal\\.categories\\.security-strix-scan"
        ):
            profiles.resolve("normal", "categories", "security-strix-scan")
        for profile in ("normal-private", "pentest"):
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

    def test_export_policy_never_renders_into_omo(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            for profile in ("normal", "normal-private", "pentest"):
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
        collision["normal"]["categories"]["security-strix-scan"] = {
            "model": "openrouter/deepseek/deepseek-v4-flash-0731",
            "fallback_models": [],
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


class WorkflowSubscriptionRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile_data = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))

    def test_normal_contract_has_exact_qualified_subscription_routes(self) -> None:
        contract = self.profile_data["workflow_subscription_routes"]
        self.assertEqual(contract["schema_version"], 1)
        self.assertEqual(set(contract["profiles"]), {"normal", "normal-private", "pentest"})
        self.assertEqual(contract["profiles"]["normal-private"], {})
        self.assertEqual(contract["profiles"]["pentest"], {})
        self.assertEqual(
            contract["profiles"]["normal"],
            {
                "standard": {
                    "provider": "codex",
                    "model": "gpt-5.6-sol",
                    "billing": "subscription",
                    "active": True,
                    "qualified": True,
                    "fallbacks": [],
                },
                "frontier": {
                    "provider": "codex",
                    "model": "gpt-6-astra",
                    "billing": "subscription",
                    "active": True,
                    "qualified": True,
                    "fallbacks": [],
                },
            },
        )

    def test_workflow_export_is_revision_bound_and_observational(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state"
            result = subprocess.run(
                [str(REPO / "oc"), "profile", "export-workflow-routes", "normal"],
                check=True,
                capture_output=True,
                text=True,
                env={**os.environ, "OC_RUNTIME_STATE_DIR": str(state)},
            )
            self.assertFalse(state.exists(), "workflow export must not create runtime state")
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
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["repository_revision"], revision)
        self.assertEqual(payload["repository_dirty"], dirty)
        self.assertEqual(payload["profile"], "normal")
        self.assertEqual(set(payload["routes"]), {"standard", "frontier"})
        self.assertEqual(
            result.stdout.strip(),
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
        )

    def test_private_and_pentest_workflow_exports_fail_closed(self) -> None:
        profiles = runtime_profile.RuntimeProfiles(REPO)
        for profile in ("normal-private", "pentest"):
            with self.subTest(profile=profile), self.assertRaisesRegex(
                SystemExit, f"workflow subscription routes unavailable for profile: {profile}"
            ):
                profiles.export_workflow_routes(profile)

    def test_workflow_contract_never_renders_into_omo(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            profiles = runtime_profile.RuntimeProfiles(REPO)
            for profile in ("normal", "normal-private", "pentest"):
                with self.subTest(profile=profile):
                    rendered = json.loads(
                        (profiles.render(profile, force=True) / "oh-my-openagent.json").read_text(
                            encoding="utf-8"
                        )
                    )
                    self.assertNotIn("workflow_subscription_routes", rendered)

    def test_workflow_route_validation_is_native_subscription_only(self) -> None:
        mutations = []

        missing_route = json.loads(json.dumps(self.profile_data))
        del missing_route["workflow_subscription_routes"]["profiles"]["normal"]["frontier"]
        mutations.append((missing_route, "must declare exactly frontier, standard"))

        api_provider = json.loads(json.dumps(self.profile_data))
        api_provider["workflow_subscription_routes"]["profiles"]["normal"]["standard"]["provider"] = "openrouter"
        mutations.append((api_provider, "invalid workflow subscription provider"))

        pi_provider = json.loads(json.dumps(self.profile_data))
        pi_provider["workflow_subscription_routes"]["profiles"]["normal"]["frontier"]["provider"] = "pi"
        mutations.append((pi_provider, "invalid workflow subscription provider"))

        api_fallback = json.loads(json.dumps(self.profile_data))
        api_fallback["workflow_subscription_routes"]["profiles"]["normal"]["frontier"]["fallbacks"] = [
            "openrouter/z-ai/glm-5.3"
        ]
        mutations.append((api_fallback, "cannot declare fallbacks"))

        unqualified = json.loads(json.dumps(self.profile_data))
        unqualified["workflow_subscription_routes"]["profiles"]["normal"]["standard"]["qualified"] = False
        mutations.append((unqualified, "inactive or unqualified"))

        for data, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                repo = pathlib.Path(directory)
                (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, message):
                    runtime_profile.RuntimeProfiles(repo)

    def test_workflow_routes_reject_sol_and_astra_canonical_drift(self) -> None:
        mutations = []

        standard_contract = json.loads(json.dumps(self.profile_data))
        standard_contract["workflow_subscription_routes"]["profiles"]["normal"]["standard"][
            "model"
        ] = "gpt-5.6-terra"
        mutations.append(
            (standard_contract, "normal.standard must match normal.agents.oracle")
        )

        frontier_contract = json.loads(json.dumps(self.profile_data))
        frontier_contract["workflow_subscription_routes"]["profiles"]["normal"]["frontier"][
            "model"
        ] = "gpt-5.6-sol"
        mutations.append(
            (frontier_contract, "normal.frontier must match normal.categories.codex-plan")
        )

        standard = json.loads(json.dumps(self.profile_data))
        standard["normal"]["categories"]["deep"]["model"] = "codex-subscription/gpt-5.6-terra"
        mutations.append((standard, "normal.standard must match normal.categories.deep"))

        frontier = json.loads(json.dumps(self.profile_data))
        frontier["normal"]["categories"]["codex-review"]["model"] = (
            "codex-subscription/gpt-5.6-sol-review"
        )
        mutations.append((frontier, "normal.frontier must match normal.categories.codex-review"))

        for data, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                repo = pathlib.Path(directory)
                (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, message):
                    runtime_profile.RuntimeProfiles(repo)

    def test_future_claude_switch_requires_all_canonical_routes_to_move_together(self) -> None:
        data = json.loads(json.dumps(self.profile_data))
        frontier = data["workflow_subscription_routes"]["profiles"]["normal"]["frontier"]
        frontier["provider"] = "claude"
        frontier["model"] = "qualified-model-id"
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(
                SystemExit, "normal.frontier must match normal.categories.codex-plan"
            ):
                runtime_profile.RuntimeProfiles(repo)

        for category in ("codex-plan", "codex-review"):
            data["normal"]["categories"][category]["model"] = (
                "claude-subscription/qualified-model-id"
            )
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            (repo / "runtime-profile.json").write_text(json.dumps(data), encoding="utf-8")
            runtime_profile.RuntimeProfiles(repo)


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
                self.assertIn("DeepSeek V4 Flash 0731 ZDR Throughput", prompt)
                self.assertIn("retry Flash exactly three times", prompt)
                self.assertIn("DeepSeek V4 Pro 0813 ZDR Throughput", prompt)
                self.assertIn("exactly once", prompt)
                self.assertIn("terminal failure", prompt)
                self.assertIn("Do not dispatch GLM, GPT/codex-subscription, Kimi", prompt)
                self.assertNotIn("at most one", prompt)
                self.assertNotIn("may be resumed once", prompt)
        self.assertEqual((REPO / "runtime-profile.json").read_bytes(), routes_before)
        self.assertEqual({name: (REPO / name).read_bytes() for name in self.effective_paths}, source)
        self.assertEqual((REPO / self.router_mirror).read_bytes(), mirror_source)

    def test_unknown_profile_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(
            os.environ, {**os.environ, "OC_RUNTIME_STATE_DIR": state}, clear=True
        ):
            with self.assertRaisesRegex(SystemExit, "profile must be one of normal, normal-private, pentest"):
                runtime_profile.RuntimeProfiles(REPO).selected("unknown")

    def test_overlay_helper_is_idempotent(self) -> None:
        relative = pathlib.Path("agents/codex-router.md")
        source = (REPO / relative).read_text(encoding="utf-8")
        once = runtime_profile.render_pentest_prompt_overlay(source, "pentest", relative)
        twice = runtime_profile.render_pentest_prompt_overlay(once, "pentest", relative)
        self.assertEqual(twice, once)
        self.assertEqual(runtime_profile.render_pentest_prompt_overlay(source, "normal", relative), source)


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
