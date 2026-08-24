#!/usr/bin/env python3
"""Bounded live canary for Codex entry -> OmO task/category routing.

The default mode is a zero-cost plan. --execute creates isolated OpenCode
sessions against a temporary synthetic fixture, then grades metadata in the
local OpenCode SQLite database. Prompt and response content are never saved.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_DB = pathlib.Path.home() / ".local/share/opencode/opencode.db"
DEFAULT_RESULTS = pathlib.Path.home() / ".cache/openconfig/evals/orchestration-routing"
DEFAULT_SERVER = "http://127.0.0.1:4097"
DEFAULT_PASSWORD_FILE = pathlib.Path.home() / ".local/state/opencode-codex-bridge/opencode-server-password"
DEFAULT_AGENT = "codex-router"
OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"


def dotenv_value(path: pathlib.Path, key: str) -> str:
    if not path.is_file():
        return ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() != key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        return value
    return ""


def openrouter_credits(key: str) -> dict[str, float]:
    req = urllib.request.Request(
        OPENROUTER_CREDITS_URL,
        headers={"Authorization": f"Bearer {key}", "X-Title": "OpenConfig orchestration eval"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)["data"]
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"OpenRouter credits HTTP {exc.code}: {detail}") from exc
    total = float(data["total_credits"])
    used = float(data["total_usage"])
    return {"total": total, "used": used, "remaining": total - used}


def opencode_server_password() -> str:
    value = os.environ.get("OPENCODE_SERVER_PASSWORD", "").strip()
    if value:
        return value
    password_file = pathlib.Path(
        os.environ.get("OPENCODE_SERVER_PASSWORD_FILE", str(DEFAULT_PASSWORD_FILE))
    ).expanduser()
    if password_file.is_file():
        return password_file.read_text(encoding="utf-8").strip()
    return ""


def opencode_auth_headers() -> dict[str, str]:
    password = opencode_server_password()
    if not password:
        return {}
    username = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def load_cases() -> dict:
    suite = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    profiles = json.loads((REPO / "runtime-profile.json").read_text(encoding="utf-8"))
    state_root = pathlib.Path(
        os.environ.get(
            "OC_RUNTIME_STATE_DIR",
            str(pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local/state")) / "openconfig"),
        )
    ).expanduser()
    active_path = state_root / "active-profile"
    active = active_path.read_text(encoding="utf-8").strip() if active_path.is_file() else profiles.get("default_profile", "normal")
    if active not in ("normal", "pentest"):
        raise ValueError(f"invalid active profile state: {active!r}")
    selected = profiles.get(active) or {}
    categories = selected.get("categories") or {}
    for case in suite["cases"]:
        category = case.get("expected_category")
        if not category:
            case["expected_routes"] = []
            continue
        route = categories.get(category)
        if not isinstance(route, dict):
            raise ValueError(f"active profile {active} has no category route for {category}")
        refs = [route.get("model"), *(route.get("fallback_models") or [])]
        expected_routes = []
        for ref in refs:
            if not isinstance(ref, str) or "/" not in ref:
                raise ValueError(f"invalid model route for {active}.{category}: {ref!r}")
            provider, model = ref.split("/", 1)
            expected_routes.append({"provider": provider, "model": model})
        case["expected_routes"] = expected_routes
    suite["active_profile"] = active
    return suite


def select_cases(suite: dict, requested: str | None) -> list[dict]:
    cases = suite["cases"]
    if not requested:
        return [case for case in cases if case["id"] == "security-recon"]
    wanted = {item.strip() for item in requested.split(",") if item.strip()}
    known = {case["id"] for case in cases}
    unknown = wanted - known
    if unknown:
        raise ValueError(f"unknown cases: {', '.join(sorted(unknown))}")
    return [case for case in cases if case["id"] in wanted]


def request(
    server: str,
    path: str,
    *,
    directory: pathlib.Path,
    method: str = "GET",
    body: dict | None = None,
    timeout: float = 10,
) -> object | None:
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "content-type": "application/json",
        "x-opencode-directory": urllib.parse.quote(str(directory), safe=""),
        **opencode_auth_headers(),
    }
    req = urllib.request.Request(server.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"OpenCode HTTP {exc.code}: {detail}") from exc
    if not raw:
        return None
    return json.loads(raw)


def create_session(server: str, directory: pathlib.Path, title: str) -> str:
    payload = request(server, "/session", directory=directory, method="POST", body={"title": title})
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
        raise RuntimeError("OpenCode did not return a session id")
    return payload["id"]


def abort_session(server: str, directory: pathlib.Path, session_id: str) -> None:
    try:
        request(server, f"/session/{urllib.parse.quote(session_id)}/abort", directory=directory, method="POST")
    except Exception:
        pass


def connect_readonly(path: pathlib.Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def session_tree_cost(db_path: pathlib.Path, session_id: str) -> float:
    with connect_readonly(db_path) as db:
        row = db.execute(
            """
            WITH RECURSIVE tree(id) AS (
              SELECT ? UNION ALL
              SELECT s.id FROM session s JOIN tree ON s.parent_id = tree.id
            )
            SELECT COALESCE(SUM(CAST(json_extract(m.data, '$.cost') AS REAL)), 0)
            FROM message m JOIN tree ON tree.id = m.session_id
            """,
            (session_id,),
        ).fetchone()
    return float(row[0] or 0.0)


def wait_for_completion(
    server: str,
    directory: pathlib.Path,
    session_id: str,
    db_path: pathlib.Path,
    timeout: float,
    run_budget: float,
) -> float:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cost = session_tree_cost(db_path, session_id)
        if cost > run_budget:
            abort_session(server, directory, session_id)
            raise RuntimeError(f"recorded cost ${cost:.4f} crossed ${run_budget:.2f} run budget")
        messages = request(server, f"/session/{urllib.parse.quote(session_id)}/message", directory=directory)
        statuses = request(server, "/session/status", directory=directory)
        assistants = [item for item in messages if item.get("info", {}).get("role") == "assistant"] if isinstance(messages, list) else []
        latest = assistants[-1] if assistants else None
        status = statuses.get(session_id) if isinstance(statuses, dict) else None
        active = bool(status and status.get("type") != "idle")
        if latest and latest.get("info", {}).get("error"):
            raise RuntimeError("OpenCode returned an assistant error")
        if latest and latest.get("info", {}).get("finish") == "stop" and not active:
            return session_tree_cost(db_path, session_id)
        time.sleep(0.5)
    abort_session(server, directory, session_id)
    raise RuntimeError(f"OpenCode did not finish within {timeout:.0f}s")


def collect_evidence(db_path: pathlib.Path, session_id: str) -> dict:
    with connect_readonly(db_path) as db:
        root_row = db.execute(
            "SELECT agent, model FROM session WHERE id=?",
            (session_id,),
        ).fetchone() or (None, None)
        task_rows = db.execute(
            """
            SELECT json_extract(data, '$.state.input.category'),
                   json_extract(data, '$.state.input.load_skills'),
                   json_extract(data, '$.state.input.subagent_type'),
                   json_extract(data, '$.state.status')
            FROM part
            WHERE session_id=? AND json_extract(data, '$.type')='tool'
              AND json_extract(data, '$.tool')='task'
            ORDER BY time_created
            """,
            (session_id,),
        ).fetchall()
        child_rows = db.execute(
            "SELECT id, agent, model FROM session WHERE parent_id=? ORDER BY time_created",
            (session_id,),
        ).fetchall()
        children = []
        for child_id, agent, raw_model in child_rows:
            model = json.loads(raw_model) if raw_model else {}
            terminal = db.execute(
                """
                SELECT json_extract(data, '$.providerID'), json_extract(data, '$.modelID'),
                       json_extract(data, '$.finish'), json_extract(data, '$.error.name')
                FROM message WHERE session_id=? AND json_extract(data, '$.role')='assistant'
                ORDER BY time_created DESC LIMIT 1
                """,
                (child_id,),
            ).fetchone() or (None, None, None, None)
            children.append(
                {
                    "id": child_id,
                    "agent": agent,
                    "session_provider": model.get("providerID"),
                    "session_model": model.get("id"),
                    "terminal_provider": terminal[0],
                    "terminal_model": terminal[1],
                    "terminal_finish": terminal[2],
                    "terminal_error": terminal[3],
                }
            )
    tasks = []
    for category, raw_skills, subagent_type, status in task_rows:
        try:
            skills = json.loads(raw_skills) if raw_skills else []
        except json.JSONDecodeError:
            skills = []
        tasks.append(
            {
                "category": category,
                "load_skills": skills,
                "subagent_type": subagent_type,
                "status": status,
            }
        )
    try:
        root_model = json.loads(root_row[1]) if root_row[1] else {}
    except json.JSONDecodeError:
        root_model = {}
    return {
        "root": {
            "agent": root_row[0],
            "provider": root_model.get("providerID"),
            "model": root_model.get("id"),
        },
        "tasks": tasks,
        "children": children,
    }


def grade(case: dict, evidence: dict) -> dict:
    tasks = evidence["tasks"]
    children = evidence["children"]
    expected_category = case["expected_category"]
    if expected_category is None:
        checks = {
            "entry_agent": evidence.get("root", {}).get("agent") == DEFAULT_AGENT,
            "no_task_category": not any(task.get("category") for task in tasks),
            "child_limit": len(children) <= case["max_children"],
        }
    else:
        matching_tasks = [task for task in tasks if task.get("category") == expected_category]
        expected_skill = case.get("expected_skill")
        explicit_skill = bool(expected_skill) and any(expected_skill in task.get("load_skills", []) for task in matching_tasks)
        category_prompt = REPO / "prompts/categories" / f"{expected_category}.md"
        embedded_skill = not expected_skill or category_prompt.is_file() and (
            f"Embedded contract: `{expected_skill}`" in category_prompt.read_text(encoding="utf-8")
        )
        expected_routes = {
            (route["provider"], route["model"])
            for route in case.get("expected_routes", [])
        }
        matching_children = [
            child
            for child in children
            if (child.get("terminal_provider"), child.get("terminal_model")) in expected_routes
            and child.get("terminal_finish") == "stop"
            and not child.get("terminal_error")
        ]
        checks = {
            "entry_agent": evidence.get("root", {}).get("agent") == DEFAULT_AGENT,
            "category_task": bool(matching_tasks),
            "specialization_contract": explicit_skill or embedded_skill,
            "specialist_child": bool(matching_children),
            "child_limit": 1 <= len(children) <= case["max_children"],
        }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "explicit_skill_loaded": any(
            case.get("expected_skill") in task.get("load_skills", [])
            for task in tasks
            if case.get("expected_skill")
        ),
    }


def run_case(
    case: dict,
    *,
    server: str,
    db_path: pathlib.Path,
    timeout: float,
    run_budget: float,
    repeat_index: int,
    agent: str,
) -> dict:
    with tempfile.TemporaryDirectory(prefix="openconfig-orchestration-") as temp:
        directory = pathlib.Path(temp)
        shutil.copytree(HERE / "fixture", directory, dirs_exist_ok=True)
        title = f"OpenConfig orchestration canary: {case['id']} #{repeat_index}"
        session_id = create_session(server, directory, title)
        started = time.monotonic()
        record = {"case": case["id"], "repeat": repeat_index, "session_id": session_id}
        try:
            request(
                server,
                f"/session/{urllib.parse.quote(session_id)}/prompt_async",
                directory=directory,
                method="POST",
                body={"agent": agent, "parts": [{"type": "text", "text": case["prompt"]}]},
            )
            cost = wait_for_completion(server, directory, session_id, db_path, timeout, run_budget)
            evidence = collect_evidence(db_path, session_id)
            record.update(
                {
                    "ok": True,
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "recorded_cost": round(cost, 9),
                    "evidence": evidence,
                    "grade": grade(case, evidence),
                }
            )
        except Exception as exc:
            abort_session(server, directory, session_id)
            record.update(
                {
                    "ok": False,
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "error": str(exc),
                }
            )
        return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="run billable local OpenCode canaries")
    parser.add_argument("--cases", help="comma-separated case ids (default: security-recon)")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--run-budget", type=float, default=0.10)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--agent", default=DEFAULT_AGENT)
    parser.add_argument("--database", type=pathlib.Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    if not 1 <= args.repeat <= 5:
        raise SystemExit("--repeat must be between 1 and 5")
    if not 0 < args.run_budget <= 1:
        raise SystemExit("--run-budget must be > 0 and <= 1")
    if not 10 <= args.timeout <= 300:
        raise SystemExit("--timeout must be between 10 and 300 seconds")
    try:
        cases = select_cases(load_cases(), args.cases)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    total_runs = len(cases) * args.repeat
    print("OpenConfig orchestration-routing canary")
    print(f"  cases: {', '.join(case['id'] for case in cases)}")
    print(f"  entry agent: {args.agent}")
    print(f"  repeats: {args.repeat} · live sessions: {total_runs}")
    print(f"  OpenRouter/recorded cost guard: ${args.run_budget:.2f} · timeout: {args.timeout:.0f}s/session")
    if not args.execute:
        print("  plan only: no OpenCode session, network call, or charge (add --execute to run)")
        return 0
    if not args.database.is_file():
        print(f"REFUSED: OpenCode database not found: {args.database}")
        return 2
    openrouter_key = os.environ.get("OPENROUTER_API_KEY") or dotenv_value(REPO / ".env", "OPENROUTER_API_KEY")
    if not openrouter_key:
        print("REFUSED: OPENROUTER_API_KEY is unavailable for the live spending guard")
        return 2
    credits_before = openrouter_credits(openrouter_key)
    if credits_before["remaining"] < args.run_budget:
        print("REFUSED: OpenRouter remaining credits are below the requested run budget")
        return 2
    health = request(args.server, "/global/health", directory=REPO)
    if not isinstance(health, dict) or not health.get("healthy"):
        print(f"REFUSED: OpenCode is not healthy at {args.server}")
        return 2
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = args.output or (DEFAULT_RESULTS / timestamp)
    output_dir.mkdir(parents=True, exist_ok=False)
    records = []
    cumulative_cost = 0.0
    credits_current = credits_before
    aborted_for_budget = False
    for repeat_index in range(1, args.repeat + 1):
        for case in cases:
            record = run_case(
                case,
                server=args.server,
                db_path=args.database,
                timeout=args.timeout,
                run_budget=max(0.001, args.run_budget - cumulative_cost),
                repeat_index=repeat_index,
                agent=args.agent,
            )
            records.append(record)
            cumulative_cost += float(record.get("recorded_cost") or 0.0)
            credits_current = openrouter_credits(openrouter_key)
            observed_openrouter_spend = max(0.0, credits_current["used"] - credits_before["used"])
            guarded_cost = max(cumulative_cost, observed_openrouter_spend)
            state = "PASS" if record.get("ok") and record.get("grade", {}).get("passed") else "FAIL"
            print(
                f"  {state}: {case['id']} #{repeat_index} · {record['elapsed_seconds']:.2f}s · "
                f"guarded ${guarded_cost:.4f}"
            )
            if guarded_cost > args.run_budget:
                aborted_for_budget = True
                print("ABORTED: the OpenRouter/recorded cost guard crossed the run budget")
                break
        if aborted_for_budget:
            break
    observed_openrouter_spend = max(0.0, credits_current["used"] - credits_before["used"])
    guarded_cost = max(cumulative_cost, observed_openrouter_spend)
    payload = {
        "schema_version": 1,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "server": args.server,
        "agent": args.agent,
        "database": str(args.database),
        "run_budget": args.run_budget,
        "recorded_cost": round(cumulative_cost, 9),
        "openrouter_before": credits_before,
        "openrouter_after": credits_current,
        "observed_openrouter_spend": round(observed_openrouter_spend, 9),
        "guarded_cost": round(guarded_cost, 9),
        "aborted_for_budget": aborted_for_budget,
        "records": records,
    }
    result_path = output_dir / "results.json"
    result_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    passed = sum(bool(record.get("ok") and record.get("grade", {}).get("passed")) for record in records)
    print(f"  result: {passed}/{len(records)} passed · evidence: {result_path}")
    return 0 if passed == len(records) and not aborted_for_budget else 1


if __name__ == "__main__":
    raise SystemExit(main())
