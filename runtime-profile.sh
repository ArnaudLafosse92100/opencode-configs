#!/usr/bin/env bash
# Switch runtime routing between normal and pentest modes.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODE="${1:-show}"
PROFILE_FILE="$REPO/runtime-profile.json"

case "$MODE" in
  show|normal|pentest) ;;
  *)
    echo "Usage: oc profile [show|normal|pentest]" >&2
    exit 2
    ;;
esac

if [[ "$MODE" == "show" ]]; then
  if [[ -f "$PROFILE_FILE" ]]; then
    python3 - "$PROFILE_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(data.get("active", "normal"))
PY
  else
    echo "normal"
  fi
  exit 0
fi

python3 - "$REPO" "$MODE" <<'PY'
import json
import pathlib
import sys

repo = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
omo_path = repo / "oh-my-openagent.json"
codex_router_path = repo / "agents/codex-router.md"
prompt_path = repo / "prompts/agents/sisyphus.md"
profile_path = repo / "runtime-profile.json"
native_omo_path = pathlib.Path.home() / ".omo/omo.jsonc"


def parse_jsonc(text):
    """Parse JSONC without altering comment-like text inside JSON strings."""
    without_comments = []
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
            while index + 1 < len(text) and text[index:index + 2] != "*/":
                if text[index] in "\r\n":
                    without_comments.append(text[index])
                index += 1
            if index + 1 >= len(text):
                raise SystemExit(f"unterminated block comment in {native_omo_path}")
            index += 2
            continue
        without_comments.append(char)
        index += 1

    clean = "".join(without_comments)
    without_trailing_commas = []
    in_string = False
    escaped = False
    for index, char in enumerate(clean):
        if in_string:
            without_trailing_commas.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            without_trailing_commas.append(char)
            continue
        if char == ",":
            lookahead = index + 1
            while lookahead < len(clean) and clean[lookahead].isspace():
                lookahead += 1
            if lookahead < len(clean) and clean[lookahead] in "}]":
                continue
        without_trailing_commas.append(char)
    return json.loads("".join(without_trailing_commas))

omo = json.loads(omo_path.read_text(encoding="utf-8"))
agents = omo.setdefault("agents", {})
categories = omo.setdefault("categories", {})

glm = "openrouter/z-ai/glm-5.2-exacto"
deepseek = "openrouter/deepseek/deepseek-v4-flash-0731"

normal = {
    "agents": {
        "codex-router": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", deepseek, "openrouter/minimax/minimax-m3"]},
        "sisyphus": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", deepseek, "openrouter/minimax/minimax-m3", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8", "openrouter/anthropic/claude-opus-5", "openrouter/anthropic/claude-fable-5"]},
        "hephaestus": {"model": "subscription-gateway/gpt-5.6-terra", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "subscription-gateway/gpt-5.6-sol", "openrouter/moonshotai/kimi-k3", glm]},
        "prometheus": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", deepseek, "openrouter/minimax/minimax-m3", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8"]},
        "atlas": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", deepseek, "openrouter/minimax/minimax-m3", "openrouter/anthropic/claude-sonnet-5"]},
        "oracle": {"model": "subscription-gateway/gpt-5.6-sol", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/anthropic/claude-sonnet-5", glm]},
        "librarian": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/minimax/minimax-m3", glm]},
        "explore": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/minimax/minimax-m3", glm]},
        "multimodal-looker": {"model": "openrouter/anthropic/claude-sonnet-5", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "openrouter/google/gemini-3.6-flash", "openrouter/google/gemini-3.5-flash", "openrouter/moonshotai/kimi-k3"]},
        "metis": {"model": "openrouter/anthropic/claude-sonnet-5", "fallback_models": ["subscription-gateway/gpt-5.6-sol", "openrouter/moonshotai/kimi-k3", glm]},
        "momus": {"model": "subscription-gateway/gpt-5.6-sol-review", "fallback_models": ["subscription-gateway/gpt-5.6-sol", "subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/anthropic/claude-opus-5", "openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8", "openrouter/anthropic/claude-opus-4.7"]},
        "sisyphus-junior": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/minimax/minimax-m3", glm]},
        "content-aware-research": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "openrouter/moonshotai/kimi-k3", glm, "openrouter/minimax/minimax-m3"]},
    },
    "categories": {
        "visual-engineering": {"model": "openrouter/google/gemini-3.1-pro-preview", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "openrouter/google/gemini-3.6-flash", "openrouter/google/gemini-3.5-flash", "openrouter/anthropic/claude-sonnet-5", glm]},
        "ultrabrain": {"model": "subscription-gateway/gpt-5.6-sol", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "subscription-gateway/gpt-5.6-terra", "openrouter/anthropic/claude-opus-5", "openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8", "openrouter/anthropic/claude-opus-4.7", "openrouter/moonshotai/kimi-k3"]},
        "deep": {"model": "subscription-gateway/gpt-5.6-sol", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", glm]},
        "agentic-deep-kimi": {"model": "openrouter/moonshotai/kimi-k3", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", glm, deepseek]},
        "artistry": {"model": "openrouter/google/gemini-3.1-pro-preview", "fallback_models": ["subscription-gateway/gpt-5.6-sol-review", "openrouter/google/gemini-3.6-flash", "openrouter/google/gemini-3.5-flash", "openrouter/anthropic/claude-sonnet-5"]},
        "quick": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/minimax/minimax-m3", glm]},
        "unspecified-low": {"model": deepseek, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/minimax/minimax-m3", glm]},
        "unspecified-high": {"model": "openrouter/anthropic/claude-opus-5", "fallback_models": ["subscription-gateway/gpt-5.6-sol", "openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8", "openrouter/anthropic/claude-opus-4.7", glm]},
        "writing": {"model": "openrouter/google/gemini-3.6-flash", "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/google/gemini-3.5-flash", "openrouter/google/gemini-3-flash-preview", deepseek]},
        "bug-hunt": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-sol", "openrouter/moonshotai/kimi-k3", "openrouter/minimax/minimax-m3"]},
        "refactor-safe": {"model": glm, "fallback_models": ["subscription-gateway/gpt-5.6-terra", "openrouter/moonshotai/kimi-k3", "openrouter/minimax/minimax-m3"]},
        "arch-review": {"model": "subscription-gateway/gpt-5.6-sol-review", "fallback_models": ["subscription-gateway/gpt-5.6-sol", "subscription-gateway/gpt-5.6-terra", "openrouter/anthropic/claude-opus-4.8-fast", "openrouter/anthropic/claude-opus-4.8", "openrouter/anthropic/claude-opus-4.7", "openrouter/moonshotai/kimi-k3"]},
        "content-aware-fast": {"model": deepseek, "fallback_models": ["openrouter/minimax/minimax-m3", glm, "subscription-gateway/gpt-5.6-terra"]},
        "content-aware-deep": {"model": deepseek, "fallback_models": ["openrouter/moonshotai/kimi-k3", glm, "subscription-gateway/gpt-5.6-sol-review"]},
    },
}

