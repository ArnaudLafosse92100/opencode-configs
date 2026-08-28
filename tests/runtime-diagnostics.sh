#!/usr/bin/env bash
# Cost-safe regression fixtures for team/runtime diagnostics. No agent is
# started and no provider/model endpoint is called.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=lib/common.sh
source "$REPO/lib/common.sh"

pass=0 fail=0
ok(){ printf '  ✓ %s\n' "$*"; pass=$((pass+1)); }
bad(){ printf '  ✗ %s\n' "$*"; fail=$((fail+1)); }
expect_text(){
  local name="$1" text="$2" pattern="$3"
  if printf '%s\n' "$text" | grep -qF "$pattern"; then ok "$name"; else
    bad "$name (missing: $pattern)"
  fi
}

printf '\nOpenConfig runtime diagnostic fixtures (no model calls)\n\n'
TMP="$(mktemp -d "${TMPDIR:-/tmp}/oc-runtime-fixtures.XXXXXX")"
fake_bridge_pid=""
cleanup_fixture() {
  if [[ "$fake_bridge_pid" =~ ^[0-9]+$ ]]; then kill "$fake_bridge_pid" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup_fixture EXIT

# Build a fixture from the working tree, including uncommitted content but no .git.
FIX="$TMP/repo"
mkdir -p "$FIX"
while IFS= read -r rel; do
  [[ -f "$REPO/$rel" || -L "$REPO/$rel" ]] || continue
  mkdir -p "$FIX/$(dirname "$rel")"
  cp -P "$REPO/$rel" "$FIX/$rel"
done < <(git -C "$REPO" ls-files)

python3 - "$FIX" <<'PY'
import json, os, sys
repo=sys.argv[1]
op=os.path.join(repo,"oh-my-openagent.json")
omo=json.load(open(op))
omo["disabled_agents"]=sorted(set(omo.get("disabled_agents") or [])|{"sisyphus"})
json.dump(omo,open(op,"w"),indent=2)
for name in ("debug-team","ship-feature"):
    path=os.path.join(repo,"teams",name,"config.json")
    team=json.load(open(path))
    if name=="debug-team":
        team["version"]=2
        team["unexpected"]=True
        team["members"][1]["prompt"]=team["members"][1]["prompt"].replace("DEPENDENCY:","GATE:")
    else:
        common=("ROLE: edit. METHOD: focused. OWNERSHIP: same files. "
                "Mailbox the lead. VERIFY: targeted fixture. "
                "SHUTDOWN: request shutdown and await approval.")
        team["members"][0]["prompt"]=common
        team["members"][1]["prompt"]=common
        team["members"][2]["prompt"]=(
            "ROLE: verify. DELIVERABLE: evidence. OWNERSHIP: no edits. "
            "Mailbox the lead. VERIFY: targeted fixture. DEPENDENCY: wait for forge."
        )
    json.dump(team,open(path,"w"),indent=2)
PY

out="$(OC_VALIDATE_REPO="$FIX" OC_VALIDATE_OFFLINE=1 "$REPO/validate.sh" --quiet 2>&1 || true)"
expect_text "disabled Sisyphus rejected" "$out" "sisyphus must not appear in disabled_agents"
expect_text "team version rejected" "$out" "version must be 1"
expect_text "unknown team key rejected" "$out" "unknown top-level keys"
expect_text "overlapping ownership rejected" "$out" "overlapping edit ownership"
expect_text "dependency gate required" "$out" "member 'root-cause' must include DEPENDENCY:"
expect_text "shutdown lifecycle required" "$out" "prompt missing team contract clauses: SHUTDOWN:"

python3 - "$FIX/oh-my-openagent.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["disabled_agents"]=[x for x in d.get("disabled_agents",[]) if x!="sisyphus"]
d["agents"].pop("sisyphus",None)
json.dump(d,open(p,"w"),indent=2)
PY
out="$(OC_VALIDATE_REPO="$FIX" OC_VALIDATE_OFFLINE=1 "$REPO/validate.sh" --quiet 2>&1 || true)"
expect_text "missing Sisyphus rejected" "$out" "agents.sisyphus missing"
expect_text "missing lead route rejected" "$out" "lead subagent_type 'sisyphus' is not declared"

# Custom XDG cache readiness requires matching main + platform package versions
# and an executable native launcher.
XDG="$TMP/custom-cache"
PIN="oh-my-openagent@4.19.4"
CDIR="$XDG/opencode/packages/$PIN"
suffix="$(python3 - <<'PY'
import platform
s=platform.system().lower(); m=platform.machine().lower()
print(("darwin-" if s=="darwin" else "linux-")+("arm64" if m in ("arm64","aarch64") else "x64"))
PY
)"
mkdir -p "$CDIR/node_modules/oh-my-openagent" "$CDIR/node_modules/oh-my-openagent-$suffix/bin"
printf '{"version":"4.19.4"}\n' >"$CDIR/node_modules/oh-my-openagent/package.json"
printf '{"version":"4.19.4"}\n' >"$CDIR/node_modules/oh-my-openagent-$suffix/package.json"
printf '#!/bin/sh\nexit 0\n' >"$CDIR/node_modules/oh-my-openagent-$suffix/bin/omo"
chmod +x "$CDIR/node_modules/oh-my-openagent-$suffix/bin/omo"
if XDG_CACHE_HOME="$XDG" oc_omo_plugin_cache_ok "$PIN"; then ok "custom XDG cache accepted"; else bad "custom XDG cache rejected"; fi
printf '{"version":"0.0.0"}\n' >"$CDIR/node_modules/oh-my-openagent-$suffix/package.json"
if XDG_CACHE_HOME="$XDG" oc_omo_plugin_cache_ok "$PIN"; then bad "mismatched native cache accepted"; else ok "mismatched native cache rejected"; fi

# Agent-list fixtures exercise success, missing visibility, and timeout paths.
FAKE="$TMP/fake-opencode"
cat >"$FAKE" <<'SH'
#!/bin/sh
case "${FAKE_AGENT_MODE:-ok}" in
  timeout) sleep 2 ;;
  missing) printf 'Sisyphus - ultraworker (primary)\n' ;;
  *) printf 'Sisyphus - ultraworker (primary)\nHephaestus - Deep Agent (primary)\nSisyphus-Junior (subagent)\n' ;;
esac
SH
chmod +x "$FAKE"
out="$(FAKE_AGENT_MODE=ok oc_agent_visibility_report "$FAKE" "$REPO" 1)"
if ! printf '%s\n' "$out" | grep -q '^BAD|' && printf '%s\n' "$out" | grep -q 'without starting a model'; then
  ok "bounded runtime visibility success"
else bad "runtime visibility success fixture"; fi
out="$(FAKE_AGENT_MODE=missing oc_agent_visibility_report "$FAKE" "$REPO" 1)"
expect_text "runtime-visible gap reported" "$out" "declared/cache-ready but not runtime-visible"
out="$(FAKE_AGENT_MODE=timeout oc_agent_visibility_report "$FAKE" "$REPO" 0.1)"
expect_text "runtime probe timeout bounded" "$out" "timed out"

# A failed profile-env producer must never leave inherited runtime paths in a
# wrapper process. Bash launchers share the common helper; zsh has the same
# explicit-capture contract without sourcing bash helpers.
PROFILE_FAIL="$TMP/profile-env-fail"
printf '#!/bin/sh\nexit 17\n' >"$PROFILE_FAIL"; chmod +x "$PROFILE_FAIL"
PROFILE_PARTIAL="$TMP/profile-env-partial"
printf '#!/bin/sh\nprintf "OPENCODE_CONFIG_DIR=/new/config\\nXDG_CONFIG_HOME=/new/xdg\\n"\n' >"$PROFILE_PARTIAL"; chmod +x "$PROFILE_PARTIAL"
PROFILE_MALFORMED="$TMP/profile-env-malformed"
printf '#!/bin/sh\nprintf "OPENCODE_CONFIG_DIR=\\047unterminated\\n"\n' >"$PROFILE_MALFORMED"; chmod +x "$PROFILE_MALFORMED"
bash_snapshot_contract=1
for profile_producer in "$PROFILE_FAIL" "$PROFILE_PARTIAL" "$PROFILE_MALFORMED"; do
  wrapper_result="$(OPENCODE_CONFIG_DIR=/stale/config XDG_CONFIG_HOME=/stale/xdg OPENCONFIG_RUNTIME_PROFILE=pentest REPO="$REPO" bash -c '
    source "$REPO/lib/common.sh"
    if oc_load_runtime_profile_env "$1"; then exit 9; fi
    [[ -z "${OPENCODE_CONFIG_DIR:-}" && -z "${XDG_CONFIG_HOME:-}" && -z "${OPENCONFIG_RUNTIME_PROFILE:-}" ]] && printf ok
  ' _ "$profile_producer" 2>/dev/null || true)"
  [[ "$wrapper_result" == ok ]] || bash_snapshot_contract=0
done
if [[ $bash_snapshot_contract -eq 1 ]] \
  && grep -qF 'oc_load_runtime_profile_env "$REPO/runtime-profile.sh"' "$REPO/opencode.sh" \
  && grep -qF 'oc_load_runtime_profile_env "$REPO/runtime-profile.sh"' "$REPO/run.sh" \
  && ! grep -qF 'eval "$("$REPO/runtime-profile.sh" env --shell)"' "$REPO/opencode.sh" \
  && ! grep -qF 'eval "$("$REPO/runtime-profile.sh" env --shell)"' "$REPO/run.sh"; then
  ok "bash wrappers reject failed, partial, or malformed profile snapshots without stale paths"
