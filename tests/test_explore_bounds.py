"""Regression coverage for headless Explore permissions and bounded execution."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]


class ExploreBoundsTests(unittest.TestCase):
    def test_canonical_permissions_and_native_budget(self):
        oc = json.loads((REPO / "opencode.json").read_text())
        omo = json.loads((REPO / "oh-my-openagent.json").read_text())
        self.assertEqual(oc["permission"]["doom_loop"], "deny")
        self.assertEqual(oc["agent"]["explore"]["steps"], 24)
        permission = omo["agents"]["explore"]["permission"]
        self.assertEqual(permission["codegraph*"], "allow")
        self.assertEqual(permission["edit"], "deny")
        self.assertEqual(permission["task"], "deny")

    def test_fix_repairs_legacy_state_and_is_idempotent(self):
        # Execute the actual repair blocks without invoking unrelated machine repairs.
        source = (REPO / "fix.sh").read_text()
        core = source.split("# Headless execution cannot", 1)[1].split(
            "# Official OpenCode default:", 1)[0]
        core = "# Headless execution cannot" + core
        permission = source.split('explore_perm = agents.setdefault', 1)[1].split(
            'heph = agents.setdefault', 1)[0]
        permission = 'explore_perm = agents.setdefault' + permission
        oc = {"permission": {"doom_loop": "allow"}, "agent": {"explore": {"description": "keep"}}}
        agents = {"explore": {"permission": {"edit": "deny", "task": "deny"}, "model": "keep"}}
        state = {"oc": oc, "perm": oc["permission"], "agents": agents, "changes": []}
        exec(core + permission, state)
        self.assertEqual(oc["permission"]["doom_loop"], "deny")
        self.assertEqual(oc["agent"]["explore"], {"steps": 24, "description": "keep"})
        self.assertEqual(agents["explore"]["permission"], {"edit": "deny", "task": "deny", "codegraph*": "allow"})
        self.assertEqual(agents["explore"]["model"], "keep")
        before = copy.deepcopy((oc, agents))
        state["changes"] = []
        exec(core + permission, state)
        self.assertEqual((oc, agents), before)
        self.assertEqual(state["changes"], [])

    def test_render_preserves_bounds_and_profile_routes(self):
        spec = importlib.util.spec_from_file_location("explore_runtime_profiles", REPO / "scripts/runtime-profile.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as state, patch.dict(os.environ, {"OC_RUNTIME_STATE_DIR": state}):
            profiles = module.RuntimeProfiles(REPO)
            for name in ("normal", "normal-private", "pentest"):
                with self.subTest(profile=name):
                    runtime = profiles.render(name)
                    oc = json.loads((runtime / "opencode.json").read_text())
                    omo = json.loads((runtime / "oh-my-openagent.json").read_text())
                    self.assertEqual(oc["permission"]["doom_loop"], "deny")
                    self.assertEqual(oc["agent"]["explore"]["steps"], 24)
                    self.assertEqual(omo["agents"]["explore"]["permission"]["codegraph*"], "allow")
                    selected = profiles.selected(name)
                    for section in ("agents", "categories"):
                        for agent, route in selected[section].items():
                            self.assertEqual(omo[section][agent]["model"], route["model"])
                            self.assertEqual(omo[section][agent].get("fallback_models"), route.get("fallback_models"))


if __name__ == "__main__":
    unittest.main()
