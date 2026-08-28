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
  oc profile applied
  oc profile identity
  oc profile snapshot
  oc profile normal|normal-private|pentest
  oc profile path [normal|normal-private|pentest]
  oc profile compat-path [normal|normal-private|pentest]
  oc profile xdg-path [normal|normal-private|pentest]
  oc profile env [normal|normal-private|pentest] [--shell]
  oc profile resolve <normal|normal-private|pentest> <agents|categories> <name>
  oc profile ensure [--quiet]
  oc profile prepare-native-alias
EOF
  exit 2
}

case "$MODE" in
  show)
    exec python3 "$PYTHON_TOOL" --repo "$REPO" show
    ;;
  applied)
    [[ $# -eq 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" applied
    ;;
  identity)
    [[ $# -eq 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" identity
    ;;
  snapshot)
    [[ $# -eq 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" snapshot
    ;;
  path|compat-path|xdg-path|env)
    shift
    if [[ "$MODE" == "env" ]]; then
      [[ $# -le 2 ]] || usage
      exec python3 "$PYTHON_TOOL" --repo "$REPO" env "$@"
    fi
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
  prepare-native-alias)
    [[ $# -eq 1 ]] || usage
    exec python3 "$PYTHON_TOOL" --repo "$REPO" prepare-native-alias
    ;;
  normal|normal-private|pentest)
    [[ $# -eq 1 ]] || usage
    ;;
  *)
    usage
    ;;
esac

activation_state_dir="${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.local/state/opencode-codex-bridge}"
activation_lock_dir="${OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR:-$activation_state_dir/activation.lock}"
activation_lock_owner="$activation_lock_dir/owner"
activation_lock_token="${OPENCODE_BRIDGE_ACTIVATION_LOCK_TOKEN:-}"
activation_lock_owned=0

# This is deliberately the same mkdir lock as the bridge installer. Tokens are
# diagnostics/release evidence only; no inherited environment bypasses mkdir.
release_activation_lock() {
  [[ "$activation_lock_owned" -eq 1 ]] || return 0
  local recorded_token=""
  [[ -f "$activation_lock_owner" ]] || return 0
  IFS= read -r recorded_token < "$activation_lock_owner" || return 0
  [[ "$recorded_token" == "$activation_lock_token" ]] || return 0
  rm -f -- "$activation_lock_owner"
  rmdir -- "$activation_lock_dir" 2>/dev/null || true
}

acquire_activation_lock() {
  mkdir -p "$(dirname "$activation_lock_dir")"
  if ! mkdir "$activation_lock_dir" 2>/dev/null; then
    echo "bridge activation already in progress; refusing concurrent launchd mutation" >&2
    return 1
  fi
  activation_lock_token="$$-${RANDOM}-$(date +%s)"
  if ! (umask 077; printf '%s\npid=%s\n' "$activation_lock_token" "$$" > "$activation_lock_owner"); then
    rmdir -- "$activation_lock_dir" 2>/dev/null || true
    echo "could not record bridge activation lock ownership" >&2
    return 1
  fi
  activation_lock_owned=1
  export OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR="$activation_lock_dir"
  export OPENCODE_BRIDGE_ACTIVATION_LOCK_TOKEN="$activation_lock_token"
}

acquire_activation_lock
trap release_activation_lock EXIT

bridge_label="com.arnaud.opencode-codex-bridge"
bridge_domain="gui/$(id -u)"
bridge_target="$bridge_domain/$bridge_label"
bridge_plist="$HOME/Library/LaunchAgents/$bridge_label.plist"
password_file="${OPENCODE_SERVER_PASSWORD_FILE:-${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.local/state/opencode-codex-bridge}/opencode-server-password}"

oc_curl() {
  if [[ -s "$password_file" ]]; then
    curl -fsS -u "opencode:$(tr -d '\r\n' < "$password_file")" "$@"
  else
    curl -fsS "$@"
  fi
}

bridge_active_executions() {
  oc_curl http://127.0.0.1:10101/healthz 2>/dev/null | python3 -c 'import json, sys
body = json.load(sys.stdin)
active = body.get("active_executions")
if (
    body.get("service") != "opencode-codex-bridge"
    or not isinstance(active, int)
    or isinstance(active, bool)
    or active < 0
):
    raise SystemExit(1)
print(active)'
}

# The activation lock fences new bridge dispatches. Refuse before rendering
# any new profile while an existing execution is still active; the operator
# can retry after that run completes without losing its work.
if launchctl print "$bridge_target" >/dev/null 2>&1 || launchctl list | grep -q "$bridge_label" || [[ -f "$bridge_plist" ]]; then
  if ! active_executions="$(bridge_active_executions)"; then
    echo "cannot verify active bridge executions; refusing profile activation before runtime mutation" >&2
    exit 1
  fi
  if (( active_executions > 0 )); then
    echo "bridge has $active_executions active execution(s); refusing restart until they drain" >&2
    exit 3
  fi
fi

python3 "$PYTHON_TOOL" --repo "$REPO" activate "$MODE"
echo "OpenConfig runtime profile: $MODE"

# A profile switch affects only future OpenCode sessions. The bridge owns its
# OpenCode child and drains active Responses handlers on SIGTERM before it
# stops that child. Never kill port 4097 directly here: doing so races the
# drain, strands an already-dispatched execution, and surfaces a
# recovery_required 409 to Codex.

bridge_health_attempts="${OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS:-80}"
[[ "$bridge_health_attempts" =~ ^[1-9][0-9]*$ ]] || { echo "invalid OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS" >&2; exit 2; }

# A successful kickstart is not proof that the responding bridge is the new
# process.  Bind the health response to launchd and the listener before a
# profile is marked applied.  This intentionally fails closed when `lsof` is
# unavailable: desired routing has committed, but no restart proof exists.
bridge_launchd_pid() {
  local launchd_state pid
  launchd_state="$(launchctl print "$bridge_target" 2>/dev/null)" || return 1
  pid="$(printf '%s\n' "$launchd_state" | sed -nE 's/^[[:space:]]*pid = ([0-9]+);?[[:space:]]*$/\1/p' | head -n 1)"
  printf '%s\n' "$launchd_state" | grep -Eq '^[[:space:]]*state[[:space:]]*=[[:space:]]*running;?[[:space:]]*$' \
    && [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

bridge_listener_matches_pid() {
  local expected_pid="$1" listener_pids
  command -v lsof >/dev/null 2>&1 || return 1
  listener_pids="$(lsof -tiTCP:10101 -sTCP:LISTEN 2>/dev/null | awk 'NF { print }')"
  [[ "$listener_pids" == "$expected_pid" ]]
}

# Read the process identity independently from readiness.  curl deliberately
# does not use -f here: the bridge exposes the same exact identity schema in a
# legitimate 503 while its OpenCode upstream is recovering.  A restart must
# still prove that this observed process was replaced.
bridge_observed_instance() {
  local expected_pid payload
  expected_pid="$(bridge_launchd_pid)"
  [[ "$expected_pid" =~ ^[0-9]+$ ]] || return 1
  bridge_listener_matches_pid "$expected_pid" || return 1
  payload="$(curl -sS --max-time 2 http://127.0.0.1:10101/healthz 2>/dev/null)" || return 1
  printf '%s' "$payload" | python3 -c '
import datetime, json, sys, uuid
expected_pid = int(sys.argv[1])
try:
    body = json.load(sys.stdin)
    instance = uuid.UUID(body.get("instance_id", ""))
    started = datetime.datetime.fromisoformat(body.get("started_at", "").replace("Z", "+00:00"))
except Exception:
    raise SystemExit(1)
def valid_gateway_health(value):
    if not isinstance(value, dict) or set(value) != {"catalog_ok", "inference_last_success_at", "breaker_state", "privacy_eligible", "enforcement"}:
        return False
    if value.get("catalog_ok") is not None and type(value.get("catalog_ok")) is not bool:
        return False
    inference = value.get("inference_last_success_at")
    if inference is not None:
        if not isinstance(inference, str):
            return False
        try:
            if datetime.datetime.fromisoformat(inference.replace("Z", "+00:00")).tzinfo is None:
                return False
        except Exception:
            return False
    return value.get("breaker_state") in {"closed", "open", "half-open"} and type(value.get("privacy_eligible")) is bool and value.get("enforcement") == "passive"
def valid_idempotency_ledger(value):
    return (
        isinstance(value, dict)
        and set(value) == {"healthy", "error", "entries", "max_entries", "remaining_capacity"}
        and type(value.get("healthy")) is bool
        and (value.get("error") is None or isinstance(value.get("error"), str))
        and type(value.get("entries")) is int and value.get("entries") >= 0
        and type(value.get("max_entries")) is int and value.get("max_entries") >= 0
        and type(value.get("remaining_capacity")) is int
        and value.get("remaining_capacity") == max(0, value.get("max_entries") - value.get("entries"))
    )
identity_ok = (
    isinstance(body, dict)
    and set(body) == {"schema_version", "service", "launchd_label", "instance_id", "pid", "started_at", "ok", "model", "active_executions", "accepting_executions", "opencode", "error", "gateway_health", "idempotency_ledger"}
    and body.get("schema_version") == 2
    and body.get("service") == "opencode-codex-bridge"
    and body.get("launchd_label") == "com.arnaud.opencode-codex-bridge"
    and instance.version == 4
    and started.tzinfo is not None
    and body.get("pid") == expected_pid
    and body.get("model") == "opencode/router"
    and type(body.get("active_executions")) is int
    and body.get("active_executions") >= 0
    and type(body.get("accepting_executions")) is bool
    and valid_gateway_health(body.get("gateway_health"))
    and valid_idempotency_ledger(body.get("idempotency_ledger"))
)
ready_contract = (
    body.get("ok") is True
    and isinstance(body.get("opencode"), dict)
    and body["opencode"].get("healthy") is True
    and body.get("error") is None
    and body["idempotency_ledger"].get("healthy") is True
)
unready_contract = (
    body.get("ok") is False
    and isinstance(body.get("error"), str)
    and bool(body["error"])
    and (
        body.get("opencode") is None
        or (isinstance(body.get("opencode"), dict) and body["opencode"].get("healthy") is True and body["idempotency_ledger"].get("healthy") is False)
    )
)
if not identity_ok or not (ready_contract or unready_contract):
    raise SystemExit(1)
print(instance)
' "$expected_pid"
}

bridge_valid_instance() {
  local previous_instance="${1:-}" expected_pid payload
  expected_pid="$(bridge_launchd_pid)"
  [[ "$expected_pid" =~ ^[0-9]+$ ]] || return 1
  bridge_listener_matches_pid "$expected_pid" || return 1
  payload="$(curl -fsS --max-time 2 http://127.0.0.1:10101/healthz 2>/dev/null)" || return 1
  printf '%s' "$payload" | python3 -c '
import datetime, json, sys, uuid
expected_pid = int(sys.argv[1])
previous = sys.argv[2]
try:
    body = json.load(sys.stdin)
    instance = uuid.UUID(body.get("instance_id", ""))
    started = datetime.datetime.fromisoformat(body.get("started_at", "").replace("Z", "+00:00"))
except Exception:
    raise SystemExit(1)
def valid_gateway_health(value):
    if not isinstance(value, dict) or set(value) != {"catalog_ok", "inference_last_success_at", "breaker_state", "privacy_eligible", "enforcement"}:
        return False
    if value.get("catalog_ok") is not None and type(value.get("catalog_ok")) is not bool:
        return False
    inference = value.get("inference_last_success_at")
    if inference is not None:
        if not isinstance(inference, str):
            return False
        try:
            if datetime.datetime.fromisoformat(inference.replace("Z", "+00:00")).tzinfo is None:
                return False
        except Exception:
            return False
    return value.get("breaker_state") in {"closed", "open", "half-open"} and type(value.get("privacy_eligible")) is bool and value.get("enforcement") == "passive"
def valid_idempotency_ledger(value):
    return (
        isinstance(value, dict)
        and set(value) == {"healthy", "error", "entries", "max_entries", "remaining_capacity"}
        and type(value.get("healthy")) is bool
        and (value.get("error") is None or isinstance(value.get("error"), str))
        and type(value.get("entries")) is int and value.get("entries") >= 0
        and type(value.get("max_entries")) is int and value.get("max_entries") >= 0
        and type(value.get("remaining_capacity")) is int
        and value.get("remaining_capacity") == max(0, value.get("max_entries") - value.get("entries"))
    )
healthy = (
    isinstance(body, dict)
    and set(body) == {"schema_version", "service", "launchd_label", "instance_id", "pid", "started_at", "ok", "model", "active_executions", "accepting_executions", "opencode", "error", "gateway_health", "idempotency_ledger"}
    and body.get("schema_version") == 2
    and body.get("service") == "opencode-codex-bridge"
    and body.get("launchd_label") == "com.arnaud.opencode-codex-bridge"
    and instance.version == 4
    and started.tzinfo is not None
    and body.get("pid") == expected_pid
    and body.get("ok") is True
    and body.get("model") == "opencode/router"
    and type(body.get("active_executions")) is int
    and body.get("active_executions") >= 0
    and body.get("accepting_executions") is True
    and isinstance(body.get("opencode"), dict)
    and body["opencode"].get("healthy") is True
    and body.get("error") is None
    and valid_gateway_health(body.get("gateway_health"))
    and valid_idempotency_ledger(body.get("idempotency_ledger"))
    and body["idempotency_ledger"].get("healthy") is True
    and (not previous or str(instance) != previous)
)
if not healthy:
    raise SystemExit(1)
print(instance)
' "$expected_pid" "$previous_instance"
}

if launchctl print "$bridge_target" >/dev/null 2>&1 || launchctl list | grep -q "$bridge_label" || [[ -f "$bridge_plist" ]]; then
  previous_instance="$(bridge_observed_instance 2>/dev/null || true)"
  if ! launchctl print "$bridge_target" >/dev/null 2>&1 && [[ -f "$bridge_plist" ]]; then
    launchctl bootstrap "$bridge_domain" "$bridge_plist" 2>/dev/null || true
  fi
  if launchctl kickstart -k "$bridge_target" 2>/dev/null; then
    # The previous instance had no active execution and has now been asked to
    # stop. Release the admission fence so the replacement can prove it is
    # accepting work with the newly rendered profile.
    release_activation_lock
    ready=0
    expected_model="$(python3 "$PYTHON_TOOL" --repo "$REPO" resolve "$MODE" agents codex-router \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"].split("/", 1)[1])')"
    for _ in $(seq 1 "$bridge_health_attempts"); do
      if bridge_valid_instance "$previous_instance" >/dev/null \
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
      python3 "$PYTHON_TOOL" --repo "$REPO" mark-applied "$MODE" "$expected_model"
      echo "✅ Profile switched to $MODE — bridge restarted, new routing is live."
    else
      echo "⚠️ Profile switched to $MODE and the bridge restart was requested, but a new launchd-owned bridge health proof did not recover within ${bridge_health_attempts} attempts. Check 'oc doctor'." >&2
      exit 1
    fi
  else
    echo "⚠️ Profile desired state is $MODE, but the bridge restart failed; no applied-profile marker was written." >&2
    exit 1
  fi
else
  echo "✅ Profile desired state is $MODE — no LaunchAgent is installed, so this is desired-only; run 'oc launch' to apply it."
fi