else
  bad "bash wrapper profile snapshot failure handling"
fi
zsh_snapshot_contract=1
profile_case=0
for profile_producer in "$PROFILE_FAIL" "$PROFILE_PARTIAL" "$PROFILE_MALFORMED"; do
  profile_case=$((profile_case + 1))
  ZSH_FAIL_HOME="$TMP/zsh-profile-env-$profile_case"; mkdir -p "$ZSH_FAIL_HOME/.config/opencode"
  cp "$profile_producer" "$ZSH_FAIL_HOME/.config/opencode/oc"
  zsh_result="$(HOME="$ZSH_FAIL_HOME" OPENCODE_CONFIG_DIR=/stale/config XDG_CONFIG_HOME=/stale/xdg OPENCONFIG_RUNTIME_PROFILE=pentest zsh -f -c '
    source "$1"
    if opencode >/dev/null 2>&1; then exit 9; fi
    [[ -z "${OPENCODE_CONFIG_DIR:-}" && -z "${XDG_CONFIG_HOME:-}" && -z "${OPENCONFIG_RUNTIME_PROFILE:-}" ]] && print -r -- ok
  ' _ "$REPO/zshrc.snippet" 2>/dev/null || true)"
  [[ "$zsh_result" == ok ]] || zsh_snapshot_contract=0
done
if [[ $zsh_snapshot_contract -eq 1 ]] && ! grep -qF 'eval "$("$HOME/.config/opencode/oc" profile env --shell)"' "$REPO/zshrc.snippet"; then
  ok "zsh wrapper rejects failed, partial, or malformed profile snapshots without stale paths"
else
  bad "zsh wrapper profile snapshot failure handling"
fi

# Compatibility homes keep raw OpenCode away from the immutable checkout. Use
# a fully isolated runtime/native state and exercise every profile lifecycle.
COMPAT_STATE="$TMP/compat-state"
COMPAT_NATIVE="$TMP/compat-native/omo.jsonc"
compat_env=(OC_RUNTIME_STATE_DIR="$COMPAT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/compat-prompts" OC_NATIVE_OMO_PATH="$COMPAT_NATIVE")
compat_normal="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" env)"
compat_private="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" env normal-private)"
compat_pentest="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" env pentest)"
compat_back="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" env normal)"
if printf '%s' "$compat_normal" | grep -q 'compat/generations/normal-' \
  && printf '%s' "$compat_private" | grep -q 'compat/generations/normal-private-' \
  && printf '%s' "$compat_pentest" | grep -q 'compat/generations/pentest-' \
  && printf '%s' "$compat_back" | grep -q 'compat/generations/normal-'; then
  ok "compat profile resolver switches normal -> normal-private -> pentest -> normal"
else bad "compat profile resolver profile switch"; fi
compat_current="$COMPAT_STATE/compat/current"
runtime_normal="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" path normal)"
compat_normal_path="$(env "${compat_env[@]}" "$REPO/runtime-profile.sh" compat-path normal)"
if [[ "$runtime_normal" == *"/runtime/generations/"* && "$compat_normal_path" == *"/compat/generations/"* ]]; then
  ok "profile path preserves runtime-overlay contract; compat-path is explicit"
else bad "profile path/compat-path contract"; fi
SNAPSHOT_STATE="$TMP/snapshot-state"; SNAPSHOT_NATIVE="$TMP/snapshot-native/omo.jsonc"
snapshot_env=(OC_RUNTIME_STATE_DIR="$SNAPSHOT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/snapshot-prompts" OC_NATIVE_OMO_PATH="$SNAPSHOT_NATIVE")
snapshot_py=(python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO")
env "${snapshot_env[@]}" "${snapshot_py[@]}" activate normal >/dev/null
snapshot_current_before="$(realpath "$SNAPSHOT_STATE/compat/current")"
snapshot_active_before="$(cat "$SNAPSHOT_STATE/active-profile")"
snapshot_before="$(env "${snapshot_env[@]}" "${snapshot_py[@]}" snapshot)"
snapshot_current_after="$(realpath "$SNAPSHOT_STATE/compat/current")"
snapshot_active_after="$(cat "$SNAPSHOT_STATE/active-profile")"
if [[ "$snapshot_current_before" == "$snapshot_current_after" && "$snapshot_active_before" == "$snapshot_active_after" ]] \
  && python3 - "$snapshot_before" "$snapshot_current_before" <<'PY'
import json,sys
payload=json.loads(sys.argv[1]); compat=sys.argv[2]
runtime=json.load(open(compat+"/.runtime-profile.json"))
assert payload["desiredProfile"] == "normal"
assert payload["compatPath"] == compat
assert payload["runtimePath"] == str(__import__("pathlib").Path(compat,".runtime").resolve())
assert payload["expectedIdentity"]["profile"] == runtime["profile"] == "normal"
PY
then
  ok "profile snapshot is non-mutating and returns one current generation"
else bad "profile snapshot non-mutation contract"; fi
env "${snapshot_env[@]}" "${snapshot_py[@]}" activate pentest >/dev/null & snapshot_switch_pid=$!
snapshot_race="$(env "${snapshot_env[@]}" "${snapshot_py[@]}" snapshot)"
wait "$snapshot_switch_pid"
if python3 - "$snapshot_race" <<'PY'
import json, pathlib, sys
p=json.loads(sys.argv[1])
if p["compatPath"] is None:
    raise SystemExit(0)
compat=pathlib.Path(p["compatPath"]); runtime=pathlib.Path(p["runtimePath"])
c=json.load(open(compat/".runtime-profile.json")); r=json.load(open(runtime/".runtime-profile.json"))
raise SystemExit(0 if p["desiredProfile"] == c.get("profile") == r.get("profile") == p["expectedIdentity"].get("profile") else 1)
PY
then
  ok "concurrent profile snapshot never mixes runtime and compat generations"
else bad "profile snapshot concurrency coherence"; fi
if [[ "$(grep -c 'runtime-profile.sh snapshot' "$REPO/doctor.sh")" -eq 1 ]] \
  && grep -q '"normal-private"' "$REPO/doctor.sh" \
  && ! grep -Eq 'runtime-profile\.sh (show|applied|identity)' "$REPO/doctor.sh"; then
  ok "OpenConfig doctor consumes one atomic profile snapshot and accepts normal-private"
else bad "OpenConfig doctor atomic snapshot consumer"; fi
compat_config_dir="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["configDir"])' <<<"$compat_back")"
repo_hash_before_raw="$(git -C "$REPO" hash-object opencode.json)"
FAKE_RAW="$TMP/fake-absolute-opencode"
cat >"$FAKE_RAW" <<'SH'
#!/bin/sh
set -eu
: "${OPENCODE_CONFIG_DIR:?}"
printf '{}' >"$OPENCODE_CONFIG_DIR/package.json"
mkdir -p "$OPENCODE_CONFIG_DIR/node_modules"
printf x >"$OPENCODE_CONFIG_DIR/node_modules/raw-marker"
SH
chmod +x "$FAKE_RAW"
OPENCODE_CONFIG_DIR="$compat_config_dir" "$FAKE_RAW"
raw_before_refresh="$(realpath "$COMPAT_STATE/compat/current")"
env "${compat_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" ensure --quiet >/dev/null
raw_after_refresh="$(realpath "$COMPAT_STATE/compat/current")"
repo_hash_after_raw="$(git -C "$REPO" hash-object opencode.json)"
if [[ -f "$compat_config_dir/package.json" && "$raw_before_refresh" == "$raw_after_refresh" \
  && "$repo_hash_before_raw" == "$repo_hash_after_raw" ]]; then
  ok "raw absolute OpenCode writes stay in the reusable compat generation"
else bad "raw absolute OpenCode compatibility isolation"; fi
ENV_REPO="$TMP/env-identity-repo"
cp -R "$REPO" "$ENV_REPO"
rm -f "$ENV_REPO/.env"
ENV_STATE="$TMP/env-identity-state"; ENV_NATIVE="$TMP/env-identity-native/omo.jsonc"
env OC_RUNTIME_STATE_DIR="$ENV_STATE" OC_NATIVE_OMO_PATH="$ENV_NATIVE" python3 "$ENV_REPO/scripts/runtime-profile.py" --repo "$ENV_REPO" prepare-native-alias >/dev/null
env_compat_before="$(realpath "$ENV_STATE/compat/current")"
printf 'OPENROUTER_API_KEY=fixture\n' >"$ENV_REPO/.env"
env OC_RUNTIME_STATE_DIR="$ENV_STATE" OC_NATIVE_OMO_PATH="$ENV_NATIVE" python3 "$ENV_REPO/scripts/runtime-profile.py" --repo "$ENV_REPO" prepare-native-alias >/dev/null
env_compat_after="$(realpath "$ENV_STATE/compat/current")"
printf 'OPENROUTER_API_KEY=changed-fixture\n' >"$ENV_REPO/.env"
env OC_RUNTIME_STATE_DIR="$ENV_STATE" OC_NATIVE_OMO_PATH="$ENV_NATIVE" python3 "$ENV_REPO/scripts/runtime-profile.py" --repo "$ENV_REPO" prepare-native-alias >/dev/null
env_compat_values_only="$(realpath "$ENV_STATE/compat/current")"
if [[ "$env_compat_before" != "$env_compat_after" && "$env_compat_after" == "$env_compat_values_only" \
  && -L "$env_compat_after/.env" && "$(realpath "$env_compat_after/.env")" == "$(realpath "$ENV_REPO/.env")" ]]; then
  ok "compat identity refreshes absent-to-present env without hashing values"
else bad "compat env structural identity"; fi
CLONE_REPO="$TMP/clone-source-root"
cp -R "$REPO" "$CLONE_REPO"
clone_runtime="$(env OC_RUNTIME_STATE_DIR="$COMPAT_STATE" OC_NATIVE_OMO_PATH="$COMPAT_NATIVE" python3 "$CLONE_REPO/scripts/runtime-profile.py" --repo "$CLONE_REPO" path normal)"
clone_compat="$(env OC_RUNTIME_STATE_DIR="$COMPAT_STATE" OC_NATIVE_OMO_PATH="$COMPAT_NATIVE" python3 "$CLONE_REPO/scripts/runtime-profile.py" --repo "$CLONE_REPO" compat-path normal)"
if [[ "$clone_runtime" != "$runtime_normal" && "$(realpath "$clone_compat/.openconfig-source")" == "$(realpath "$CLONE_REPO")" ]]; then
  ok "checkout identity prevents cross-clone generation reuse"
else bad "checkout identity generation isolation"; fi
STAGE_STATE="$TMP/stage-state"
stage_env=(OC_RUNTIME_STATE_DIR="$STAGE_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/stage-prompts" OC_NATIVE_OMO_PATH="$TMP/stage-native/omo.jsonc")
stage_cmd=(python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" activate)
env "${stage_env[@]}" "${stage_cmd[@]}" normal >/dev/null
stage_before="$(realpath "$STAGE_STATE/compat/current")"
stage_ok=1
for render_phase in runtime-config runtime-validated compat-validated; do
  if env "${stage_env[@]}" OC_RUNTIME_FAIL_RENDER_PHASE="$render_phase" "${stage_cmd[@]}" pentest >/dev/null 2>&1; then stage_ok=0; fi
  [[ "$(realpath "$STAGE_STATE/compat/current")" == "$stage_before" ]] || stage_ok=0
done
if [[ $stage_ok -eq 1 ]]; then ok "staged same-profile render failures preserve the complete current generation"; else bad "staged generation failure atomicity"; fi
CORRUPT_CONFIG="$stage_before/opencode.json"
printf '{"corrupt":true}\n' >"$CORRUPT_CONFIG"
env "${stage_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" ensure --quiet >/dev/null
stage_after_corrupt="$(realpath "$STAGE_STATE/compat/current")"
if [[ "$stage_after_corrupt" != "$stage_before" ]] && ! grep -q corrupt "$stage_after_corrupt/opencode.json"; then
  ok "managed compatibility drift creates a clean generation"
else bad "managed compatibility drift detection"; fi
compat_link_drift_ok=1
for managed_link in .openconfig-source lib zshrc.snippet .runtime; do
  compat_link_before="$(realpath "$STAGE_STATE/compat/current")"
  rm -f "$compat_link_before/$managed_link"
  ln -s "$TMP/not-the-managed-target" "$compat_link_before/$managed_link"
  env "${stage_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" ensure --quiet >/dev/null || compat_link_drift_ok=0
  compat_link_after="$(realpath "$STAGE_STATE/compat/current")"
  [[ "$compat_link_after" != "$compat_link_before" ]] || compat_link_drift_ok=0
done
if [[ $compat_link_drift_ok -eq 1 ]]; then ok "managed compat links are manifest-protected"; else bad "managed compat link drift detection"; fi
WRAPPER_REPO="$TMP/wrapper-source"
cp -R "$REPO" "$WRAPPER_REPO"
WRAPPER_STATE="$TMP/wrapper-state"; WRAPPER_NATIVE="$TMP/wrapper-native/omo.jsonc"
wrapper_env=(OC_RUNTIME_STATE_DIR="$WRAPPER_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/wrapper-prompts" OC_NATIVE_OMO_PATH="$WRAPPER_NATIVE")
wrapper_py=(python3 "$WRAPPER_REPO/scripts/runtime-profile.py" --repo "$WRAPPER_REPO")
env "${wrapper_env[@]}" "${wrapper_py[@]}" activate normal >/dev/null
wrapper_model="$(env "${wrapper_env[@]}" "${wrapper_py[@]}" resolve normal agents codex-router | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"].split("/",1)[-1])')"
env "${wrapper_env[@]}" "${wrapper_py[@]}" mark-applied normal "$wrapper_model"
if [[ "$(python3 - "$WRAPPER_STATE/runtime/current/oh-my-openagent.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['agents']['sisyphus']['prompt_append'])
PY
)" == 'file://~/.config/opencode/prompts/agents/sisyphus.md' ]]; then
  ok "Sisyphus prompt uses the OmO-allowed stable config-home alias"
