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
opencode_path = repo / "opencode.json"
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
opencode = json.loads(opencode_path.read_text(encoding="utf-8"))
agents = omo.setdefault("agents", {})
categories = omo.setdefault("categories", {})

if not profile_path.is_file():
    raise SystemExit(f"missing runtime profile source: {profile_path}")
profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
normal = profile_data.get("normal")
pentest = profile_data.get("pentest")
if not isinstance(normal, dict) or not isinstance(pentest, dict):
    raise SystemExit(f"invalid runtime profile source: {profile_path}")
for profile_name, profile in (("normal", normal), ("pentest", pentest)):
    for section_name in ("agents", "categories"):
        if not isinstance(profile.get(section_name), dict):
            raise SystemExit(f"invalid {profile_name}.{section_name} in {profile_path}")

selected = {"normal": normal, "pentest": pentest}[mode]
small_model = selected.get("small_model") or selected["categories"].get("quick", {}).get("model") or selected["agents"]["codex-router"]["model"]
helper_model = selected.get("helper_model") or small_model

opencode["model"] = selected["agents"]["codex-router"]["model"]
opencode["small_model"] = small_model
for helper_name in ("title", "summary", "compaction"):
    helper = opencode.setdefault("agent", {}).setdefault(helper_name, {})
    if isinstance(helper, dict):
        helper["model"] = helper_model
opencode_path.write_text(json.dumps(opencode, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

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
    mirrored_config = json.loads(json.dumps(omo))
    if "[opencode]" in native_omo:
        native_omo["[opencode]"] = mirrored_config
    else:
        native_omo = mirrored_config
    object_start = native_text.find("{")
    prefix = native_text[:object_start] if object_start >= 0 else ""
    updated_native_text = prefix + json.dumps(native_omo, indent=2, ensure_ascii=False) + "\n"
    if updated_native_text != native_text:
        native_omo_path.write_text(updated_native_text, encoding="utf-8")

prompt = prompt_path.read_text(encoding="utf-8")
normal_line = "- Runtime profile `normal`: security/pentest work should still prefer `content-aware-*`, but normal model breadth remains available for non-security work."
pentest_line = "- Runtime profile `pentest`: keep all agents/categories available, but pentest-safe routes use only GLM 5.3 and DeepSeek V4 Flash. Do not use Gemini, Claude/Opus, Kimi, Minimax, subscription-gateway, `ultrawork`, `ulw`, or generic stronger-reasoning escalation inside pentest work. If filters bite, reroute unfinished work to `content-aware-fast`, `content-aware-deep`, or `content-aware-research`."
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

profile_output = dict(profile_data)
profile_output["schema_version"] = 2
profile_output["active"] = mode
profile_output["normal"] = normal
profile_output["pentest"] = pentest
profile_path.write_text(json.dumps(profile_output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

"$REPO/signature.sh" --refresh >/dev/null
echo "OpenConfig runtime profile: $MODE"
if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *"opencode serve"* && "$command_line" == *"--port 4097"* ]]; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        if ! kill -0 "$pid" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  done < <(lsof -tiTCP:4097 -sTCP:LISTEN 2>/dev/null || true)
fi
bridge_label="com.arnaud.opencode-codex-bridge"
bridge_domain="gui/$(id -u)"
bridge_target="$bridge_domain/$bridge_label"
bridge_plist="$HOME/Library/LaunchAgents/$bridge_label.plist"
if launchctl print "$bridge_target" >/dev/null 2>&1 || launchctl list | grep -q "$bridge_label" || [[ -f "$bridge_plist" ]]; then
  if ! launchctl print "$bridge_target" >/dev/null 2>&1 && [[ -f "$bridge_plist" ]]; then
    launchctl bootstrap "$bridge_domain" "$bridge_plist" 2>/dev/null || true
  fi
  if launchctl kickstart -k "$bridge_target" 2>/dev/null; then
    ready=0
    password_file="${OPENCODE_SERVER_PASSWORD_FILE:-${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.local/state/opencode-codex-bridge}/opencode-server-password}"
    oc_curl() {
      if [[ -s "$password_file" ]]; then
        curl -fsS -u "opencode:$(tr -d '\r\n' < "$password_file")" "$@"
      else
        curl -fsS "$@"
      fi
    }
    expected_model="$(python3 - "$PROFILE_FILE" "$MODE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(data[sys.argv[2]]["agents"]["codex-router"]["model"].split("/", 1)[1])
PY
)"
    for _ in $(seq 1 40); do
      if curl -fsS http://127.0.0.1:10101/healthz >/dev/null 2>&1 \
        && oc_curl http://127.0.0.1:4097/global/health >/dev/null 2>&1 \
        && oc_curl http://127.0.0.1:4097/agent 2>/dev/null | python3 -c 'import json, sys
expected = sys.argv[1]
try:
    agents = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
for agent in agents if isinstance(agents, list) else []:
    if agent.get("name") == "codex-router":
        model = agent.get("model")
        if isinstance(model, dict):
            raise SystemExit(0 if model.get("modelID") == expected else 1)
        raise SystemExit(0 if agent.get("modelID") == expected else 1)
raise SystemExit(1)' "$expected_model"
      then
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