pentest = {
    "agents": {
        "codex-router": {"model": deepseek, "fallback_models": [glm]},
        "sisyphus": {"model": deepseek, "fallback_models": [glm]},
        "hephaestus": {"model": deepseek, "fallback_models": [glm]},
        "prometheus": {"model": deepseek, "fallback_models": [glm]},
        "atlas": {"model": deepseek, "fallback_models": [glm]},
        "oracle": {"model": deepseek, "fallback_models": [glm]},
        "librarian": {"model": deepseek, "fallback_models": [glm]},
        "explore": {"model": deepseek, "fallback_models": [glm]},
        "multimodal-looker": {"model": deepseek, "fallback_models": [glm]},
        "metis": {"model": deepseek, "fallback_models": [glm]},
        "momus": {"model": deepseek, "fallback_models": [glm]},
        "sisyphus-junior": {"model": deepseek, "fallback_models": [glm]},
        "content-aware-research": {"model": deepseek, "fallback_models": [glm]},
    },
    "categories": {
        "visual-engineering": {"model": deepseek, "fallback_models": [glm]},
        "ultrabrain": {"model": glm, "fallback_models": [deepseek]},
        "deep": {"model": deepseek, "fallback_models": [glm]},
        "agentic-deep-kimi": {"model": deepseek, "fallback_models": [glm]},
        "artistry": {"model": deepseek, "fallback_models": [glm]},
        "quick": {"model": deepseek, "fallback_models": [glm]},
        "unspecified-low": {"model": deepseek, "fallback_models": [glm]},
        "unspecified-high": {"model": deepseek, "fallback_models": [glm]},
        "writing": {"model": deepseek, "fallback_models": [glm]},
        "bug-hunt": {"model": deepseek, "fallback_models": [glm]},
        "refactor-safe": {"model": deepseek, "fallback_models": [glm]},
        "arch-review": {"model": deepseek, "fallback_models": [glm]},
        "content-aware-fast": {"model": deepseek, "fallback_models": [glm]},
        "content-aware-deep": {"model": deepseek, "fallback_models": [glm]},
    },
}

selected = pentest if mode == "pentest" else normal
for section_name, target in (("agents", agents), ("categories", categories)):
    for name, patch in selected[section_name].items():
        if name not in target:
            raise SystemExit(f"missing {section_name[:-1]}: {name}")
        target[name]["model"] = patch["model"]
        target[name]["fallback_models"] = patch["fallback_models"]