else
  bad "Sisyphus prompt config-home alias"
fi
wrapper_inputs_ok=1
for wrapper_input in oc runtime-profile.sh opencode.sh run.sh openrouter-admin.sh zshrc.snippet lib/common.sh; do
  wrapper_before="$(realpath "$WRAPPER_STATE/compat/current")"
  printf '\n# source-fingerprint fixture %s\n' "$wrapper_input" >> "$WRAPPER_REPO/$wrapper_input"
  env "${wrapper_env[@]}" "${wrapper_py[@]}" ensure --quiet >/dev/null || wrapper_inputs_ok=0
  wrapper_after="$(realpath "$WRAPPER_STATE/compat/current")"
  [[ "$wrapper_after" != "$wrapper_before" ]] || wrapper_inputs_ok=0
  [[ "$(env "${wrapper_env[@]}" "${wrapper_py[@]}" applied)" == null ]] || wrapper_inputs_ok=0
  env "${wrapper_env[@]}" "${wrapper_py[@]}" mark-applied normal "$wrapper_model" >/dev/null || wrapper_inputs_ok=0
done
if [[ $wrapper_inputs_ok -eq 1 ]]; then
  ok "source launcher changes regenerate compat and stale applied proof"
else
  bad "source launcher fingerprint coverage"
fi
runtime_manifest_ok=1
for runtime_entry in opencode.json agents/codex-router.md prompts/agents/sisyphus.md; do
  RUNTIME_MANIFEST_STATE="$TMP/runtime-manifest-${runtime_entry//\//-}"
  runtime_manifest_env=(OC_RUNTIME_STATE_DIR="$RUNTIME_MANIFEST_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/runtime-manifest-prompts" OC_NATIVE_OMO_PATH="$TMP/runtime-manifest-native/omo.jsonc")
  env "${runtime_manifest_env[@]}" "${stage_cmd[@]}" normal >/dev/null
  runtime_manifest_before="$(realpath "$RUNTIME_MANIFEST_STATE/runtime/current")"
  printf 'corrupt\n' >"$runtime_manifest_before/$runtime_entry"
  runtime_manifest_after="$(env "${runtime_manifest_env[@]}" "$REPO/runtime-profile.sh" path normal)"
  [[ "$runtime_manifest_after" != "$runtime_manifest_before" ]] || runtime_manifest_ok=0
done
if [[ $runtime_manifest_ok -eq 1 ]]; then ok "runtime payload manifest rejects config agent and prompt corruption"; else bad "runtime manifest drift detection"; fi
XDG_DYNAMIC="$TMP/xdg-dynamic"; mkdir -p "$XDG_DYNAMIC/gh"
xdg_dynamic_env=(OC_RUNTIME_STATE_DIR="$TMP/xdg-dynamic-state" OC_RUNTIME_PROMPT_DIR="$TMP/xdg-dynamic-prompts" OC_NATIVE_OMO_PATH="$TMP/xdg-dynamic-native/omo.jsonc" OC_SOURCE_XDG_CONFIG_HOME="$XDG_DYNAMIC")
env "${xdg_dynamic_env[@]}" "$REPO/runtime-profile.sh" env normal >/dev/null
xdg_dynamic_before="$(realpath "$TMP/xdg-dynamic-state/compat/current")"
mkdir -p "$XDG_DYNAMIC/new-sibling"
env "${xdg_dynamic_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" ensure --quiet >/dev/null
xdg_dynamic_after="$(realpath "$TMP/xdg-dynamic-state/compat/current")"
if [[ "$xdg_dynamic_before" != "$xdg_dynamic_after" && -L "$xdg_dynamic_after/xdg/new-sibling" \
  && "$(realpath "$xdg_dynamic_after/xdg/new-sibling")" == "$(realpath "$XDG_DYNAMIC/new-sibling")" ]]; then
  ok "XDG sibling inventory refreshes the compatibility generation"
