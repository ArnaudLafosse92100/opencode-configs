#!/usr/bin/env python3
"""Render immutable OpenConfig runtime profiles outside the Git checkout."""

from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
from datetime import datetime, timezone
import uuid


VALID_PROFILES = ("normal", "normal-private", "pentest")
VALID_SECTIONS = ("agents", "categories")
NATIVE_OMO_MIGRATIONS = (
    "2026-07-opencode-config-unification",
    "2026-08-reasoning-unification",
)

# The immutable runtime payload is copied into a generation. Compatibility
# additionally executes (or links to) this small source-side launcher set.
# Keep both lists here: the source fingerprint is the sole reuse key for the
# generation, so a changed launcher can never be served by an old compat view.
RUNTIME_RENDER_INPUTS = (
    "opencode.json", "oh-my-openagent.json", "agents", "profiles", "prompts",
    "skills", "teams", "AGENTS.md", "tui.json", "projects.json", "bunfig.toml",
)
COMPAT_EXECUTED_SOURCE_INPUTS = (
    "oc", "runtime-profile.sh", "opencode.sh", "run.sh", "openrouter-admin.sh",
    "zshrc.snippet", "lib",
)
SOURCE_FINGERPRINT_INPUTS = (
    "scripts/runtime-profile.py", "runtime-profile.json", *RUNTIME_RENDER_INPUTS,
    *COMPAT_EXECUTED_SOURCE_INPUTS,
)
SISYPHUS_PROMPT_URI = "file://~/.config/opencode/prompts/agents/sisyphus.md"
PENTEST_PROMPT_OVERLAY_START = "<!-- BEGIN GENERATED: pentest-cost-policy -->"
PENTEST_PROMPT_OVERLAY_END = "<!-- END GENERATED: pentest-cost-policy -->"


def render_pentest_prompt_overlay(text: str, profile: str, path: Path) -> str:
    """Apply the pentest-only delegation policy to generated prompt copies.

    Source prompts stay the normal baseline. Removing a prior generated block
    first makes re-rendering idempotent and keeps the normal generation byte
    identical to its source prompt.
    """
    if text.count(PENTEST_PROMPT_OVERLAY_START) != text.count(PENTEST_PROMPT_OVERLAY_END):
        raise SystemExit(f"unbalanced generated pentest policy markers in {path}")
    if text.count(PENTEST_PROMPT_OVERLAY_START) > 1:
        raise SystemExit(f"duplicate generated pentest policy markers in {path}")
    if PENTEST_PROMPT_OVERLAY_START in text:
        before, remainder = text.split(PENTEST_PROMPT_OVERLAY_START, 1)
        _, after = remainder.split(PENTEST_PROMPT_OVERLAY_END, 1)
        text = before.rstrip() + "\n" + after.lstrip("\n")
    if profile in ("normal", "normal-private"):
        return text
    if profile != "pentest":
        raise SystemExit(f"profile must be one of {', '.join(VALID_PROFILES)}")

    policies = {
        "agents/codex-router.md": """## Pentest cost-aware delegation policy\n\nThis is a soft prompt policy, not a hard runtime cap. For authorized pentest work, run `content-aware-fast` on Flash first for reconnaissance and deduplication. Escalate only concrete evidence-backed targets: batch no more than three targets in one deep request, launch at most one **new** `content-aware-deep` Pro child for the parent request, and resume that same child at most once only for one narrow, named gap instead of launching another child.\n\nThe Pro child adjudicates the Flash evidence; it must not broadly rediscover or repeat scans. Batch reads and tool calls. Aim for at most four tool-call rounds, then return a final answer with explicit unverified gaps rather than expanding or looping. An explicit user demand for multiple independent deep reviewers may override the one-child count, but disclose the expected cost before launching them.\n""",
        "prompts/categories/content-aware-deep.md": """## Pentest cost-aware depth policy\n\nThis is a soft prompt policy, not a hard runtime cap. Treat Flash `content-aware-fast` reconnaissance and deduplication as the input to Pro adjudication. Work only the concrete evidence-backed targets supplied by that recon, batching no more than three targets. Do not broadly rediscover or repeat scans. Batch reads and tool calls; target at most four tool-call rounds, then return the finding with explicit unverified gaps rather than expanding or looping.\n\nFor one parent request, there should be at most one new Pro `content-aware-deep` child. That child may be resumed once only for one narrow, named gap; do not create another deep child for the same gap. If the user explicitly requires multiple independent deep reviewers, disclose the expected cost before they are launched.\n""",
    }
    policy = policies.get(path.as_posix())
    if policy is None:
        return text
    return "\n".join((text.rstrip(), "", PENTEST_PROMPT_OVERLAY_START, policy.rstrip(), PENTEST_PROMPT_OVERLAY_END, ""))


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


def is_broken_legacy_native_migration(document: object) -> bool:
    """Recognize only OmO's old flat, partially-migrated native document.

    OmO 4.19.4's valid generated native format is an ``[opencode]`` envelope
    containing route ``models`` arrays. The historical broken state was a
    regular ``~/.omo/omo.jsonc`` whose top-level routing sections were changed
    to that new shape without being wrapped. This deliberately refuses to
    classify any envelope (or arbitrary JSON containing a ``models`` key) as
    broken, which keeps consumers such as ``fix.sh`` safe around the governed
    alias.
    """
    if not isinstance(document, dict) or "[opencode]" in document:
        return False
    sections = [document.get(name) for name in VALID_SECTIONS]
    if not all(isinstance(routes, dict) for routes in sections):
        return False
    for routes in sections:
        for route in routes.values():
            if isinstance(route, dict) and isinstance(route.get("models"), list):
                return True
    return False