omo_path.write_text(json.dumps(omo, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# codex-router is an OpenCode-native custom agent, so its runtime model comes
# from YAML frontmatter, not OmO's agent table.
codex_router_text = codex_router_path.read_text(encoding="utf-8")
codex_router_model = selected["agents"]["codex-router"]["model"]
updated_codex_router_text = []
replaced_codex_router_model = False
in_frontmatter = False
for index, line in enumerate(codex_router_text.splitlines()):
    if index == 0 and line == "---":
        in_frontmatter = True
        updated_codex_router_text.append(line)
        continue
    if in_frontmatter and line == "---":
        in_frontmatter = False
        updated_codex_router_text.append(line)
        continue
    if in_frontmatter and line.startswith("model: "):
        updated_codex_router_text.append(f"model: {codex_router_model}")
        replaced_codex_router_model = True
        continue
    updated_codex_router_text.append(line)
if not replaced_codex_router_model:
    raise SystemExit(f"missing model frontmatter in {codex_router_path}")
codex_router_path.write_text("\n".join(updated_codex_router_text).rstrip() + "\n", encoding="utf-8")

# OmO loads this native config at runtime, so legacy profile routing must be mirrored there.
if native_omo_path.is_file():
    native_text = native_omo_path.read_text(encoding="utf-8")
    native_omo = parse_jsonc(native_text)
    if not isinstance(native_omo, dict):
        raise SystemExit(f"invalid native OmO config root: {native_omo_path}")
    native_config = native_omo.get("[opencode]", native_omo)
    if not isinstance(native_config, dict):
        raise SystemExit(f"invalid [opencode] wrapper: {native_omo_path}")
    for section_name in ("agents", "categories"):
        native_section = native_config.setdefault(section_name, {})
        if not isinstance(native_section, dict):
            raise SystemExit(f"invalid {section_name} section: {native_omo_path}")
        for name, patch in selected[section_name].items():
            native_entry = native_section.setdefault(name, {})
            if not isinstance(native_entry, dict):
                raise SystemExit(f"invalid {section_name[:-1]} entry {name}: {native_omo_path}")
            native_entry["model"] = patch["model"]
            native_entry["fallback_models"] = patch["fallback_models"]
    object_start = native_text.find("{")
    prefix = native_text[:object_start] if object_start >= 0 else ""
    updated_native_text = prefix + json.dumps(native_omo, indent=2, ensure_ascii=False) + "\n"
    if updated_native_text != native_text:
        native_omo_path.write_text(updated_native_text, encoding="utf-8")

prompt = prompt_path.read_text(encoding="utf-8")
normal_line = "- Runtime profile `normal`: security/pentest work should still prefer `content-aware-*`, but normal model breadth remains available for non-security work."
pentest_line = "- Runtime profile `pentest`: keep all agents/categories available, but pentest-safe routes use only GLM 5.2 Exacto and DeepSeek V4 Flash. Do not use Gemini, Claude/Opus, Kimi, Minimax, subscription-gateway, `ultrawork`, `ulw`, or generic stronger-reasoning escalation inside pentest work. If filters bite, reroute unfinished work to `content-aware-fast`, `content-aware-deep`, or `content-aware-research`."
lines = [line for line in prompt.splitlines() if not line.startswith("- Runtime profile `normal`:") and not line.startswith("- Runtime profile `pentest`:") and not line.startswith("- Authorized pentest/security briefs must not use `ultrawork`")]
needle = "- Direct implementation bursts → Hephaestus. Use `deep` / `ultrabrain` only when stronger reasoning is required."
insert = pentest_line if mode == "pentest" else normal_line
for index, line in enumerate(lines):
    if line == needle:
        lines.insert(index + 1, insert)
        break
else:
    lines.append(insert)
prompt_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

profile_path.write_text(json.dumps({
    "schema_version": 2,
    "active": mode,
    "normal": normal,
    "pentest": pentest,
}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

"$REPO/signature.sh" --refresh >/dev/null
echo "OpenConfig runtime profile: $MODE"
if launchctl list | grep -q "com.arnaud.opencode-codex-bridge"; then
  if launchctl kickstart -k "gui/$(id -u)/com.arnaud.opencode-codex-bridge" 2>/dev/null; then
    ready=0
    for _ in $(seq 1 40); do
      if curl -fsS http://127.0.0.1:10101/healthz >/dev/null 2>&1 \
        && curl -fsS http://127.0.0.1:4097/global/health >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.25
    done
    if [[ $ready -eq 1 ]]; then
      echo "✅ Profile switched to $MODE — bridge restarted, new routing is live."
    else
      echo "⚠️ Profile switched to $MODE and the bridge restart was requested, but health did not recover within 10s. Check 'oc doctor'." >&2
      exit 1
    fi
  else
    echo "⚠️ Profile switched to $MODE, but the bridge restart failed. Run 'oc launch' to load the new profile." >&2
  fi
else
  echo "✅ Profile switched to $MODE — run 'oc launch' to start OpenCode with the new profile."
fi