else bad "XDG sibling identity refresh"; fi
REUSE_STATE="$TMP/reuse-state"
reuse_env=(OC_RUNTIME_STATE_DIR="$REUSE_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/reuse-prompts" OC_NATIVE_OMO_PATH="$TMP/reuse-native/omo.jsonc")
env "${reuse_env[@]}" "$REPO/runtime-profile.sh" env normal >/dev/null
reuse_count_before="$(find "$REUSE_STATE/runtime/generations" "$REUSE_STATE/compat/generations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
reuse_path_one="$(env "${reuse_env[@]}" "$REPO/runtime-profile.sh" path pentest)"
reuse_compat_one="$(env "${reuse_env[@]}" "$REPO/runtime-profile.sh" compat-path pentest)"
reuse_path_two="$(env "${reuse_env[@]}" "$REPO/runtime-profile.sh" path pentest)"
reuse_compat_two="$(env "${reuse_env[@]}" "$REPO/runtime-profile.sh" compat-path pentest)"
reuse_count_after="$(find "$REUSE_STATE/runtime/generations" "$REUSE_STATE/compat/generations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$reuse_path_one" == "$reuse_path_two" && "$reuse_compat_one" == "$reuse_compat_two" && "$reuse_count_before" -lt "$reuse_count_after" && "$reuse_count_after" -le $((reuse_count_before + 2)) ]]; then
  ok "inactive path and compat-path reuse intact generations"
else bad "inactive generation reuse"; fi
first_publish_ok=1
for first_phase in runtime compat active native; do
  FIRST_STATE="$TMP/first-$first_phase-state"
  first_env=(OC_RUNTIME_STATE_DIR="$FIRST_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/first-$first_phase-prompts" OC_NATIVE_OMO_PATH="$TMP/first-$first_phase-native/omo.jsonc")
  if env "${first_env[@]}" OC_RUNTIME_FAIL_AFTER_PHASE="$first_phase" "${stage_cmd[@]}" normal >/dev/null 2>&1; then first_publish_ok=0; fi
  first_show="$(env "${first_env[@]}" "$REPO/runtime-profile.sh" show 2>/dev/null || true)"
  if [[ "$first_show" != normal || ! -L "$FIRST_STATE/compat/current" || -e "$FIRST_STATE/.runtime-profile.transaction.json" ]]; then first_publish_ok=0; fi
done
if [[ $first_publish_ok -eq 1 ]]; then ok "first-publish interruption phases resume their validated target"; else bad "first-publish interruption recovery"; fi
CONCURRENT_STATE="$TMP/concurrent-state"
env OC_RUNTIME_STATE_DIR="$CONCURRENT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/concurrent-prompts" OC_NATIVE_OMO_PATH="$TMP/concurrent-native/omo.jsonc" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" activate normal >/dev/null & concurrent_a=$!
env OC_RUNTIME_STATE_DIR="$CONCURRENT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/concurrent-prompts" OC_NATIVE_OMO_PATH="$TMP/concurrent-native/omo.jsonc" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" activate pentest >/dev/null & concurrent_b=$!
wait "$concurrent_a"; wait "$concurrent_b"
concurrent_active="$(tr -d '\n' < "$CONCURRENT_STATE/active-profile")"
if [[ "$(cat "$CONCURRENT_STATE/active-profile")" == "$concurrent_active" ]] \
  && python3 - "$CONCURRENT_STATE/runtime/current/.runtime-profile.json" "$CONCURRENT_STATE/compat/current/.runtime-profile.json" "$concurrent_active" <<'PY'
import json,sys
runtime,compat=(json.load(open(p)) for p in sys.argv[1:3])
same_runtime = all(compat.get(key) == value for key, value in runtime.items())
raise SystemExit(0 if same_runtime and runtime.get("profile")==sys.argv[3] else 1)
PY
then
  ok "concurrent profile switches leave matched runtime/compat pointers"
else bad "concurrent profile switch pointer coherence"; fi
APPLIED_RACE_STATE="$TMP/applied-race-state"
applied_race_env=(OC_RUNTIME_STATE_DIR="$APPLIED_RACE_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-race-prompts" OC_NATIVE_OMO_PATH="$TMP/applied-race-native/omo.jsonc")
applied_race_py=(python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO")
env "${applied_race_env[@]}" "${applied_race_py[@]}" activate normal >/dev/null
pentest_router_model="$(env "${applied_race_env[@]}" "${applied_race_py[@]}" resolve pentest agents codex-router | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"].split("/",1)[-1])')"
env "${applied_race_env[@]}" "${applied_race_py[@]}" activate pentest >/dev/null & applied_switch_pid=$!
env "${applied_race_env[@]}" "${applied_race_py[@]}" mark-applied pentest "$pentest_router_model" >/dev/null 2>&1 & applied_mark_pid=$!
wait "$applied_switch_pid" || applied_race_ok=0
wait "$applied_mark_pid" || true
applied_race_payload="$(env "${applied_race_env[@]}" "${applied_race_py[@]}" applied)"
applied_race_identity="$(env "${applied_race_env[@]}" "${applied_race_py[@]}" identity)"
if python3 - "$applied_race_payload" "$applied_race_identity" <<'PY'
import json,sys
payload=json.loads(sys.argv[1])
identity=json.loads(sys.argv[2])
if payload is None:
    raise SystemExit(0)
keys=("schema_version", "profile", "fingerprint", "generation", "compat_generation", "xdg_identity", "compat_identity", "compat_manifest_sha256", "model")
raise SystemExit(0 if all(payload.get(key) == identity.get(key) for key in keys) else 1)
PY
then
  ok "concurrent mark-applied and switch never leave a stale mixed proof"
else bad "concurrent applied marker coherence"; fi
CRASH_STATE="$TMP/crash-state"
crash_env=(OC_RUNTIME_STATE_DIR="$CRASH_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/crash-prompts" OC_NATIVE_OMO_PATH="$TMP/crash-native/omo.jsonc")
crash_cmd=(python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" activate)
env "${crash_env[@]}" "${crash_cmd[@]}" normal >/dev/null
crash_ok=1
for phase in runtime compat active native; do
  if env "${crash_env[@]}" OC_RUNTIME_FAIL_AFTER_PHASE="$phase" "${crash_cmd[@]}" pentest >/dev/null 2>&1; then
    crash_ok=0
  fi
  # Every reader acquires the same lock and rolls back an incomplete journal
  # before returning state, including failures after any individual phase.
  recovered="$(env "${crash_env[@]}" "$REPO/runtime-profile.sh" show)"
  if [[ "$recovered" != normal \
    || "$(cat "$CRASH_STATE/active-profile")" != normal ]]; then
    crash_ok=0
  fi
done
if [[ $crash_ok -eq 1 ]]; then ok "interrupted profile phases recover to last complete profile"; else bad "interrupted profile recovery"; fi
COMMIT_STATE="$TMP/commit-state"
COMMIT_NATIVE="$TMP/commit-native/omo.jsonc"
mkdir -p "$(dirname "$COMMIT_NATIVE")"
printf '// native fixture\n{"keep_root": {"value": true}, "[opencode]": {}}\n' >"$COMMIT_NATIVE"
commit_env=(OC_RUNTIME_STATE_DIR="$COMMIT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/commit-prompts" OC_NATIVE_OMO_PATH="$COMMIT_NATIVE")
env "${commit_env[@]}" "${crash_cmd[@]}" normal >/dev/null
normal_omo_path="$(realpath "$COMMIT_STATE/compat/current/.omo.jsonc")"
normal_omo_hash_before="$(shasum -a 256 "$normal_omo_path" | awk '{print $1}')"
rm -f "$COMMIT_NATIVE"
ln -s "$COMMIT_STATE/compat/current/.omo.jsonc" "$COMMIT_NATIVE"
env "${commit_env[@]}" "${crash_cmd[@]}" pentest >/dev/null
normal_omo_hash_after="$(shasum -a 256 "$normal_omo_path" | awk '{print $1}')"
COMMIT_STATE_REAL="$(realpath "$COMMIT_STATE")"
if [[ "$(readlink "$COMMIT_STATE/runtime/current")" == "$COMMIT_STATE_REAL/compat/current/.runtime" \
  && "$(readlink "$COMMIT_STATE/active-profile")" == "$COMMIT_STATE_REAL/compat/current/.active-profile" \
  && "$(realpath "$COMMIT_NATIVE")" == "$(realpath "$COMMIT_STATE/compat/current/.omo.jsonc")" \
  && "$normal_omo_hash_before" == "$normal_omo_hash_after" ]] \
  && grep -q '"keep_root"' "$COMMIT_NATIVE" && grep -q '"\[opencode\]"' "$COMMIT_NATIVE"; then
  ok "single compat commit pointer drives runtime/state/native envelope"
else bad "single compat commit pointer"; fi
JOURNAL_STATE="$TMP/migration-journal-state"
JOURNAL_NATIVE="$TMP/migration-journal-native/omo.jsonc"
mkdir -p "$(dirname "$JOURNAL_NATIVE")"
printf '{"migrationId":"fixture","targetWritten":true,"completedMoves":[]}' >"$(dirname "$JOURNAL_NATIVE")/.migration-journal.json"
journal_out="$(OC_RUNTIME_STATE_DIR="$JOURNAL_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/migration-journal-prompts" OC_NATIVE_OMO_PATH="$JOURNAL_NATIVE" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" show 2>&1 || true)"
if [[ "$journal_out" == *"migration journal is present"* ]]; then ok "pending OmO migration journal blocks profile writes"; else bad "pending OmO migration journal guard"; fi
setup_journal_out="$(OC_NATIVE_OMO_PATH="$JOURNAL_NATIVE" "$REPO/setup.sh" --check 2>&1 || true)"
if [[ "$setup_journal_out" == *"Pending OmO migration journal"* ]]; then ok "setup fails closed on pending OmO migration journal"; else bad "setup migration journal guard"; fi
PREP_STATE="$TMP/prepare-recovery-state"; PREP_NATIVE="$TMP/prepare-recovery-native/omo.jsonc"
mkdir -p "$(dirname "$PREP_NATIVE")"
printf '// preserve exactly\n{ "codex": {"keep": true}, }\n' >"$PREP_NATIVE"
chmod 640 "$PREP_NATIVE"
prep_hash_before="$(shasum -a 256 "$PREP_NATIVE" | awk '{print $1}')"; prep_mode_before="$(stat -f '%Lp' "$PREP_NATIVE")"
prep_env=(OC_RUNTIME_STATE_DIR="$PREP_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/prepare-recovery-prompts" OC_NATIVE_OMO_PATH="$PREP_NATIVE")
if env "${prep_env[@]}" OC_RUNTIME_FAIL_AFTER_PHASE=native python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" prepare-native-alias >/dev/null 2>&1; then prep_ok=0; else prep_ok=1; fi
env "${prep_env[@]}" "$REPO/runtime-profile.sh" show >/dev/null 2>&1 || prep_ok=0
prep_hash_after="$(shasum -a 256 "$PREP_NATIVE" | awk '{print $1}')"; prep_mode_after="$(stat -f '%Lp' "$PREP_NATIVE")"
if [[ $prep_ok -eq 1 && "$prep_hash_before" == "$prep_hash_after" && "$prep_mode_before" == "$prep_mode_after" && ! -e "$PREP_STATE/.runtime-profile.transaction.json" ]]; then
  ok "prepare-native-alias recovery never rewrites native OmO bytes"
