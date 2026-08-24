#!/usr/bin/env bash
# Switch and resolve immutable OpenConfig runtime profiles.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODE="${1:-show}"
PYTHON_TOOL="$REPO/scripts/runtime-profile.py"

usage() {
  cat >&2 <<'EOF'
Usage:
  oc profile show
  oc profile normal|pentest
  oc profile path [normal|pentest]
  oc profile xdg-path [normal|pentest]
  oc profile resolve <normal|pentest> <agents|categories> <name>
  oc profile ensure [--quiet]
EOF
  exit 2
}

case "$MODE" in
  show)
    exec python3 "$PYTHON_TOOL" --repo "$REPO" show
    ;;
  path|xdg-path)
    shift
    [[ $# -le 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" "$MODE" "$@"
    ;;
  resolve)
    shift
    [[ $# -eq 3 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" resolve "$@"
    ;;
  ensure)
    shift
    [[ $# -le 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" ensure "$@"
    ;;
  normal|pentest)
    [[ $# -eq 1 ]] || usage
    ;;
  *)
    usage
    ;;
esac

python3 "$PYTHON_TOOL" --repo "$REPO" activate "$MODE"
echo "OpenConfig runtime profile: $MODE"

# A profile switch affects only future OpenCode sessions. Restart the bridge so
# Codex immediately receives the newly rendered runtime overlay.
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
    expected_model="$(python3 "$PYTHON_TOOL" --repo "$REPO" resolve "$MODE" agents codex-router \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"].split("/", 1)[1])')"
    for _ in $(seq 1 80); do
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
      echo "⚠️ Profile switched to $MODE and the bridge restart was requested, but health did not recover within 20s. Check 'oc doctor'." >&2
      exit 1
    fi
  else
    echo "⚠️ Profile switched to $MODE, but the bridge restart failed. Run 'oc launch' to load the new profile." >&2
  fi
else
  echo "✅ Profile switched to $MODE — run 'oc launch' to start OpenCode with the new profile."
fi
