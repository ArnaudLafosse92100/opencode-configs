#!/usr/bin/env python3
"""Render immutable OpenConfig runtime profiles outside the Git checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


VALID_PROFILES = ("normal", "pentest")
VALID_SECTIONS = ("agents", "categories")


def load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"invalid JSON object: {path}")
    return data


def write_if_changed(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(mode)
    os.replace(temporary, path)


def replace_symlink(path: Path, target: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() and Path(os.readlink(path)) == target:
        return
    if path.exists() or path.is_symlink():
        if path.is_dir() and not path.is_symlink():
            raise SystemExit(f"refusing to replace runtime directory: {path}")
        path.unlink()
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.symlink_to(target)
    os.replace(temporary, path)


def parse_jsonc(text: str) -> dict:
    without_comments: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            without_comments.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            without_comments.append(char)
            index += 1
            continue
        if char == "/" and next_char == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(text) and text[index : index + 2] != "*/":
                if text[index] in "\r\n":
                    without_comments.append(text[index])
                index += 1
            if index + 1 >= len(text):
                raise SystemExit("unterminated block comment in native OmO config")
            index += 2
            continue
        without_comments.append(char)
        index += 1

    clean_chars: list[str] = []
    index = 0
    in_string = False
    escaped = False
    clean_source = "".join(without_comments)
    while index < len(clean_source):
        char = clean_source[index]
        if in_string:
            clean_chars.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            clean_chars.append(char)
            index += 1
            continue
        if char == ",":
            lookahead = index + 1
            while lookahead < len(clean_source) and clean_source[lookahead].isspace():
                lookahead += 1
            if lookahead < len(clean_source) and clean_source[lookahead] in "}]":
                index += 1
                continue
        clean_chars.append(char)
        index += 1

    clean = "".join(clean_chars)
    parsed = json.loads(clean)
    if not isinstance(parsed, dict):
        raise SystemExit("invalid native OmO config root")
    return parsed


def update_frontmatter_model(text: str, model: str, path: Path) -> str:
    lines = text.splitlines()
    in_frontmatter = False
    replaced = False
    updated: list[str] = []
    for index, line in enumerate(lines):
        if index == 0 and line == "---":
            in_frontmatter = True
            updated.append(line)
            continue
        if in_frontmatter and line == "---":
            in_frontmatter = False
            updated.append(line)
            continue
        if in_frontmatter and line.startswith("model: "):
            updated.append(f"model: {model}")
            replaced = True
            continue
        updated.append(line)
    if not replaced:
        raise SystemExit(f"missing model frontmatter in {path}")
    return "\n".join(updated).rstrip() + "\n"


def update_sisyphus_prompt(text: str, profile: str) -> str:
    normal_line = (
        "- Runtime profile `normal`: security/pentest work should still prefer "
        "`content-aware-*`, but normal model breadth remains available for non-security work."
    )
    pentest_line = (
        "- Runtime profile `pentest`: keep all agents/categories available, but "
        "pentest-safe routes use only GLM 5.3 and exact DeepSeek V4 snapshots "
        "(Flash 0731 for economical work, Pro 0813 for deep implementation/review). "
        "Do not use Gemini, Claude/Opus, Kimi, Minimax, subscription-gateway, "
        "`ultrawork`, `ulw`, or generic stronger-reasoning escalation inside "
        "pentest work. If filters bite, reroute unfinished work to "
        "`content-aware-fast`, `content-aware-deep`, or `content-aware-research`."
    )
    lines = [
        line
        for line in text.splitlines()
        if not line.startswith("- Runtime profile `normal`:")
        and not line.startswith("- Runtime profile `pentest`:")
        and not line.startswith("- Authorized pentest/security briefs must not use `ultrawork`")
    ]
    needle = "- Direct implementation bursts → Hephaestus. Use `deep` / `ultrabrain` only when stronger reasoning is required."
    insert = pentest_line if profile == "pentest" else normal_line
    try:
        lines.insert(lines.index(needle) + 1, insert)
    except ValueError:
        lines.append(insert)
    return "\n".join(lines).rstrip() + "\n"


class RuntimeProfiles:
    def __init__(self, repo: Path) -> None:
        self.repo = repo.resolve()
        self.profile_path = self.repo / "runtime-profile.json"
        self.data = load_json(self.profile_path)
        self.default = str(self.data.get("default_profile") or "normal")
        if self.default not in VALID_PROFILES:
            raise SystemExit(f"invalid default_profile in {self.profile_path}: {self.default!r}")
        for profile in VALID_PROFILES:
            selected = self.data.get(profile)
            if not isinstance(selected, dict):
                raise SystemExit(f"missing runtime profile {profile!r} in {self.profile_path}")
            for section in VALID_SECTIONS:
                if not isinstance(selected.get(section), dict):
                    raise SystemExit(f"invalid {profile}.{section} in {self.profile_path}")

        state_override = os.environ.get("OC_RUNTIME_STATE_DIR")
        if state_override:
            self.state_root = Path(state_override).expanduser().resolve()
        else:
            xdg_state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
            self.state_root = (xdg_state / "openconfig").expanduser().resolve()
        if self.state_root == Path("/") or self.state_root == Path.home():
            raise SystemExit(f"refusing unsafe runtime state root: {self.state_root}")
        self.active_path = self.state_root / "active-profile"
        self.runtime_root = self.state_root / "runtime"
        self.current_link = self.runtime_root / "current"
        prompt_override = os.environ.get("OC_RUNTIME_PROMPT_DIR")
        if prompt_override:
            self.prompt_root = Path(prompt_override).expanduser().resolve()
        elif state_override:
            self.prompt_root = self.state_root / "omo-prompts"
        else:
            self.prompt_root = Path.home() / ".omo/openconfig/runtime/profiles"
        native_override = os.environ.get("OC_NATIVE_OMO_PATH")
        self.native_omo_path = (
            Path(native_override).expanduser().resolve()
            if native_override
            else Path.home() / ".omo/omo.jsonc"
        )

    def active(self) -> str:
        if self.active_path.is_file():
            selected = self.active_path.read_text(encoding="utf-8").strip()
            if selected not in VALID_PROFILES:
                raise SystemExit(f"invalid active profile state in {self.active_path}: {selected!r}")
            return selected
        return self.default

    def selected(self, profile: str) -> dict:
        if profile not in VALID_PROFILES:
            raise SystemExit(f"profile must be one of {', '.join(VALID_PROFILES)}")
        return self.data[profile]

    def resolve(self, profile: str, section: str, name: str) -> dict:
        if section not in VALID_SECTIONS:
            raise SystemExit(f"route section must be one of {', '.join(VALID_SECTIONS)}")
        selected = self.selected(profile)
        route = (selected.get(section) or {}).get(name)
        if not isinstance(route, dict) or not isinstance(route.get("model"), str):
            raise SystemExit(f"route not found: {profile}.{section}.{name}")
        base = load_json(self.repo / "oh-my-openagent.json")
        base_route = ((base.get(section) or {}).get(name) or {})
        reasoning = base_route.get("reasoning")
        variant = base_route.get("variant")
        if variant is None and reasoning in ("low", "medium", "high", "max", "xhigh"):
            variant = "max" if reasoning == "xhigh" else reasoning
        return {
            "profile": profile,
            "section": section,
            "name": name,
            "model": route["model"],
            "fallback_models": list(route.get("fallback_models") or []),
            "variant": variant,
            "reasoning": reasoning,
            "source": str(self.profile_path),
        }

    def render(self, profile: str) -> Path:
        selected = self.selected(profile)
        runtime_dir = self.runtime_root / "profiles" / profile
        runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

        opencode = load_json(self.repo / "opencode.json")
        omo = load_json(self.repo / "oh-my-openagent.json")
        small_model = (
            selected.get("small_model")
            or ((selected.get("categories") or {}).get("quick") or {}).get("model")
            or ((selected.get("agents") or {}).get("codex-router") or {}).get("model")
        )
        helper_model = selected.get("helper_model") or small_model
        opencode["model"] = selected["agents"]["codex-router"]["model"]
        opencode["small_model"] = small_model
        for helper_name in ("title", "summary", "compaction"):
            helper = opencode.setdefault("agent", {}).setdefault(helper_name, {})
            helper["model"] = helper_model

        for section in VALID_SECTIONS:
            target = omo.setdefault(section, {})
            for name, patch in selected[section].items():
                if name not in target:
                    raise SystemExit(f"missing source route: {section}.{name}")
                target[name]["model"] = patch["model"]
                target[name]["fallback_models"] = list(patch.get("fallback_models") or [])

        prompt_source = self.repo / "prompts/agents/sisyphus.md"
        prompt_runtime = self.prompt_root / profile / "prompts/agents/sisyphus.md"
        prompt_content = update_sisyphus_prompt(prompt_source.read_text(encoding="utf-8"), profile)
        write_if_changed(prompt_runtime, prompt_content)
        omo["agents"]["sisyphus"]["prompt_append"] = f"file://{prompt_runtime}"

        write_if_changed(runtime_dir / "opencode.json", json.dumps(opencode, indent=2, ensure_ascii=False) + "\n")
        write_if_changed(runtime_dir / "oh-my-openagent.json", json.dumps(omo, indent=2, ensure_ascii=False) + "\n")

        agent_overrides = {
            "codex-router.md": selected["agents"]["codex-router"]["model"],
            "content-aware-research.md": selected["agents"]["content-aware-research"]["model"],
        }
        agents_dir = runtime_dir / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for source in (self.repo / "agents").iterdir():
            target = agents_dir / source.name
            if source.name in agent_overrides:
                content = update_frontmatter_model(
                    source.read_text(encoding="utf-8"), agent_overrides[source.name], source
                )
                write_if_changed(target, content)
            else:
                replace_symlink(target, source.resolve())

        profiles_dir = runtime_dir / "profiles"
        profiles_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for source in (self.repo / "profiles").iterdir():
            target = profiles_dir / source.name
            if source.name == "content-aware.json":
                content_aware = load_json(source)
                content_aware["model"] = selected["agents"]["content-aware-research"]["model"]
                content_aware["small_model"] = small_model
                write_if_changed(target, json.dumps(content_aware, indent=2, ensure_ascii=False) + "\n")
            else:
                replace_symlink(target, source.resolve())

        prompts_dir = runtime_dir / "prompts"
        replace_symlink(prompts_dir / "agents/sisyphus.md", prompt_runtime)
        for source in (self.repo / "prompts").rglob("*"):
            if not source.is_file() or source == prompt_source:
                continue
            relative = source.relative_to(self.repo / "prompts")
            replace_symlink(prompts_dir / relative, source.resolve())

        for entry in ("AGENTS.md", "tui.json", "projects.json", "bunfig.toml", "skills", "teams"):
            source = self.repo / entry
            if source.exists():
                replace_symlink(runtime_dir / entry, source.resolve())

        fingerprint_parts = [
            self.profile_path.read_bytes(),
            (self.repo / "opencode.json").read_bytes(),
            (self.repo / "oh-my-openagent.json").read_bytes(),
        ]
        metadata = {
            "schema_version": 1,
            "profile": profile,
            "source": str(self.profile_path),
            "fingerprint": hashlib.sha256(b"\0".join(fingerprint_parts)).hexdigest(),
        }
        write_if_changed(runtime_dir / ".runtime-profile.json", json.dumps(metadata, indent=2) + "\n")
        return runtime_dir

    def sync_native(self, runtime_dir: Path) -> None:
        mirrored = load_json(runtime_dir / "oh-my-openagent.json")
        prefix = "// OMO configuration\n"
        if self.native_omo_path.is_file():
            native_text = self.native_omo_path.read_text(encoding="utf-8")
            native = parse_jsonc(native_text)
            object_start = native_text.find("{")
            prefix = native_text[:object_start] if object_start >= 0 else prefix
            if "[opencode]" in native:
                native["[opencode]"] = mirrored
            else:
                native = {"[opencode]": mirrored}
        else:
            native = {"[opencode]": mirrored}
        write_if_changed(
            self.native_omo_path,
            prefix + json.dumps(native, indent=2, ensure_ascii=False) + "\n",
        )

    def activate(self, profile: str) -> Path:
        runtime_dir = self.render(profile)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_if_changed(self.active_path, profile + "\n")
        self.runtime_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        replace_symlink(self.current_link, runtime_dir)
        self.sync_native(runtime_dir)
        return runtime_dir

    def xdg_path(self, profile: str) -> Path:
        runtime_dir = self.render(profile)
        source_override = os.environ.get("OC_SOURCE_XDG_CONFIG_HOME")
        source_xdg = (
            Path(source_override).expanduser().resolve()
            if source_override
            else (Path.home() / ".config").resolve()
        )
        target_xdg = self.state_root / "xdg/profiles" / profile
        target_xdg.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source_xdg.is_dir():
            for source in source_xdg.iterdir():
                if source.name == "opencode":
                    continue
                target = target_xdg / source.name
                if target.exists() and not target.is_symlink():
                    continue
                replace_symlink(target, source.resolve())
        replace_symlink(target_xdg / "opencode", runtime_dir)
        return target_xdg


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--repo", required=True)
    sub = result.add_subparsers(dest="command", required=True)
    sub.add_parser("show")
    activate = sub.add_parser("activate")
    activate.add_argument("profile", choices=VALID_PROFILES)
    ensure = sub.add_parser("ensure")
    ensure.add_argument("--quiet", action="store_true")
    path = sub.add_parser("path")
    path.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    xdg_path = sub.add_parser("xdg-path")
    xdg_path.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    resolve = sub.add_parser("resolve")
    resolve.add_argument("profile", choices=VALID_PROFILES)
    resolve.add_argument("section", choices=VALID_SECTIONS)
    resolve.add_argument("name")
    return result


def main() -> int:
    args = parser().parse_args()
    profiles = RuntimeProfiles(Path(args.repo))
    if args.command == "show":
        print(profiles.active())
    elif args.command == "activate":
        profiles.activate(args.profile)
    elif args.command == "ensure":
        selected = profiles.active()
        runtime_dir = profiles.activate(selected)
        if not args.quiet:
            print(runtime_dir)
    elif args.command == "path":
        if args.profile:
            runtime_dir = profiles.render(args.profile)
        else:
            runtime_dir = profiles.activate(profiles.active())
        print(runtime_dir)
    elif args.command == "xdg-path":
        selected = args.profile or profiles.active()
        print(profiles.xdg_path(selected))
    elif args.command == "resolve":
        print(json.dumps(profiles.resolve(args.profile, args.section, args.name), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