else bad "prepare-native-alias recovery native preservation"; fi
MIG_HOME="$TMP/sisyphus-prompt-migration-home"; MIG_STATE="$MIG_HOME/.local/state/openconfig"; MIG_NATIVE="$MIG_HOME/.omo/omo.jsonc"
mkdir -p "$(dirname "$MIG_NATIVE")"
mig_env=(HOME="$MIG_HOME" XDG_STATE_HOME="$MIG_HOME/.local/state" OC_RUNTIME_STATE_DIR="$MIG_STATE" OC_NATIVE_OMO_PATH="$MIG_NATIVE")
env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" prepare-native-alias >/dev/null
MIG_TARGET="$MIG_STATE/compat/current/.omo.jsonc"
python3 - "$MIG_TARGET" "$MIG_NATIVE" "$MIG_HOME" <<'PY'
import copy,json,sys
from pathlib import Path
target,native,home=map(Path,sys.argv[1:])
text=target.read_text(encoding='utf8'); payload=json.loads(text[text.find('{'):])
payload=copy.deepcopy(payload)
for section in ('agents', 'categories'):
    for route in payload['[opencode]'][section].values():
        models=route.pop('models')
        primary=models[0]
        route['model']=primary['model'] if isinstance(primary,dict) else primary
        if isinstance(primary,dict) and 'reasoning' in primary:
            route['reasoning']=primary['reasoning']
        route['fallback_models']=models[1:]
same_prompt=home/'legacy-same-prompt.jsonc'
same_prompt.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf8')
payload['[opencode]']['agents']['sisyphus']['prompt_append']=f'file://{home}/.omo/openconfig/runtime/profiles/normal/prompts/agents/sisyphus.md'
native.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf8')
PY
chmod 640 "$MIG_NATIVE"; mig_original="$MIG_HOME/original.jsonc"; cp "$MIG_NATIVE" "$mig_original"
mig_allowed=1
MIG_SAME_PROMPT="$MIG_HOME/legacy-same-prompt.jsonc"
if [[ "$(env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" native-opencode-digest "$MIG_SAME_PROMPT")" != "$(env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" native-opencode-digest "$MIG_TARGET")" ]]; then mig_allowed=0; fi
env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" native-opencode-equivalent "$MIG_NATIVE" "$MIG_TARGET" normal >/dev/null || mig_allowed=0
MIG_RUNTIME="$(realpath "$(dirname "$MIG_TARGET")/.runtime")"
for invalid_kind in wrong-profile outside runtime-generation forged-generation other-diff fallback-order reasoning-drift temperature-drift; do
  invalid="$MIG_HOME/$invalid_kind.jsonc"; cp "$mig_original" "$invalid"
  python3 - "$invalid" "$invalid_kind" "$MIG_RUNTIME" "$MIG_STATE" <<'PY'
import json,sys
from pathlib import Path
p,kind,runtime,state=Path(sys.argv[1]),sys.argv[2],Path(sys.argv[3]),Path(sys.argv[4])
value=json.load(open(p))
if kind=='wrong-profile':
    value['[opencode]']['agents']['sisyphus']['prompt_append']=value['[opencode]']['agents']['sisyphus']['prompt_append'].replace('/normal/','/pentest/')
elif kind=='outside':
    value['[opencode]']['agents']['sisyphus']['prompt_append']='file:///tmp/outside/prompts/agents/sisyphus.md'
elif kind=='runtime-generation':
    value['[opencode]']['agents']['sisyphus']['prompt_append']=f'file://{runtime}/prompts/agents/sisyphus.md'
elif kind=='forged-generation':
    value['[opencode]']['agents']['sisyphus']['prompt_append']=f'file://{state}/runtime/generations/normal-forged/prompts/agents/sisyphus.md'
elif kind=='other-diff':
    value['[opencode]']['categories']['quick']['model']='unexpected/model'
elif kind=='fallback-order':
    # `quick` currently has one fallback, so reversing it was a no-op and made
    # this negative fixture fail for the wrong reason. codex-router has at
    # least two ordered fallbacks in the normal profile.
    value['[opencode]']['agents']['codex-router']['fallback_models'].reverse()
elif kind=='reasoning-drift':
    value['[opencode]']['agents']['sisyphus']['reasoning']='high'
elif kind=='temperature-drift':
    value['[opencode]']['agents']['sisyphus']['temperature']=0.99
p.write_text(json.dumps(value)+'\n')
PY
  if env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" native-opencode-equivalent "$invalid" "$MIG_TARGET" normal >/dev/null 2>&1; then mig_allowed=0; fi
done
env "${mig_env[@]}" REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_provision_native_omo_alias "$REPO"' >/dev/null || mig_allowed=0
mig_backup="$(find "$MIG_HOME/.opencode-backups" -name omo.jsonc -type f | head -1)"
if [[ $mig_allowed -eq 1 && -L "$MIG_NATIVE" && -n "$mig_backup" ]] && cmp -s "$mig_original" "$mig_backup"; then
  ok "native migration permits only managed Sisyphus prompt relocation with exact backup"
else bad "native Sisyphus prompt migration equivalence"; fi
MIG_CURRENT_SOURCE="$MIG_HOME/current-generation-source.jsonc"; cp "$MIG_TARGET" "$MIG_CURRENT_SOURCE"
if env "${mig_env[@]}" python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" native-opencode-equivalent "$MIG_CURRENT_SOURCE" "$MIG_TARGET" normal >/dev/null 2>&1; then
  bad "native migration rejects source generation references"
else
  ok "native migration rejects source generation references"
fi
# Explicit native alias migration is a setup/install-only operation. Verify its
# backup hash/mode manifest, idempotence, and refusal when OmO has a journal.
ALIAS_HOME="$TMP/alias-home"; ALIAS_STATE="$ALIAS_HOME/.local/state/openconfig"; ALIAS_NATIVE="$ALIAS_HOME/.omo/omo.jsonc"
mkdir -p "$(dirname "$ALIAS_NATIVE")"
printf '// original comment\n{\n  "codex": {"keep": true},\n  "_migrations": ["legacy",],\n}\n' >"$ALIAS_NATIVE"
chmod 640 "$ALIAS_NATIVE"
alias_result="$(HOME="$ALIAS_HOME" XDG_STATE_HOME="$ALIAS_HOME/.local/state" OC_NATIVE_OMO_PATH="$ALIAS_NATIVE" OC_RUNTIME_PROMPT_DIR="$TMP/alias-prompts" REPO="$REPO" bash -c 'set -e; original_copy="$HOME/original-omo.jsonc"; cp "$OC_NATIVE_OMO_PATH" "$original_copy"; python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" prepare-native-alias >/dev/null; original_sha=$(shasum -a 256 "$OC_NATIVE_OMO_PATH" | awk "{print \$1}"); source "$REPO/lib/common.sh"; oc_provision_native_omo_alias "$REPO"; state=$(oc_native_omo_alias_state); backup=$(find "$HOME/.opencode-backups" -name omo.jsonc -type f | head -1); meta=$(find "$HOME/.opencode-backups" -name openconfig-native-omo-migration.json -type f | head -1); test "$state" = alias && test -n "$backup" && test -n "$meta" && python3 - "$backup" "$meta" "$original_sha" "$OC_NATIVE_OMO_PATH" "$original_copy" <<"PY"
import hashlib,json,sys
backup,meta,original,native,original_copy=sys.argv[1:]
payload=json.load(open(meta))
assert payload["sha256"] == original == hashlib.sha256(open(backup,"rb").read()).hexdigest()
assert payload["mode"] == "640"
assert open(backup,"rb").read() == open(original_copy,"rb").read()
target=open(native,encoding="utf-8").read()
assert "codex" in target and "_migrations" in target and "[opencode]" in target
PY
before=$(find "$HOME/.opencode-backups" -name omo.jsonc -type f | wc -l | tr -d " "); oc_provision_native_omo_alias "$REPO"; after=$(find "$HOME/.opencode-backups" -name omo.jsonc -type f | wc -l | tr -d " "); test "$before" = "$after"; printf ok')"
if [[ "$alias_result" == ok ]]; then ok "native alias migration backs up hash/mode and is idempotent"; else bad "native alias migration"; fi
# A post-move metadata failure must not manufacture an alias or claim success.
# The original bytes stay recoverable in the governed backup root.
META_FAIL_HOME="$TMP/metadata-fail-home"; META_FAIL_STATE="$META_FAIL_HOME/.local/state/openconfig"; META_FAIL_NATIVE="$META_FAIL_HOME/.omo/omo.jsonc"
mkdir -p "$(dirname "$META_FAIL_NATIVE")"
printf '// preserve exactly\n{\n  "codex": {"keep": true},\n}\n' >"$META_FAIL_NATIVE"
chmod 640 "$META_FAIL_NATIVE"
cp "$META_FAIL_NATIVE" "$META_FAIL_HOME/original.jsonc"
if HOME="$META_FAIL_HOME" XDG_STATE_HOME="$META_FAIL_HOME/.local/state" OC_NATIVE_OMO_PATH="$META_FAIL_NATIVE" OC_RUNTIME_PROMPT_DIR="$TMP/metadata-fail-prompts" REPO="$REPO" \
  bash -c 'set -e; source "$REPO/lib/common.sh"; python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" prepare-native-alias >/dev/null; OC_NATIVE_OMO_METADATA_FAIL=1 oc_provision_native_omo_alias "$REPO"' >/dev/null 2>&1; then
  bad "native metadata-write failure refuses alias"
