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
prompt_path = repo / "prompts/agents/sisyphus.md"
profile_path = repo / "runtime-profile.json"

omo = json.loads(omo_path.read_text(encoding="utf-8"))
categories = omo.setdefault("categories", {})

normal = {
    "content-aware-fast": {
        "model": "openrouter/deepseek/deepseek-v4-flash-0731",
        "fallback_models": [
            "openrouter/minimax/minimax-m3",
            "openrouter/z-ai/glm-5.2-exacto",
            "subscription-gateway/gpt-5.6-terra",
        ],
    },
    "content-aware-deep": {
        "model": "openrouter/deepseek/deepseek-v4-flash-0731",
        "fallback_models": [
            "openrouter/moonshotai/kimi-k3",
            "openrouter/z-ai/glm-5.2-exacto",
            "subscription-gateway/gpt-5.6-sol-review",
        ],
    },
}
pentest = {
    "content-aware-fast": {
        "model": "openrouter/z-ai/glm-5.2-exacto",
        "fallback_models": [
            "openrouter/deepseek/deepseek-v4-flash-0731",
        ],
    },
    "content-aware-deep": {
        "model": "openrouter/z-ai/glm-5.2-exacto",
        "fallback_models": [
            "openrouter/deepseek/deepseek-v4-flash-0731",
        ],
    },
}
selected = pentest if mode == "pentest" else normal
for name, patch in selected.items():
    if name not in categories:
        raise SystemExit(f"missing category: {name}")
    categories[name]["model"] = patch["model"]
    categories[name]["fallback_models"] = patch["fallback_models"]

omo_path.write_text(json.dumps(omo, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

prompt = prompt_path.read_text(encoding="utf-8")
normal_line = "- Runtime profile `normal`: security/pentest work should still prefer `content-aware-*`, but `ultrawork` remains available for non-security hard reasoning."
pentest_line = "- Runtime profile `pentest`: authorized pentest/security briefs must not use `ultrawork`, `ulw`, `unspecified-high`, Claude/Opus, or generic stronger-reasoning escalation. If filters bite, reroute unfinished work to `content-aware-fast`, `content-aware-deep`, or `content-aware-research`."
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
    "schema_version": 1,
    "active": mode,
    "normal": normal,
    "pentest": pentest,
}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

"$REPO/signature.sh" --refresh >/dev/null
echo "OpenConfig runtime profile: $MODE"
echo "Reload OpenCode/bridge for running sessions to pick up the change."