def native_opencode_digest(path: Path) -> str:
    native = parse_jsonc(path.read_text(encoding="utf-8"))
    section = native.get("[opencode]")
    if section is None:
        return "missing"
    if not isinstance(section, dict):
        raise SystemExit(f"invalid [opencode] object in {path}")
    canonical = canonical_native_opencode(section)
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _canonical_reasoning(value: object) -> str | None:
    """Mirror OmO 4.19.4's small legacy reasoning vocabulary normalization."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    return "off" if normalized == "none" else normalized


def _route_reasoning(route: dict, section: str) -> str | None:
    """Accept duplicate legacy aliases only when they mean the same thing."""
    values: list[str] = []
    for key in ("reasoning", "reasoningEffort", "variant"):
        if key not in route:
            continue
        normalized = _canonical_reasoning(route[key])
        if normalized is None:
            raise SystemExit(f"invalid generated {section} {key} for native OmO migration")
        values.append(normalized)
    if len(set(values)) > 1:
        raise SystemExit(f"conflicting generated {section} reasoning fields for native OmO migration")
    if "thinking" in route:
        # The pinned transform can preserve enabled thinking through provider
        # options. OpenConfig does not author that shape, so rejecting it is
        # safer than silently weakening or inventing a model setting.
        raise SystemExit(f"unsupported generated {section}.thinking for native OmO migration")
    return values[0] if values else None


def _canonical_model_ref(value: object, section: str) -> str | dict:
    if isinstance(value, str):
        if not value:
            raise SystemExit(f"empty generated {section} model reference")
        return value
    if not isinstance(value, dict) or not isinstance(value.get("model"), str) or not value["model"]:
        raise SystemExit(f"invalid generated {section} model reference")
    result = copy.deepcopy(value)
    if "reasoning" in result:
        reasoning = _canonical_reasoning(result["reasoning"])
        if reasoning is None:
            raise SystemExit(f"invalid generated {section} model reasoning")
        result["reasoning"] = reasoning
    return result


def _canonical_models_route(route: dict, section: str) -> dict:
    """Validate an already-migrated generated route for semantic comparison."""
    result = copy.deepcopy(route)
    if "model" in result or "fallback_models" in result:
        raise SystemExit(f"mixed legacy/native generated {section} route")
    for field in ("reasoning", "variant", "reasoningEffort", "thinking"):
        if field in result:
            raise SystemExit(f"legacy generated {section} route field in native models syntax: {field}")
    models = result.get("models")
    if not isinstance(models, list) or not models:
        raise SystemExit(f"invalid generated {section}.models for native OmO migration")
    result["models"] = [_canonical_model_ref(value, section) for value in models]
    return result


def _native_models(route: dict, section: str) -> dict:
    """Apply OmO 4.19.4 reasoning-unification to one generated route.

    `runtime-profile.json` deliberately remains the legacy routing SSoT.  Only
    the native `.omo.jsonc` envelope uses OmO's current `models` priority
    syntax, so startup has nothing left to migrate or write.
    """
    result = copy.deepcopy(route)
    if "models" in result:
        raise SystemExit(f"unsupported pre-existing generated {section}.models for native OmO migration")
    primary = result.pop("model", None)
    fallbacks = result.pop("fallback_models", None)
    if not isinstance(primary, str) or not isinstance(fallbacks, list) or not all(isinstance(item, str) for item in fallbacks):
        raise SystemExit(f"invalid generated {section} route for native OmO migration")

    reasoning = _route_reasoning(result, section)
    primary_ref: str | dict[str, str] = primary if reasoning is None else {"model": primary, "reasoning": reasoning}
    result["models"] = [primary_ref, *fallbacks]
    for field in (
        "reasoning", "variant", "reasoningEffort", "provider_options",
        "providerOptions", "thinking", "textVerbosity",
    ):
        result.pop(field, None)
    return result


def migrate_native_opencode(mirrored: dict) -> dict:
    """Return an OmO 4.19.4-native `[opencode]` configuration envelope."""
    migrated = copy.deepcopy(mirrored)
    for section in VALID_SECTIONS:
        routes = migrated.get(section)
        if not isinstance(routes, dict):
            raise SystemExit(f"generated native OmO config lacks {section}")
        native_routes: dict[str, dict] = {}
        for name, route in routes.items():
            if not isinstance(route, dict):
                raise SystemExit(f"invalid generated {section}.{name}")
            native_routes[name] = _native_models(route, section)
        migrated[section] = native_routes
    return migrated


def canonical_native_opencode(section: dict) -> dict:
    """Normalize legacy or generated routes to the one native semantic shape."""
    canonical = copy.deepcopy(section)
    for route_section in VALID_SECTIONS:
        routes = canonical.get(route_section)
        if not isinstance(routes, dict):
            raise SystemExit(f"native OmO config lacks {route_section}")
        normalized_routes: dict[str, dict] = {}
        for name, route in routes.items():
            if not isinstance(route, dict):
                raise SystemExit(f"invalid native {route_section}.{name}")
            if "models" in route:
                normalized_routes[name] = _canonical_models_route(route, route_section)
            else:
                normalized_routes[name] = _native_models(route, route_section)
        canonical[route_section] = normalized_routes
    return canonical


def _managed_sisyphus_prompt_path(value: object, profile: str, *, target_runtime: Path | None = None) -> bool:
    if not isinstance(value, str) or not value.startswith("file://") or profile not in VALID_PROFILES:
        return False
    candidate = Path(value.removeprefix("file://"))
    suffix = Path("prompts/agents/sisyphus.md")
    legacy = Path.home() / ".omo/openconfig/runtime/profiles" / profile / suffix
    if target_runtime is None:
        # Source compatibility is deliberately one-way: only the historical
        # legacy location may be migrated.  Do not accept forged/current
        # generation references from an old native file.
        return candidate.resolve(strict=False) == legacy.resolve(strict=False)
    # OmO accepts prompt files only below a bounded set of roots. Runtime
    # generations live under ~/.local/state and are rejected even though they
    # are immutable. The stable ~/.config/opencode alias is inside the allowed
    # root and resolves through compat/current to the same selected generation.
    return value == SISYPHUS_PROMPT_URI


def native_opencode_migration_equivalent(source: Path, target: Path, profile: str) -> bool:
    """Allow only the known legacy -> generation Sisyphus prompt relocation."""
    source_document = parse_jsonc(source.read_text(encoding="utf-8"))
    target_document = parse_jsonc(target.read_text(encoding="utf-8"))
    source_section = source_document.get("[opencode]")
    target_section = target_document.get("[opencode]")
    if not isinstance(source_section, dict) or not isinstance(target_section, dict):
        return False
    try:
        source_copy = canonical_native_opencode(source_section)
        target_copy = canonical_native_opencode(target_section)
    except SystemExit:
        return False
    try:
        source_prompt = source_copy["agents"]["sisyphus"].pop("prompt_append")
        target_prompt = target_copy["agents"]["sisyphus"].pop("prompt_append")
    except (KeyError, TypeError):
        return False
    if source_copy != target_copy:
        return False
    try:
        target_runtime = (target.parent / ".runtime").resolve(strict=True)
    except OSError:
        return False
    return _managed_sisyphus_prompt_path(source_prompt, profile) \
        and _managed_sisyphus_prompt_path(target_prompt, profile, target_runtime=target_runtime)


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
            if selected.get("compose") == "normal":
                if profile != "normal-private" or not isinstance(selected.get("privacy"), dict):
                    raise SystemExit(f"invalid composed runtime profile {profile!r} in {self.profile_path}")
                continue
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
        self.applied_path = self.state_root / "applied-profile.json"
        self.transaction_path = self.state_root / ".runtime-profile.transaction.json"
        self.runtime_root = self.state_root / "runtime"
        self.current_link = self.runtime_root / "current"
        # `~/.config/opencode` is deliberately *not* the checkout.  It points
        # at this writable compatibility view, while the checkout remains the
        # immutable config source.  This keeps raw `opencode` invocations from
        # dropping package-manager artefacts into the Git repository.
        self.compat_root = self.state_root / "compat"
        self.compat_current_link = self.compat_root / "current"
        native_override = os.environ.get("OC_NATIVE_OMO_PATH")
        # Preserve the final path component lexically: resolving this path
        # would dereference an operator-approved compat/current alias and make
        # us write/check inside the generated profile instead of ~/.omo.
        native_raw = Path(native_override).expanduser() if native_override else Path.home() / ".omo/omo.jsonc"
        self.native_omo_path = native_raw.absolute()
        self.native_migration_journal = self.native_omo_path.parent / ".migration-journal.json"

    def assert_native_migration_safe(self) -> None:
        """Never write native OmO config while its own migration is pending.

        OmO's journal may still name a tracked OpenConfig source file as a
        move target.  Resuming or writing around it could relocate canonical
        source; an operator must inspect/recover that migration explicitly.
        """
        if self.native_migration_journal.exists() or self.native_migration_journal.is_symlink():
            raise SystemExit(
                "native OmO migration journal is present at "
                f"{self.native_migration_journal}; refusing profile/native writes. "
                "Inspect and explicitly resolve the OmO migration before using oc profile."
            )

    def active(self) -> str:
        if self.active_path.is_file():
            selected = self.active_path.read_text(encoding="utf-8").strip()
            if selected not in VALID_PROFILES:
                raise SystemExit(f"invalid active profile state in {self.active_path}: {selected!r}")
            return selected
        return self.default

    def _write_transaction(self, previous: str, target: str, target_compat: Path, *, sync_native: bool) -> None:
        previous_compat: str | None = None
        try:
            previous_compat = str(self.compat_current_link.resolve(strict=True))
        except OSError:
            pass
        write_if_changed(
            self.transaction_path,
            json.dumps(
                {
                    "schema_version": 2,
                    "previous": previous,
                    "target": target,
                    "previous_compat": previous_compat,
                    "target_compat": str(target_compat.resolve(strict=True)),
                    "sync_native": sync_native,
                },
                indent=2,
            ) + "\n",
        )

    def _clear_transaction(self) -> None:
        if self.transaction_path.exists() or self.transaction_path.is_symlink():
            self.transaction_path.unlink()

    def invalidate_applied(self) -> None:
        if self.applied_path.exists() or self.applied_path.is_symlink():
            self.applied_path.unlink()

    def runtime_fingerprint(self, runtime_dir: Path) -> str:
        fingerprint = load_json(runtime_dir / ".runtime-profile.json").get("fingerprint")
        if not isinstance(fingerprint, str) or not fingerprint:
            raise SystemExit(f"invalid runtime fingerprint: {runtime_dir}")
        return fingerprint

    def runtime_generation(self, runtime_dir: Path) -> str:
        generation = load_json(runtime_dir / ".runtime-profile.json").get("generation")
        if not isinstance(generation, str) or not generation:
            raise SystemExit(f"invalid runtime generation: {runtime_dir}")
        return generation

    def expected_router_model(self, profile: str) -> str:
        model = self.selected(profile)["agents"]["codex-router"].get("model")
        if not isinstance(model, str):
            raise SystemExit(f"missing codex-router model for {profile}")
        return model.split("/", 1)[-1]

    def applied_identity(self, profile: str | None = None) -> dict:
        profile = profile or self.active()
        compat = self.current_compat(profile)
        if compat is None:
            raise SystemExit("cannot read identity from an uncommitted or stale profile generation")
        runtime_dir = (compat / ".runtime").resolve(strict=True)
        compat_metadata = load_json(compat / ".runtime-profile.json")
        manifest = (compat / ".generation-manifest.json").read_bytes()
        return {
            "schema_version": 3,
            "profile": profile,
            "fingerprint": self.runtime_fingerprint(runtime_dir),
            "generation": self.runtime_generation(runtime_dir),
            "compat_generation": compat.name,
            "xdg_identity": compat_metadata.get("xdg_identity"),
            "compat_identity": compat_metadata.get("compat_identity"),
            "compat_manifest_sha256": hashlib.sha256(manifest).hexdigest(),
            "model": self.expected_router_model(profile),
        }

    def mark_applied(self, profile: str, model: str) -> None:
        if profile != self.active():
            raise SystemExit(f"cannot mark stale profile applied: desired={self.active()} requested={profile}")
        identity = self.applied_identity(profile)
        expected_model = identity["model"]
        if model != expected_model:
            raise SystemExit(f"cannot mark unexpected applied model: expected={expected_model} got={model}")
        write_if_changed(
            self.applied_path,
            json.dumps({**identity, "applied_at": datetime.now(timezone.utc).isoformat()}, indent=2) + "\n",
        )

    def applied(self) -> dict | None:
        if not self.applied_path.is_file():
            return None
        payload = load_json(self.applied_path)
        if payload.get("profile") not in VALID_PROFILES:
            raise SystemExit(f"invalid applied profile marker: {self.applied_path}")
        return payload

    def snapshot(self) -> dict:
        """Return one coherent, non-rendering view of the selected generation.

        Callers that need profile, applied proof and paired paths must use this
        instead of composing several commands. A pending transaction or any
        stale/corrupt generation deliberately returns null paths/identity;
        snapshot never repairs, renders, activates, or changes selection.
        """
        desired = self.active()
        try:
            applied = self.applied()
        except (Exception, SystemExit):
            applied = None
        payload: dict[str, object] = {
            "schema_version": 1,
            "desiredProfile": desired,
            "applied": applied,
            "runtimePath": None,
            "compatPath": None,
            "expectedIdentity": None,
        }
        if self.transaction_path.exists() or self.transaction_path.is_symlink():
            return payload
        try:
            compat = self.current_compat(desired)
            if compat is None:
                return payload
            runtime = (compat / ".runtime").resolve(strict=True)
            payload["runtimePath"] = str(runtime)
            payload["compatPath"] = str(compat)
            payload["expectedIdentity"] = self.applied_identity(desired)
        except (Exception, SystemExit):
            # Snapshot is a fail-closed observation API: an invalid current
            # generation must not be repaired or partially reported here.
            return payload
        return payload

    def recover_pending(self) -> None:
        """Roll back an interrupted multi-file switch before exposing state.

        `compat/current` is the selection commit point; runtime/current and
        active-profile are stable aliases through it.  A durable transaction
        protects legacy regular native files until an operator elects the
        stable native alias. Every `oc` reader self-heals to the last complete
        profile before it reports a value.
        """
        if not self.transaction_path.is_file():
            return
        try:
            transaction = load_json(self.transaction_path)
            previous = transaction.get("previous")
            previous_compat_raw = transaction.get("previous_compat")
            target_compat_raw = transaction.get("target_compat")
            sync_native = transaction.get("sync_native")
        except (Exception, SystemExit):
            previous = previous_compat_raw = target_compat_raw = sync_native = None
        if previous not in VALID_PROFILES:
            raise SystemExit(f"invalid interrupted runtime-profile transaction: {self.transaction_path}")
        # A first publish has no previous generation.  Its fully validated
        # target is durable before the transaction is written, so recovery can
        # safely complete that exact generation without rendering again.
        compat_raw = previous_compat_raw if isinstance(previous_compat_raw, str) else target_compat_raw
        if not isinstance(compat_raw, str):
            self._clear_first_publish_state()
            return
        compat_dir = Path(compat_raw)
        try:
            compat_real = compat_dir.resolve(strict=True)
            root_real = (self.compat_root / "generations").resolve(strict=True)
            compat_real.relative_to(root_real)
            runtime_dir = (compat_real / ".runtime").resolve(strict=True)
            expected_profile = previous if isinstance(previous_compat_raw, str) else transaction.get("target")
            if expected_profile not in VALID_PROFILES:
                raise SystemExit("invalid first-publish target profile")
            self._validate_compat_generation(compat_real, runtime_dir, expected_profile)
        except (OSError, ValueError, SystemExit) as exc:
            raise SystemExit(f"cannot safely recover interrupted profile generation: {exc}") from exc
        self.ensure_commit_aliases()
        replace_symlink(self.compat_current_link, compat_real)
        if sync_native is not False:
            self.sync_native(runtime_dir)
        self._clear_transaction()

    def _clear_first_publish_state(self) -> None:
        """Leave a fresh state root truly empty if its target is unusable."""
        for path in (self.compat_current_link, self.current_link, self.active_path):
            if path.is_symlink():
                path.unlink()
        self._clear_transaction()

    @contextmanager
    def locked(self):
        """Serialize every state observation/render/switch across processes."""
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.state_root / ".runtime-profile.lock"
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def selected(self, profile: str) -> dict:
        if profile not in VALID_PROFILES:
            raise SystemExit(f"profile must be one of {', '.join(VALID_PROFILES)}")
        selected = self.data[profile]
        if selected.get("compose") != "normal":
            return selected

        # `normal-private` is intentionally a render-time composition, never
        # a hand-maintained duplicate route matrix.  Preserve normal route
        # order while removing subscription-gateway rungs and promoting the
        # first remaining OpenRouter rung when the normal primary was gateway.
        private = copy.deepcopy(self.data["normal"])
        for section in VALID_SECTIONS:
            for name, route in private[section].items():
                chain = [route.get("model"), *(route.get("fallback_models") or [])]
                openrouter = [model for model in chain if isinstance(model, str) and model.startswith("openrouter/")]
                if not openrouter:
                    raise SystemExit(f"normal-private route has no OpenRouter model: {section}.{name}")
                route["model"] = openrouter[0]
                route["fallback_models"] = openrouter[1:]
        private["privacy"] = copy.deepcopy(selected["privacy"])
        return private

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

    def source_fingerprint(self) -> str:
        """Hash generator plus every copied or compat-executed input (never `.env`)."""
        digest = hashlib.sha256()
        # The generated wrappers and source marker are checkout-specific even
        # when two clones have identical content.
        digest.update(f"source-root\0{self.repo}\0".encode("utf-8"))
        for name in SOURCE_FINGERPRINT_INPUTS:
            source = self.repo / name
            if source.is_file() or source.is_symlink():
                stat = source.lstat()
                digest.update(f"{name}\0{stat.st_mode:o}\0".encode("utf-8"))
                if source.is_symlink():
                    digest.update(os.readlink(source).encode("utf-8") + b"\0")
                else:
                    digest.update(source.read_bytes() + b"\0")
            elif source.is_dir():
                for child in sorted(source.rglob("*")):
                    relative = child.relative_to(self.repo).as_posix()
                    stat = child.lstat()
                    digest.update(f"{relative}\0{stat.st_mode:o}\0".encode("utf-8"))
                    if child.is_symlink():
                        digest.update(os.readlink(child).encode("utf-8") + b"\0")
                    elif child.is_file():
                        digest.update(child.read_bytes() + b"\0")
        return digest.hexdigest()

    def compat_identity(self) -> dict[str, str | bool]:
        """Structural inputs owned by compat, intentionally excluding secrets."""
        env_source = self.repo / ".env"
        return {
            "source_root": str(self.repo),
            "env_present": env_source.exists() or env_source.is_symlink(),
            "env_target": str(env_source.resolve(strict=False)) if (env_source.exists() or env_source.is_symlink()) else "",
        }

    def xdg_identity(self) -> str:
        """Identity of immediate non-OpenCode XDG siblings, never their data."""
        source_override = os.environ.get("OC_SOURCE_XDG_CONFIG_HOME")
        source_xdg = Path(source_override).expanduser().resolve() if source_override else (Path.home() / ".config").resolve()
        entries: list[dict[str, str]] = []
        if source_xdg.is_dir():
            for source in sorted(source_xdg.iterdir(), key=lambda path: path.name):
                if source.name == "opencode":
                    continue
                stat = source.lstat()
                kind = "symlink" if source.is_symlink() else "dir" if source.is_dir() else "file" if source.is_file() else "other"
                entries.append({"name": source.name, "kind": kind, "resolved": str(source.resolve(strict=False))})
        return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()

    @staticmethod
    def _managed_manifest(root: Path) -> dict:
        """Content proof for copied compat inputs; raw OpenCode junk is absent."""
        managed = (
            *RUNTIME_RENDER_INPUTS,
            ".active-profile", ".runtime-profile.json", ".omo.jsonc", "oc", "opencode.sh",
            "run.sh", "openrouter-admin.sh", "xdg", ".openconfig-source", "lib",
            "zshrc.snippet", ".runtime",
        )
        entries: list[dict[str, str]] = []
        for name in managed:
            base = root / name
            if not (base.exists() or base.is_symlink()):
                continue
            paths = [base, *sorted(base.rglob("*"))] if base.is_dir() and not base.is_symlink() else [base]
            for path in paths:
                relative = path.relative_to(root).as_posix()
                stat = path.lstat()
                item = {"path": relative, "mode": oct(stat.st_mode & 0o7777)}
                if path.is_symlink():
                    item.update({"kind": "symlink", "target": os.readlink(path)})
                elif path.is_dir():
                    item.update({"kind": "dir"})
                elif path.is_file():
                    item.update({"kind": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
                else:
                    raise SystemExit(f"unsupported managed compatibility entry: {path}")
                entries.append(item)
        payload = {"schema_version": 1, "entries": entries}
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return {**payload, "digest": hashlib.sha256(canonical).hexdigest()}

    @staticmethod
    def _runtime_manifest(root: Path) -> dict:
        managed = (*RUNTIME_RENDER_INPUTS, ".runtime-profile.json")
        entries: list[dict[str, str]] = []
        for name in managed:
            base = root / name
            if not (base.exists() or base.is_symlink()):
                continue
            paths = [base, *sorted(base.rglob("*"))] if base.is_dir() and not base.is_symlink() else [base]
            for path in paths:
                relative = path.relative_to(root).as_posix()
                stat = path.lstat()
                item = {"path": relative, "mode": oct(stat.st_mode & 0o7777)}
                if path.is_symlink():
                    item.update({"kind": "symlink", "target": os.readlink(path)})
                elif path.is_dir():
                    item.update({"kind": "dir"})
                elif path.is_file():
                    item.update({"kind": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
                else:
                    raise SystemExit(f"unsupported managed runtime entry: {path}")
                entries.append(item)
        payload = {"schema_version": 1, "entries": entries}
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return {**payload, "digest": hashlib.sha256(canonical).hexdigest()}

    @classmethod
    def _write_managed_manifest(cls, root: Path) -> None:
        write_if_changed(root / ".generation-manifest.json", json.dumps(cls._managed_manifest(root), indent=2, ensure_ascii=False) + "\n")

    @classmethod
    def _validate_managed_manifest(cls, root: Path) -> None:
        expected = cls._managed_manifest(root)
        actual = load_json(root / ".generation-manifest.json")
        if actual != expected:
            raise SystemExit(f"managed compatibility generation drift: {root}")

    @classmethod
    def _write_runtime_manifest(cls, root: Path) -> None:
        write_if_changed(root / ".generation-manifest.json", json.dumps(cls._runtime_manifest(root), indent=2, ensure_ascii=False) + "\n")

    @classmethod
    def _validate_runtime_manifest(cls, root: Path) -> None:
        if load_json(root / ".generation-manifest.json") != cls._runtime_manifest(root):
            raise SystemExit(f"managed runtime generation drift: {root}")

    @staticmethod
    def _copy_entry(source: Path, target: Path) -> None:
        """Copy profile inputs into a generation; never retain source links."""
        if source.is_dir():
            shutil.copytree(source, target, symlinks=False)
        else:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(source, target, follow_symlinks=True)

    def current_compat(self, profile: str) -> Path | None:
        try:
            compat = self.compat_current_link.resolve(strict=True)
            metadata = load_json(compat / ".runtime-profile.json")
            runtime = (compat / ".runtime").resolve(strict=True)
            runtime_metadata = load_json(runtime / ".runtime-profile.json")
            if metadata.get("profile") == profile and metadata.get("fingerprint") == self.source_fingerprint() \
                and metadata.get("xdg_identity") == self.xdg_identity() \
                and metadata.get("compat_identity") == self.compat_identity() \
                and all(metadata.get(key) == value for key, value in runtime_metadata.items()):
                self._validate_runtime_generation(runtime, profile, self.source_fingerprint())
                self._validate_compat_generation(compat, runtime, profile)
                return compat
        except (Exception, SystemExit):
            pass
        return None

    def reusable_compat(self, profile: str) -> Path | None:
        """Find an intact generation without exposing a mutable latest link."""
        current = self.current_compat(profile)
        if current is not None:
            return current
        root = self.compat_root / "generations"
        if not root.is_dir():
            return None
        fingerprint = self.source_fingerprint()
        for candidate in sorted((path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")), reverse=True):
            try:
                metadata = load_json(candidate / ".runtime-profile.json")
                runtime = (candidate / ".runtime").resolve(strict=True)
                if metadata.get("profile") != profile or metadata.get("fingerprint") != fingerprint \
                    or metadata.get("xdg_identity") != self.xdg_identity() \
                    or metadata.get("compat_identity") != self.compat_identity():
                    continue
                if load_json(runtime / ".runtime-profile.json") != metadata:
                    runtime_metadata = load_json(runtime / ".runtime-profile.json")
                    if not all(metadata.get(key) == value for key, value in runtime_metadata.items()):
                        continue
                self._validate_runtime_generation(runtime, profile, fingerprint)
                self._validate_compat_generation(candidate, runtime, profile)
                return candidate
            except (Exception, SystemExit):
                continue
        return None

    def reusable_runtime(self, profile: str) -> Path | None:
        """Reuse an immutable runtime overlay for inactive `path` callers."""
        compat = self.reusable_compat(profile)
        if compat is not None:
            return (compat / ".runtime").resolve(strict=True)
        root = self.runtime_root / "generations"
        if not root.is_dir():
            return None
        fingerprint = self.source_fingerprint()
        for candidate in sorted((path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")), reverse=True):
            try:
                self._validate_runtime_generation(candidate, profile, fingerprint)
                return candidate
            except (Exception, SystemExit):
                continue
        return None

    def render(self, profile: str, force: bool = False) -> Path:
        if not force:
            reusable = self.reusable_runtime(profile)
            if reusable is not None:
                return reusable
        selected = self.selected(profile)
        fingerprint = self.source_fingerprint()
        generation_root = self.runtime_root / "generations"
        generation = generation_root / f"{profile}-{fingerprint[:16]}-{uuid.uuid4().hex[:12]}"
        staging = generation_root / ".staging" / f"{generation.name}.staging"
        runtime_dir = staging
        runtime_dir.mkdir(parents=True, exist_ok=False, mode=0o700)

        opencode = load_json(self.repo / "opencode.json")
        omo = load_json(self.repo / "oh-my-openagent.json")
        if profile == "normal-private":
            # Privacy is rendered, not copied into a second route matrix.  Do
            # not claim provider attestation: these are OpenRouter request
            # constraints only, applied to every model that can be selected.
            enabled = opencode.get("enabled_providers")
            if isinstance(enabled, list):
                opencode["enabled_providers"] = [name for name in enabled if name != "subscription-gateway"]
            for model in ((opencode.get("provider") or {}).get("openrouter") or {}).get("models", {}).values():
                if not isinstance(model, dict):
                    raise SystemExit("invalid OpenRouter model definition for normal-private")
                provider = ((model.setdefault("options", {})).setdefault("provider", {}))
                provider["data_collection"] = "deny"
                provider["zdr"] = True
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

        write_if_changed(runtime_dir / "opencode.json", json.dumps(opencode, indent=2, ensure_ascii=False) + "\n")
        write_if_changed(runtime_dir / "oh-my-openagent.json", json.dumps(omo, indent=2, ensure_ascii=False) + "\n")
        self._maybe_render_interrupt("runtime-config")

        agent_overrides = {
            "codex-router.md": selected["agents"]["codex-router"]["model"],
            "content-aware-research.md": selected["agents"]["content-aware-research"]["model"],
        }
        # Each generation is self-contained.  In particular, it never points
        # back into the checkout for mutable configuration inputs.
        for entry in ("agents", "profiles", "prompts", "skills", "teams", "AGENTS.md", "tui.json", "projects.json", "bunfig.toml"):
            source = self.repo / entry
            if source.exists():
                self._copy_entry(source, runtime_dir / entry)

        for filename, model in agent_overrides.items():
            source = self.repo / "agents" / filename
            target = runtime_dir / "agents" / filename
            write_if_changed(target, update_frontmatter_model(source.read_text(encoding="utf-8"), model, source))

        for relative in ("agents/codex-router.md", "prompts/categories/content-aware-deep.md"):
            target = runtime_dir / relative
            write_if_changed(target, render_pentest_prompt_overlay(target.read_text(encoding="utf-8"), profile, Path(relative)))

        content_aware_source = self.repo / "profiles/content-aware.json"
        content_aware = load_json(content_aware_source)
        content_aware["model"] = selected["agents"]["content-aware-research"]["model"]
        content_aware["small_model"] = small_model
        write_if_changed(runtime_dir / "profiles/content-aware.json", json.dumps(content_aware, indent=2, ensure_ascii=False) + "\n")

        prompt_source = self.repo / "prompts/agents/sisyphus.md"
        prompt_runtime = runtime_dir / "prompts/agents/sisyphus.md"
        write_if_changed(prompt_runtime, update_sisyphus_prompt(prompt_source.read_text(encoding="utf-8"), profile))
        omo["agents"]["sisyphus"]["prompt_append"] = SISYPHUS_PROMPT_URI
        # Rewrite after the generated prompt path is known.
        write_if_changed(runtime_dir / "oh-my-openagent.json", json.dumps(omo, indent=2, ensure_ascii=False) + "\n")

        metadata = {
            "schema_version": 2,
            "profile": profile,
            "source": str(self.profile_path),
            "source_root": str(self.repo),
            "fingerprint": fingerprint,
            "generation": None,
        }
        metadata["generation"] = generation.name
        write_if_changed(runtime_dir / ".runtime-profile.json", json.dumps(metadata, indent=2) + "\n")
        self._write_runtime_manifest(runtime_dir)
        self._validate_runtime_generation(runtime_dir, profile, fingerprint)
        self._maybe_render_interrupt("runtime-validated")
        generation.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.replace(runtime_dir, generation)
        return generation

    @staticmethod
    def _maybe_render_interrupt(phase: str) -> None:
        if os.environ.get("OC_RUNTIME_FAIL_RENDER_PHASE") == phase:
            raise SystemExit(f"injected generation render interruption after {phase}")

    @staticmethod
    def _validate_runtime_generation(runtime_dir: Path, profile: str, fingerprint: str) -> None:
        metadata = load_json(runtime_dir / ".runtime-profile.json")
        if metadata.get("profile") != profile or metadata.get("fingerprint") != fingerprint:
            raise SystemExit("invalid staged runtime generation metadata")
        for required in ("opencode.json", "oh-my-openagent.json", "agents", "profiles", "prompts"):
            if not (runtime_dir / required).exists():
                raise SystemExit(f"incomplete staged runtime generation: {required}")
        omo = load_json(runtime_dir / "oh-my-openagent.json")
        if ((omo.get("agents") or {}).get("sisyphus") or {}).get("prompt_append") != SISYPHUS_PROMPT_URI:
            raise SystemExit("runtime Sisyphus prompt must use the allowed stable config-home alias")
        RuntimeProfiles._validate_runtime_manifest(runtime_dir)

    def native_document(self, mirrored: dict) -> str:
        """Build a startup-migrated native OmO envelope without legacy routes."""
        prefix = "// OMO configuration\n"
        native: dict = {}
        if self.native_omo_path.is_file():
            native_text = self.native_omo_path.read_text(encoding="utf-8")
            native = parse_jsonc(native_text)
            object_start = native_text.find("{")
            prefix = native_text[:object_start] if object_start >= 0 else prefix
        markers = native.get("_migrations", [])
        if not isinstance(markers, list) or not all(isinstance(marker, str) for marker in markers):
            raise SystemExit("native OmO _migrations must be an array of strings")
        native["_migrations"] = [
            *markers,
            *(marker for marker in NATIVE_OMO_MIGRATIONS if marker not in markers),
        ]
        native["[opencode]"] = migrate_native_opencode(mirrored)
        return prefix + json.dumps(native, indent=2, ensure_ascii=False) + "\n"

    def compat_path(self, profile: str, runtime_dir: Path | None = None) -> Path:
        """Render a writable, profile-specific config-home compatibility view.

        OpenCode resolves config files relative to its config home.  The view
        therefore exposes the rendered profile for data files and tiny wrapper
        entrypoints for repository scripts, so `$0`/BASH_SOURCE never mistakes
        the generated directory for the authoritative checkout.
        """
        if runtime_dir is None:
            reusable = self.reusable_compat(profile)
            if reusable is not None:
                return reusable
            runtime_dir = self.render(profile)
        else:
            reusable = self.reusable_compat(profile)
            if reusable is not None and (reusable / ".runtime").resolve(strict=True) == runtime_dir.resolve(strict=True):
                return reusable
        compat_root = self.compat_root / "generations"
        compat_dir = compat_root / ".staging" / f"{profile}-{uuid.uuid4().hex}"
        compat_dir.mkdir(parents=True, exist_ok=False, mode=0o700)

        for entry in RUNTIME_RENDER_INPUTS:
            source = runtime_dir / entry
            if source.exists() or source.is_symlink():
                self._copy_entry(source.resolve(), compat_dir / entry)
        replace_symlink(compat_dir / "lib", (self.repo / "lib").resolve())

        # Keep secrets owned by the source checkout but reachable at the legacy
        # config-home location.  The file is never copied or rewritten here.
        env_source = self.repo / ".env"
        if env_source.exists():
            replace_symlink(compat_dir / ".env", env_source.resolve())
        replace_symlink(compat_dir / ".openconfig-source", self.repo)
        replace_symlink(compat_dir / ".runtime", runtime_dir)
        write_if_changed(compat_dir / ".active-profile", profile + "\n")
        compat_metadata = load_json(runtime_dir / ".runtime-profile.json")
        compat_metadata["xdg_identity"] = self.xdg_identity()
        compat_metadata["compat_identity"] = self.compat_identity()
        write_if_changed(compat_dir / ".runtime-profile.json", json.dumps(compat_metadata, indent=2) + "\n")
        # Future native aliases must see a complete OmO config envelope, not a
        # flat plugin object. Root keys outside [opencode] stay intact.
        mirrored = load_json(runtime_dir / "oh-my-openagent.json")
        write_if_changed(compat_dir / ".omo.jsonc", self.native_document(mirrored))

        # Sourcing this through ~/.config/opencode remains supported.  The
        # snippet resolves operational commands through compatibility wrappers.
        replace_symlink(compat_dir / "zshrc.snippet", (self.repo / "zshrc.snippet").resolve())
        for name in ("oc", "opencode.sh", "run.sh", "openrouter-admin.sh"):
            target = self.repo / name
            if not target.is_file():
                raise SystemExit(f"missing OpenConfig wrapper target: {target}")
            wrapper = "#!/usr/bin/env bash\nexec " + shlex.quote(str(target)) + " \"$@\"\n"
            write_if_changed(compat_dir / name, wrapper, mode=0o700)
        # Preserve the historical isolated-XDG contract: sibling application
        # config remains reachable, while this generation owns `opencode`.
        source_override = os.environ.get("OC_SOURCE_XDG_CONFIG_HOME")
        source_xdg = Path(source_override).expanduser().resolve() if source_override else (Path.home() / ".config").resolve()
        xdg_root = compat_dir / "xdg"
        xdg_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source_xdg.is_dir():
            for source in source_xdg.iterdir():
                if source.name != "opencode":
                    replace_symlink(xdg_root / source.name, source.resolve())
        # This relative link survives staging -> generation publication without
        # a second mutable profile lookup.
        xdg_opencode = xdg_root / "opencode"
        xdg_opencode.symlink_to("..")
        self._write_managed_manifest(compat_dir)
        self._validate_compat_generation(compat_dir, runtime_dir, profile)
        self._maybe_render_interrupt("compat-validated")
        generation = compat_root / f"{profile}-{uuid.uuid4().hex[:16]}"
        generation.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.replace(compat_dir, generation)
        return generation

    def _validate_compat_generation(self, compat_dir: Path, runtime_dir: Path, profile: str) -> None:
        metadata = load_json(compat_dir / ".runtime-profile.json")
        if metadata.get("profile") != profile or (compat_dir / ".runtime").resolve(strict=True) != runtime_dir.resolve(strict=True):
            raise SystemExit("invalid staged compatibility generation")
        for required in ("opencode.json", "oh-my-openagent.json", ".omo.jsonc", ".openconfig-source", "oc", "xdg/opencode"):
            if not (compat_dir / required).exists():
                raise SystemExit(f"incomplete staged compatibility generation: {required}")
        source_marker = compat_dir / ".openconfig-source"
        if not source_marker.is_symlink() or source_marker.resolve(strict=True) != self.repo:
            raise SystemExit("compatibility generation source marker drift")
        RuntimeProfiles._validate_managed_manifest(compat_dir)

    def sync_native(self, runtime_dir: Path) -> None:
        self.assert_native_migration_safe()
        if self.native_is_commit_alias():
            # compat/current is the only moving profile-selection pointer.
            return
        mirrored = load_json(runtime_dir / "oh-my-openagent.json")
        write_if_changed(self.native_omo_path, self.native_document(mirrored))

    def native_is_commit_alias(self) -> bool:
        """Recognize, but never create, an operator-approved native alias."""
        if not self.native_omo_path.is_symlink():
            return False
        try:
            target = Path(os.readlink(self.native_omo_path))
            if not target.is_absolute():
                target = self.native_omo_path.parent / target
            return target.absolute() == (self.compat_current_link / ".omo.jsonc").absolute()
        except OSError:
            return False

    def ensure_commit_aliases(self) -> None:
        """Keep historical runtime/state API paths behind compat/current."""
        replace_symlink(self.current_link, self.compat_current_link / ".runtime")
        replace_symlink(self.active_path, self.compat_current_link / ".active-profile")

    def commit_generation(self, previous: str, profile: str, runtime_dir: Path, compat_dir: Path, *, sync_native: bool) -> Path:
        """Publish one fully validated compatibility generation atomically.

        The only selection write is `compat/current`; runtime/current and
        active-profile are permanent aliases below it.  A crashed stage leaves
        the old generation selected.  Once a publish is attempted the applied
        marker is removed, so a live proof can never describe an older bundle.
        """
        self._validate_runtime_generation(runtime_dir, profile, self.runtime_fingerprint(runtime_dir))
        self._validate_compat_generation(compat_dir, runtime_dir, profile)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.runtime_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.compat_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._write_transaction(previous, profile, compat_dir, sync_native=sync_native)
        self.ensure_commit_aliases()
        self.invalidate_applied()
        self._maybe_interrupt("runtime")
        replace_symlink(self.compat_current_link, compat_dir)
        self._maybe_interrupt("compat")
        self._maybe_interrupt("active")
        if sync_native:
            self.sync_native(runtime_dir)
        self._maybe_interrupt("native")
        self._clear_transaction()
        return compat_dir

    def activate(self, profile: str, explicit_switch: bool = False) -> Path:
        previous = self.active()
        existing = self.current_compat(profile)
        if existing is not None:
            if explicit_switch:
                # Explicitly reapplying the selected profile requires a fresh
                # live proof, but does not manufacture an identical bundle.
                self.invalidate_applied()
            return existing
        runtime_dir = self.render(profile)
        compat_dir = self.compat_path(profile, runtime_dir)
        return self.commit_generation(previous, profile, runtime_dir, compat_dir, sync_native=True)

    @staticmethod
    def _maybe_interrupt(phase: str) -> None:
        # Deterministic crash-recovery fixture.  It is deliberately inert in
        # normal operation and leaves the durable journal for the next reader.
        if os.environ.get("OC_RUNTIME_FAIL_AFTER_PHASE") == phase:
            raise SystemExit(f"injected runtime-profile interruption after {phase}")

    def xdg_path(self, profile: str, compat_dir: Path | None = None) -> Path:
        compat_dir = compat_dir or self.current_compat(profile) or self.compat_path(profile)
        self._validate_compat_generation(compat_dir, (compat_dir / ".runtime").resolve(strict=True), profile)
        return compat_dir / "xdg"

    def environment(self, profile: str) -> dict:
        # Activate first: callers must not accidentally read a stale `current`
        # link while another profile switch is in progress.
        compat_dir = self.activate(profile)
        xdg_dir = self.xdg_path(profile, compat_dir)
        return {
            "profile": profile,
            "configDir": str(compat_dir),
            "xdgConfigHome": str(xdg_dir),
        }

    def prepare_native_alias(self) -> Path:
        """Render/commit compat state without ever writing native OmO bytes."""
        profile = self.active()
        current = self.current_compat(profile)
        if current is not None:
            return current
        runtime_dir = self.render(profile)
        compat_dir = self.compat_path(profile, runtime_dir)
        return self.commit_generation(self.active(), profile, runtime_dir, compat_dir, sync_native=False)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--repo", required=True)
    sub = result.add_subparsers(dest="command", required=True)
    sub.add_parser("show")
    sub.add_parser("applied")
    sub.add_parser("identity")
    sub.add_parser("snapshot")
    mark_applied = sub.add_parser("mark-applied")
    mark_applied.add_argument("profile", choices=VALID_PROFILES)
    mark_applied.add_argument("model")
    activate = sub.add_parser("activate")
    activate.add_argument("profile", choices=VALID_PROFILES)
    ensure = sub.add_parser("ensure")
    ensure.add_argument("--quiet", action="store_true")
    sub.add_parser("prepare-native-alias")
    validate_native = sub.add_parser("validate-native")
    validate_native.add_argument("path")
    validate_native.add_argument("--require-envelope", action="store_true")
    native_digest = sub.add_parser("native-opencode-digest")
    native_digest.add_argument("path")
    native_equivalent = sub.add_parser("native-opencode-equivalent")
    native_equivalent.add_argument("source")
    native_equivalent.add_argument("target")
    native_equivalent.add_argument("profile", choices=VALID_PROFILES)
    path = sub.add_parser("path")
    path.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    compat_path = sub.add_parser("compat-path")
    compat_path.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    xdg_path = sub.add_parser("xdg-path")
    xdg_path.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    env = sub.add_parser("env")
    env.add_argument("profile", nargs="?", choices=VALID_PROFILES)
    env.add_argument("--shell", action="store_true")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("profile", choices=VALID_PROFILES)
    resolve.add_argument("section", choices=VALID_SECTIONS)
    resolve.add_argument("name")
    return result


def main() -> int:
    args = parser().parse_args()
    profiles = RuntimeProfiles(Path(args.repo))
    with profiles.locked():
        profiles.assert_native_migration_safe()
        # Snapshot is intentionally observational. In particular, it must not
        # consume/recover a transaction because that would make a doctor read
        # mutate profile state while constructing an answer.
        if args.command != "snapshot":
            profiles.recover_pending()
        if args.command == "show":
            print(profiles.active())
        elif args.command == "applied":
            payload = profiles.applied()
            print(json.dumps(payload, ensure_ascii=False) if payload else "null")
        elif args.command == "identity":
            print(json.dumps(profiles.applied_identity(), ensure_ascii=False))
        elif args.command == "snapshot":
            print(json.dumps(profiles.snapshot(), ensure_ascii=False))
        elif args.command == "mark-applied":
            profiles.mark_applied(args.profile, args.model)
        elif args.command == "activate":
            profiles.activate(args.profile, explicit_switch=True)
        elif args.command == "ensure":
            selected = profiles.active()
            runtime_dir = profiles.activate(selected)
            if not args.quiet:
                print(runtime_dir)
        elif args.command == "prepare-native-alias":
            print(profiles.prepare_native_alias())
        elif args.command == "validate-native":
            native = parse_jsonc(Path(args.path).read_text(encoding="utf-8"))
            if args.require_envelope and not isinstance(native.get("[opencode]"), dict):
                raise SystemExit(f"native OmO envelope lacks [opencode]: {args.path}")
        elif args.command == "native-opencode-digest":
            print(native_opencode_digest(Path(args.path)))
        elif args.command == "native-opencode-equivalent":
            if not native_opencode_migration_equivalent(Path(args.source), Path(args.target), args.profile):
                raise SystemExit("native [opencode] differs beyond the managed Sisyphus prompt relocation")
        elif args.command == "path":
            # Backward compatibility: integrations (notably Buzz) consume the
            # rendered runtime overlay here. Compatibility homes have their own
            # explicit command and are selected only by `env`.
            if args.profile:
                runtime_dir = profiles.render(args.profile)
            else:
                selected = profiles.active()
                runtime_dir = profiles.render(selected)
            print(runtime_dir)
        elif args.command == "compat-path":
            selected = args.profile or profiles.active()
            print(profiles.compat_path(selected))
        elif args.command == "xdg-path":
            selected = args.profile or profiles.active()
            print(profiles.xdg_path(selected))
        elif args.command == "resolve":
            print(json.dumps(profiles.resolve(args.profile, args.section, args.name), ensure_ascii=False))
        elif args.command == "env":
            selected = args.profile or profiles.active()
            environment = profiles.environment(selected)
            if args.shell:
                print("\n".join(
                    f"export {name}={shlex.quote(value)}"
                    for name, value in (
                        ("OPENCODE_CONFIG_DIR", environment["configDir"]),
                        ("XDG_CONFIG_HOME", environment["xdgConfigHome"]),
                        ("OPENCONFIG_RUNTIME_PROFILE", environment["profile"]),
                    )
                ))
            else:
                print(json.dumps(environment, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