else
  meta_fail_backup="$(find "$META_FAIL_HOME/.opencode-backups" -name omo.jsonc -type f | head -1)"
  if [[ ! -L "$META_FAIL_NATIVE" && -f "$META_FAIL_NATIVE" && -n "$meta_fail_backup" ]] \
    && cmp -s "$META_FAIL_HOME/original.jsonc" "$meta_fail_backup" \
    && cmp -s "$META_FAIL_HOME/original.jsonc" "$META_FAIL_NATIVE" \
    && HOME="$META_FAIL_HOME" XDG_STATE_HOME="$META_FAIL_HOME/.local/state" OC_NATIVE_OMO_PATH="$META_FAIL_NATIVE" OC_RUNTIME_PROMPT_DIR="$TMP/metadata-fail-prompts" REPO="$REPO" \
      bash -c 'source "$REPO/lib/common.sh"; oc_provision_native_omo_alias "$REPO"' >/dev/null 2>&1 \
    && [[ -L "$META_FAIL_NATIVE" ]]; then
    ok "native metadata-write failure preserves regular source and recoverable retry"
  else
    bad "native metadata-write failure backup recovery"
  fi
fi
ALIAS_TARGET="$(realpath "$ALIAS_NATIVE")"
rm -f "$ALIAS_TARGET"
alias_state_broken="$(HOME="$ALIAS_HOME" XDG_STATE_HOME="$ALIAS_HOME/.local/state" OC_NATIVE_OMO_PATH="$ALIAS_NATIVE" REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_native_omo_alias_state')"
printf '{"not_opencode":true}\n' >"$ALIAS_TARGET"
alias_state_invalid="$(HOME="$ALIAS_HOME" XDG_STATE_HOME="$ALIAS_HOME/.local/state" OC_NATIVE_OMO_PATH="$ALIAS_NATIVE" REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_native_omo_alias_state')"
if [[ "$alias_state_broken" == broken-alias && "$alias_state_invalid" == invalid-alias ]]; then ok "broken and invalid native aliases fail closed"; else bad "native alias broken-state detection"; fi
rm -f "$ALIAS_NATIVE"; printf '{"[opencode]":{}}\n' >"$ALIAS_NATIVE"; printf '{"pending":true}\n' >"$(dirname "$ALIAS_NATIVE")/.migration-journal.json"
if HOME="$ALIAS_HOME" XDG_STATE_HOME="$ALIAS_HOME/.local/state" OC_NATIVE_OMO_PATH="$ALIAS_NATIVE" REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_provision_native_omo_alias "$REPO"' >/dev/null 2>&1; then
  bad "native alias migration journal refusal"
else
  ok "native alias migration refuses pending OmO journal"
fi
# Applied markers are written only after the existing bridge health/model proof.
if ! grep -qF 'lsof -tiTCP:4097' "$REPO/runtime-profile.sh" \
  && grep -qF 'drains active Responses handlers on SIGTERM' "$REPO/runtime-profile.sh"; then
  ok "profile activation leaves OpenCode lifecycle to the draining bridge"
else
  bad "profile activation must not kill the bridge-owned OpenCode child directly"
fi
BRIDGE_FAKE="$TMP/bridge-fake"; mkdir -p "$BRIDGE_FAKE"
cat >"$BRIDGE_FAKE/launchctl" <<'SH'
#!/bin/sh
case "$1" in
  print) printf '    state = running\n    pid = %s\n' "${FAKE_LAUNCHD_PID:-$PPID}"; exit 0;;
  list) printf '%s 0 com.arnaud.opencode-codex-bridge\n' "${FAKE_LAUNCHD_PID:-$PPID}"; exit 0;;
  kickstart)
    [ "${FAKE_KICKSTART_RC:-0}" = 0 ] || exit "${FAKE_KICKSTART_RC}"
    state="${FAKE_BRIDGE_STATE:?}"; count=0
    [ -f "$state" ] && count="$(cat "$state")"
    [ "${FAKE_STALE_INSTANCE:-0}" = 1 ] && printf '%s\n' "$count" > "$state.previous"
    printf '%s\n' "$((count + 1))" > "$state"
    exit 0;;
  *) exit 0;;
esac
SH
cat >"$BRIDGE_FAKE/curl" <<'SH'
#!/bin/sh
case "$*" in
  *"/agent"*) printf '[{"name":"codex-router","modelID":"z-ai/glm-5.3"}]\n';;
  *"/healthz"*)
    [ "${FAKE_HEALTH_FAIL:-0}" = 1 ] && exit 1
    state="${FAKE_BRIDGE_STATE:?}"; count=0
    [ -f "$state" ] && count="$(cat "$state")"
    if [ "${FAKE_STALE_INSTANCE:-0}" = 1 ] && [ -f "$state.previous" ]; then count="$(cat "$state.previous")"; fi
    instance="$(printf '00000000-0000-4000-8000-%012d' "$count")"
    gateway_health=',"gateway_health":{"catalog_ok":null,"inference_last_success_at":null,"breaker_state":"closed","privacy_eligible":true,"enforcement":"passive"}'
    idempotency_ledger=',"idempotency_ledger":{"healthy":true,"error":null,"entries":0,"max_entries":10000,"remaining_capacity":10000}'
    case "${FAKE_GATEWAY_HEALTH:-valid}" in
      missing) gateway_health='';;
      malformed) gateway_health=',"gateway_health":{"catalog_ok":"unknown","inference_last_success_at":null,"breaker_state":"closed","privacy_eligible":true,"enforcement":"passive"}';;
    esac
    case "${FAKE_IDEMPOTENCY_LEDGER:-valid}" in
      missing) idempotency_ledger='';;
      malformed) idempotency_ledger=',"idempotency_ledger":{"healthy":true,"error":null,"entries":1,"max_entries":10000,"remaining_capacity":10000}';;
    esac
    if [ "${FAKE_PREVIOUS_503:-0}" = 1 ] && [ ! -f "$state.previous" ]; then
      printf '{"schema_version":2,"service":"opencode-codex-bridge","launchd_label":"com.arnaud.opencode-codex-bridge","instance_id":"%s","pid":%s,"started_at":"2026-08-24T12:00:00Z","ok":false,"model":"opencode/router","active_executions":%s,"accepting_executions":true,"opencode":null,"error":"upstream recovering"%s%s}\n' "$instance" "${FAKE_HEALTH_PID:-${FAKE_LAUNCHD_PID:-$PPID}}" "${FAKE_ACTIVE_EXECUTIONS:-0}" "$gateway_health" "$idempotency_ledger"
      case "$*" in *-fsS*) exit 22;; esac
    else
      printf '{"schema_version":2,"service":"opencode-codex-bridge","launchd_label":"com.arnaud.opencode-codex-bridge","instance_id":"%s","pid":%s,"started_at":"2026-08-24T12:00:00Z","ok":true,"model":"opencode/router","active_executions":%s,"accepting_executions":true,"opencode":{"healthy":true},"error":null%s%s}\n' "$instance" "${FAKE_HEALTH_PID:-${FAKE_LAUNCHD_PID:-$PPID}}" "${FAKE_ACTIVE_EXECUTIONS:-0}" "$gateway_health" "$idempotency_ledger"
    fi;;
  *) [ "${FAKE_HEALTH_FAIL:-0}" = 1 ] && exit 1 || exit 0;;
esac
SH
cat >"$BRIDGE_FAKE/lsof" <<'SH'
#!/bin/sh
printf '%s\n' "${FAKE_LISTENER_PID:-${FAKE_LAUNCHD_PID:-$PPID}}"
SH
printf '#!/bin/sh\nexit 0\n' >"$BRIDGE_FAKE/sleep"
chmod +x "$BRIDGE_FAKE"/*
/bin/sleep 300 & fake_bridge_pid=$!
export FAKE_LAUNCHD_PID="$fake_bridge_pid"
applied_cmd=(python3 "$REPO/scripts/runtime-profile.py" --repo "$REPO" applied)
# The shared bridge activation lock must reject a concurrent profile switch
# before it renders/mutates runtime state. A matching token never bypasses it.
ACTIVATION_LOCK_DIR="$TMP/bridge-activation.lock"; mkdir -p "$ACTIVATION_LOCK_DIR"
printf 'parent-token\npid=%s\n' "$$" >"$ACTIVATION_LOCK_DIR/owner"
LOCKED_STATE="$TMP/locked-state"; LOCKED_NATIVE="$TMP/locked-native/omo.jsonc"
owner_matches_parent_contract() {
  [[ "$(sed -n '1p' "$ACTIVATION_LOCK_DIR/owner")" == "parent-token" ]]
  [[ "$(sed -n '2p' "$ACTIVATION_LOCK_DIR/owner")" == "pid=$$" ]]
  [[ -z "$(sed -n '3p' "$ACTIVATION_LOCK_DIR/owner")" ]]
}
lock_contract_ok=1
if PATH="$BRIDGE_FAKE:$PATH" OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR="$ACTIVATION_LOCK_DIR" FAKE_BRIDGE_STATE="$TMP/locked-bridge-state" OC_RUNTIME_STATE_DIR="$LOCKED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/locked-prompts" OC_NATIVE_OMO_PATH="$LOCKED_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  lock_contract_ok=0
fi
owner_matches_parent_contract || lock_contract_ok=0
[[ ! -e "$LOCKED_STATE" ]] || lock_contract_ok=0
for owner_pid in 99999999 malformed; do
  printf 'parent-token\npid=%s\n' "$owner_pid" >"$ACTIVATION_LOCK_DIR/owner"
  if PATH="$BRIDGE_FAKE:$PATH" OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR="$ACTIVATION_LOCK_DIR" OPENCODE_BRIDGE_ACTIVATION_LOCK_TOKEN=parent-token FAKE_BRIDGE_STATE="$TMP/rejected-owner-bridge-state" OC_RUNTIME_STATE_DIR="$TMP/rejected-owner-state" OC_RUNTIME_PROMPT_DIR="$TMP/rejected-owner-prompts" OC_NATIVE_OMO_PATH="$TMP/rejected-owner-native/omo.jsonc" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
    lock_contract_ok=0
  fi
done
/bin/sleep 30 & lock_sibling_pid=$!
printf 'parent-token\npid=%s\n' "$lock_sibling_pid" >"$ACTIVATION_LOCK_DIR/owner"
if PATH="$BRIDGE_FAKE:$PATH" OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR="$ACTIVATION_LOCK_DIR" OPENCODE_BRIDGE_ACTIVATION_LOCK_TOKEN=parent-token FAKE_BRIDGE_STATE="$TMP/sibling-owner-bridge-state" OC_RUNTIME_STATE_DIR="$TMP/sibling-owner-state" OC_RUNTIME_PROMPT_DIR="$TMP/sibling-owner-prompts" OC_NATIVE_OMO_PATH="$TMP/sibling-owner-native/omo.jsonc" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  lock_contract_ok=0
fi
kill "$lock_sibling_pid" 2>/dev/null || true
printf 'parent-token\npid=%s\n' "$$" >"$ACTIVATION_LOCK_DIR/owner"
if PATH="$BRIDGE_FAKE:$PATH" OPENCODE_BRIDGE_ACTIVATION_LOCK_DIR="$ACTIVATION_LOCK_DIR" OPENCODE_BRIDGE_ACTIVATION_LOCK_TOKEN=parent-token FAKE_BRIDGE_STATE="$TMP/inherited-bridge-state" OC_RUNTIME_STATE_DIR="$TMP/inherited-state" OC_RUNTIME_PROMPT_DIR="$TMP/inherited-prompts" OC_NATIVE_OMO_PATH="$TMP/inherited-native/omo.jsonc" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  lock_contract_ok=0
fi
owner_matches_parent_contract || lock_contract_ok=0
rm -f "$ACTIVATION_LOCK_DIR/owner"; rmdir "$ACTIVATION_LOCK_DIR"
if [[ $lock_contract_ok -eq 1 ]]; then ok "bridge activation lock rejects races and preserves inherited ownership"; else bad "bridge activation lock ownership"; fi
ACTIVE_REFUSAL_STATE="$TMP/active-refusal-state"; ACTIVE_REFUSAL_NATIVE="$TMP/active-refusal-native/omo.jsonc"
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$TMP/active-refusal-bridge" FAKE_ACTIVE_EXECUTIONS=1 OC_RUNTIME_STATE_DIR="$ACTIVE_REFUSAL_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/active-refusal-prompts" OC_NATIVE_OMO_PATH="$ACTIVE_REFUSAL_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "profile activation refuses to restart an active bridge"
elif [[ ! -e "$ACTIVE_REFUSAL_STATE" && ! -e "$ACTIVE_REFUSAL_NATIVE" ]]; then
  ok "profile activation refuses active executions before runtime mutation"
else
  bad "active-execution refusal must preserve runtime state"
fi
APPLIED_STATE="$TMP/applied-state"; APPLIED_NATIVE="$TMP/applied-native/omo.jsonc"
APPLIED_BRIDGE_STATE="$TMP/applied-bridge-state"
PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$APPLIED_BRIDGE_STATE" FAKE_HEALTH_FAIL=0 FAKE_KICKSTART_RC=0 OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null
applied_generation_before="$(realpath "$APPLIED_STATE/compat/current")"
if PATH="$BRIDGE_FAKE:$PATH" OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" env normal >/dev/null \
  && [[ "$applied_generation_before" == "$(realpath "$APPLIED_STATE/compat/current")" ]] \
  && PATH="$BRIDGE_FAKE:$PATH" OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "${applied_cmd[@]}" | grep -q '"profile": "normal"'; then
  ok "verified bridge switch writes; ensure/current are generation no-ops"
else bad "verified bridge applied marker"; fi
applied_identity="$(OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" identity)"
applied_marker="$(OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "${applied_cmd[@]}")"
stale_generation="$(python3 - "$applied_marker" <<'PY'
import json,sys
value=json.loads(sys.argv[1]); value['generation']='stale-generation'; print(json.dumps(value))
PY
)"
old_schema="$(python3 - "$applied_marker" <<'PY'
import json,sys
value=json.loads(sys.argv[1]); value['schema_version']=2; print(json.dumps(value))
PY
)"
if REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_applied_identity_matches "$1" "$2"' _ "$applied_marker" "$applied_identity" \
  && ! REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_applied_identity_matches "$1" "$2"' _ "$stale_generation" "$applied_identity" \
  && ! REPO="$REPO" bash -c 'source "$REPO/lib/common.sh"; oc_applied_identity_matches "$1" "$2"' _ "$old_schema" "$applied_identity"; then
  ok "applied marker binds v3 runtime/compat identity and rejects stale generation/schema"
else
  bad "applied marker complete identity"
fi
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$APPLIED_BRIDGE_STATE" FAKE_KICKSTART_RC=1 OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "same-profile kickstart failure clears applied marker"
elif [[ "$(OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "${applied_cmd[@]}")" == null ]]; then
  ok "same-profile kickstart failure clears applied marker"
else bad "same-profile kickstart marker"; fi
PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$APPLIED_BRIDGE_STATE" FAKE_HEALTH_FAIL=0 FAKE_KICKSTART_RC=0 OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$APPLIED_BRIDGE_STATE" FAKE_HEALTH_FAIL=1 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "same-profile preflight health failure preserves applied marker"
elif [[ "$(OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "${applied_cmd[@]}")" != null ]]; then
  ok "same-profile preflight health failure preserves applied marker"
else bad "same-profile preflight health marker"; fi
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$APPLIED_BRIDGE_STATE" FAKE_KICKSTART_RC=1 OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "$REPO/runtime-profile.sh" pentest >/dev/null 2>&1; then
  bad "profile change invalidates applied marker before failed restart"
elif [[ "$(OC_RUNTIME_STATE_DIR="$APPLIED_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/applied-prompts" OC_NATIVE_OMO_PATH="$APPLIED_NATIVE" "${applied_cmd[@]}")" == null ]]; then
  ok "profile change invalidates applied marker before failed restart"
else bad "profile change marker invalidation"; fi
FAIL_STATE="$TMP/applied-kickstart"; FAIL_NATIVE="$TMP/applied-kickstart-native/omo.jsonc"; FAIL_BRIDGE_STATE="$TMP/applied-kickstart-bridge"
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$FAIL_BRIDGE_STATE" FAKE_KICKSTART_RC=1 OC_RUNTIME_STATE_DIR="$FAIL_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/fail-prompts" OC_NATIVE_OMO_PATH="$FAIL_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "kickstart failure exits nonzero without applied marker"
elif [[ "$(OC_RUNTIME_STATE_DIR="$FAIL_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/fail-prompts" OC_NATIVE_OMO_PATH="$FAIL_NATIVE" "${applied_cmd[@]}")" == null ]]; then
  ok "kickstart failure exits nonzero without applied marker"
else bad "kickstart failure marker"; fi
TIMEOUT_STATE="$TMP/applied-timeout"; TIMEOUT_NATIVE="$TMP/applied-timeout-native/omo.jsonc"; TIMEOUT_BRIDGE_STATE="$TMP/applied-timeout-bridge"
if PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$TIMEOUT_BRIDGE_STATE" FAKE_HEALTH_FAIL=1 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 OC_RUNTIME_STATE_DIR="$TIMEOUT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/timeout-prompts" OC_NATIVE_OMO_PATH="$TIMEOUT_NATIVE" "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "health timeout exits nonzero without applied marker"
elif [[ "$(OC_RUNTIME_STATE_DIR="$TIMEOUT_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/timeout-prompts" OC_NATIVE_OMO_PATH="$TIMEOUT_NATIVE" "${applied_cmd[@]}")" == null ]]; then
  ok "health timeout exits nonzero without applied marker"
else bad "health timeout marker"; fi
# Health metadata is a strict compatibility contract: a valid passive gateway
# snapshot is required before runtime-profile writes its applied proof.
GATEWAY_STATE="$TMP/gateway-schema-state"; GATEWAY_NATIVE="$TMP/gateway-schema-native/omo.jsonc"; GATEWAY_BRIDGE_STATE="$TMP/gateway-schema-bridge"
gateway_env=(PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$GATEWAY_BRIDGE_STATE" OC_RUNTIME_STATE_DIR="$GATEWAY_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/gateway-schema-prompts" OC_NATIVE_OMO_PATH="$GATEWAY_NATIVE")
gateway_schema_ok=1
for gateway_case in missing malformed; do
  env "${gateway_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null || gateway_schema_ok=0
  if env "${gateway_env[@]}" FAKE_GATEWAY_HEALTH="$gateway_case" OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then gateway_schema_ok=0; fi
  [[ "$(OC_RUNTIME_STATE_DIR="$GATEWAY_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/gateway-schema-prompts" OC_NATIVE_OMO_PATH="$GATEWAY_NATIVE" "${applied_cmd[@]}")" == null ]] || gateway_schema_ok=0
done
if [[ $gateway_schema_ok -eq 1 ]]; then ok "bridge applied proof requires exact passive gateway health metadata"; else bad "bridge gateway health schema proof"; fi
# The durable admission ledger is part of readiness, not optional diagnostic
# decoration. Missing or internally inconsistent capacity must clear proof.
LEDGER_STATE="$TMP/ledger-schema-state"; LEDGER_NATIVE="$TMP/ledger-schema-native/omo.jsonc"; LEDGER_BRIDGE_STATE="$TMP/ledger-schema-bridge"
ledger_env=(PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$LEDGER_BRIDGE_STATE" OC_RUNTIME_STATE_DIR="$LEDGER_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/ledger-schema-prompts" OC_NATIVE_OMO_PATH="$LEDGER_NATIVE")
ledger_schema_ok=1
for ledger_case in missing malformed; do
  env "${ledger_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null || ledger_schema_ok=0
  if env "${ledger_env[@]}" FAKE_IDEMPOTENCY_LEDGER="$ledger_case" OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then ledger_schema_ok=0; fi
  [[ "$(OC_RUNTIME_STATE_DIR="$LEDGER_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/ledger-schema-prompts" OC_NATIVE_OMO_PATH="$LEDGER_NATIVE" "${applied_cmd[@]}")" == null ]] || ledger_schema_ok=0
done
if [[ $ledger_schema_ok -eq 1 ]]; then ok "bridge applied proof requires a consistent durable ledger"; else bad "bridge idempotency ledger health schema proof"; fi
# A stale responder, a forged health pid, or a listener owned by another pid
# must never be promoted to applied proof after an explicit profile switch.
PROOF_STATE="$TMP/proof-state"; PROOF_NATIVE="$TMP/proof-native/omo.jsonc"; PROOF_BRIDGE_STATE="$TMP/proof-bridge-state"
proof_env=(PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$PROOF_BRIDGE_STATE" OC_RUNTIME_STATE_DIR="$PROOF_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/proof-prompts" OC_NATIVE_OMO_PATH="$PROOF_NATIVE")
env "${proof_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null
proof_ok=1
if env "${proof_env[@]}" FAKE_STALE_INSTANCE=1 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then proof_ok=0; fi
[[ "$(OC_RUNTIME_STATE_DIR="$PROOF_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/proof-prompts" OC_NATIVE_OMO_PATH="$PROOF_NATIVE" "${applied_cmd[@]}")" == null ]] || proof_ok=0
env "${proof_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null || proof_ok=0
if env "${proof_env[@]}" FAKE_HEALTH_PID=9999 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then proof_ok=0; fi
[[ "$(OC_RUNTIME_STATE_DIR="$PROOF_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/proof-prompts" OC_NATIVE_OMO_PATH="$PROOF_NATIVE" "${applied_cmd[@]}")" == null ]] || proof_ok=0
env "${proof_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null || proof_ok=0
if env "${proof_env[@]}" FAKE_LISTENER_PID=9999 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then proof_ok=0; fi
[[ "$(OC_RUNTIME_STATE_DIR="$PROOF_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/proof-prompts" OC_NATIVE_OMO_PATH="$PROOF_NATIVE" "${applied_cmd[@]}")" == null ]] || proof_ok=0
if [[ $proof_ok -eq 1 ]]; then ok "bridge applied proof rejects stale instance and pid/listener ownership drift"; else bad "bridge applied proof boundary"; fi
UNREADY_STATE="$TMP/unready-proof-state"; UNREADY_NATIVE="$TMP/unready-proof-native/omo.jsonc"; UNREADY_BRIDGE_STATE="$TMP/unready-proof-bridge"
unready_env=(PATH="$BRIDGE_FAKE:$PATH" FAKE_BRIDGE_STATE="$UNREADY_BRIDGE_STATE" OC_RUNTIME_STATE_DIR="$UNREADY_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/unready-proof-prompts" OC_NATIVE_OMO_PATH="$UNREADY_NATIVE")
env "${unready_env[@]}" "$REPO/runtime-profile.sh" normal >/dev/null
rm -f "$UNREADY_BRIDGE_STATE.previous"
if env "${unready_env[@]}" FAKE_PREVIOUS_503=1 FAKE_STALE_INSTANCE=1 OPENCONFIG_BRIDGE_HEALTH_ATTEMPTS=1 "$REPO/runtime-profile.sh" normal >/dev/null 2>&1; then
  bad "unready previous bridge blocks mutation before restart"
elif [[ "$(OC_RUNTIME_STATE_DIR="$UNREADY_STATE" OC_RUNTIME_PROMPT_DIR="$TMP/unready-proof-prompts" OC_NATIVE_OMO_PATH="$UNREADY_NATIVE" "${applied_cmd[@]}")" != null ]]; then
  ok "unready previous bridge blocks mutation and preserves applied proof"
else bad "unready previous bridge preflight marker"; fi
if [[ -L "$compat_current" && -x "$compat_current/oc" && -f "$compat_current/opencode.json" \
  && -L "$compat_current/lib" && -L "$compat_current/.openconfig-source" ]] \
  && ! oc_link_points_to "$compat_current" "$REPO"; then
  ok "compat home exposes wrappers and rendered config without aliasing source"
else bad "compat home shape"; fi
legacy_link="$TMP/legacy-config/opencode"; mkdir -p "$(dirname "$legacy_link")"; ln -s "$REPO" "$legacy_link"
repo_hash_before="$(git -C "$REPO" hash-object opencode.json)"
ln -sfn "$compat_current" "$legacy_link"
repo_hash_after="$(git -C "$REPO" hash-object opencode.json)"
if oc_link_points_to "$legacy_link" "$compat_current" && [[ "$repo_hash_before" == "$repo_hash_after" ]]; then
  ok "legacy source link migration preserves source hashes"
else bad "legacy source link migration"; fi

if command -v zsh >/dev/null 2>&1; then
  ZHOME="$TMP/zhome"; mkdir -p "$ZHOME/.config"
  ln -s "$compat_current" "$ZHOME/.config/opencode"
  z_out="$(HOME="$ZHOME" zsh -f -c 'source "$HOME/.config/opencode/zshrc.snippet"; _oc_resolve_start_dir "'"$REPO"'"' 2>/dev/null || true)"
  if [[ "$z_out" == *"/Projects/workspace" ]]; then ok "zsh redirects canonical source cwd through .openconfig-source"; else bad "zsh source cwd redirect"; fi
fi

LOG="$TMP/opencode.log"
cat >"$LOG" <<'EOF'
level=ERROR message="Expected a string starting with 'ses'"
level=ERROR tool=background_output message="Expected a string starting with 'bg'"
level=WARN tool=background_output block=true duration=712.7s
EOF
out="$(oc_log_misuse_report "$LOG")"
expect_text "ses misuse remediation" "$out" "requires the real ses_…"
expect_text "bg misuse remediation" "$out" "accepts only real bg_…"
expect_text "blocking poll remediation" "$out" "consume the completion notification"

printf '\nResult: %d passed · %d failed\n\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
