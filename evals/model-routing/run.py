#!/usr/bin/env python3
"""Bounded OpenRouter comparison for OpenConfig routing decisions.

The default action is a zero-cost plan. Network calls require --execute.
Campaign accounting is conservative: all OpenRouter usage observed after the
campaign starts counts against the cap, including traffic outside this script.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_RESULTS = pathlib.Path.home() / ".cache/openconfig/evals/model-routing"
CAMPAIGN_STATE = DEFAULT_RESULTS / "campaign.json"
API_BASE = "https://openrouter.ai/api/v1"

ALIASES = {
    "deepseek": "deepseek/deepseek-v4-flash",
    "kimi": "moonshotai/kimi-k3",
    "sonnet": "anthropic/claude-sonnet-5",
}

# Conservative public list prices per token. Live catalog prices replace these
# when available; ceilings keep --plan useful without a key or network.
PRICE_CEILINGS = {
    "deepseek/deepseek-v4-flash": (0.14 / 1_000_000, 0.28 / 1_000_000),
    "moonshotai/kimi-k3": (3.00 / 1_000_000, 15.00 / 1_000_000),
    "anthropic/claude-sonnet-5": (2.00 / 1_000_000, 10.00 / 1_000_000),
}


def dotenv_value(path: pathlib.Path, key: str) -> str:
    if not path.is_file():
        return ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value
    return ""


def request_json(url: str, key: str = "", body: dict | None = None, timeout: int = 180) -> dict:
    headers = {"Content-Type": "application/json", "X-Title": "OpenConfig model routing eval"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:800]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def load_cases() -> dict:
    return json.loads((HERE / "cases.json").read_text(encoding="utf-8"))


def model_specs(names: str) -> list[dict]:
    config = json.loads((REPO / "opencode.json").read_text(encoding="utf-8"))
    configured = config["provider"]["openrouter"]["models"]
    specs = []
    for raw in names.split(","):
        alias = raw.strip().lower()
        if not alias:
            continue
        key = ALIASES.get(alias, raw.strip())
        if key not in configured:
            raise SystemExit(f"unknown or unconfigured model: {raw.strip()}")
        cfg = configured[key]
        specs.append(
            {
                "alias": alias if alias in ALIASES else key,
                "config_key": key,
                "model": cfg.get("id") or key,
                "provider": (cfg.get("options") or {}).get("provider"),
            }
        )
    if not specs:
        raise SystemExit("no models selected")
    return specs


def base_model_id(model_id: str) -> str:
    return re.sub(r":(?:nitro|exacto)$", "", model_id)


def prices(specs: list[dict], key: str, online: bool) -> dict[str, tuple[float, float]]:
    result = dict(PRICE_CEILINGS)
    if online and key:
        try:
            catalog = request_json(f"{API_BASE}/models", key=key, timeout=30).get("data", [])
            for item in catalog:
                model_id = item.get("id")
                pricing = item.get("pricing") or {}
                if model_id and pricing.get("prompt") is not None and pricing.get("completion") is not None:
                    result[model_id] = (float(pricing["prompt"]), float(pricing["completion"]))
        except Exception as exc:
            print(f"warning: live pricing unavailable, using ceilings ({exc})", file=sys.stderr)
    return {spec["alias"]: result[base_model_id(spec["model"])] for spec in specs}


def credits(key: str) -> dict:
    data = request_json(f"{API_BASE}/credits", key=key, timeout=30)["data"]
    total = float(data["total_credits"])
    used = float(data["total_usage"])
    return {"total": total, "used": used, "remaining": total - used}


def estimate_tokens(text: str) -> int:
    # Deliberately conservative for English/code fixtures.
    return max(1, (len(text) + 2) // 3)


def worst_case_cost(specs: list[dict], suite: dict, price_map: dict, max_output: int) -> float:
    total = 0.0
    system = suite["system"]
    for spec in specs:
        prompt_rate, output_rate = price_map[spec["alias"]]
        for case in suite["cases"]:
            input_tokens = estimate_tokens(system + case["prompt"]) + 128
            total += input_tokens * prompt_rate + max_output * output_rate
    return total * 1.15


def parse_object(content: str) -> dict | None:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def grade(content: str, case: dict) -> dict:
    lower = content.lower()
    parsed = parse_object(content)
    expected_keys = {"verdict", "evidence", "recommendation", "tests", "uncertainty"}
    schema_ok = parsed is not None and set(parsed) == expected_keys
    arrays_ok = bool(parsed) and isinstance(parsed.get("evidence"), list) and isinstance(parsed.get("tests"), list)
    missing = [term for term in case["required_terms"] if term.lower() not in lower]
    missing_any = [
        terms
        for terms in case.get("required_any", [])
        if not any(term.lower() in lower for term in terms)
    ]
    forbidden = [term for term in case["forbidden_terms"] if term.lower() in lower]
    passed = schema_ok and arrays_ok and not missing and not missing_any and not forbidden
    return {
        "passed": passed,
        "schema_ok": schema_ok,
        "arrays_ok": arrays_ok,
        "missing_required_terms": missing,
        "missing_required_any_groups": missing_any,
        "forbidden_terms_found": forbidden,
    }


def load_campaign(current: dict, cap: float, reset: bool) -> dict:
    DEFAULT_RESULTS.mkdir(parents=True, exist_ok=True)
    if reset or not CAMPAIGN_STATE.exists():
        state = {
            "schema_version": 2,
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "starting_total_usage": current["used"],
            "campaign_budget": cap,
            "reported_eval_cost": 0.0,
        }
        CAMPAIGN_STATE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        return state
    state = json.loads(CAMPAIGN_STATE.read_text(encoding="utf-8"))
    if abs(float(state.get("campaign_budget", cap)) - cap) > 1e-9:
        raise SystemExit(
            f"campaign already uses a ${state['campaign_budget']:.2f} cap; "
            "pass that value or explicitly use --reset-campaign"
        )
    if "reported_eval_cost" not in state:
        state["schema_version"] = 2
        state["reported_eval_cost"] = 0.0
        CAMPAIGN_STATE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return state


def add_reported_cost(campaign: dict, value: float) -> None:
    """Persist response-reported cost before relying on eventually consistent credits."""
    if value <= 0:
        return
    campaign["reported_eval_cost"] = float(campaign.get("reported_eval_cost", 0.0)) + value
    campaign["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    temporary = CAMPAIGN_STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(campaign, indent=2) + "\n", encoding="utf-8")
    temporary.replace(CAMPAIGN_STATE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="perform billable calls (default is plan only)")
    parser.add_argument("--models", default="deepseek,kimi,sonnet")
    parser.add_argument("--cases", help="comma-separated case ids (default: all)")
    parser.add_argument("--max-output", type=int, default=2400)
    parser.add_argument("--run-budget", type=float, default=1.0)
    parser.add_argument("--campaign-budget", type=float, default=20.0)
    parser.add_argument("--reserve", type=float, default=2.0)
    parser.add_argument("--reset-campaign", action="store_true")
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()

    if args.max_output < 256 or args.max_output > 4096:
        raise SystemExit("--max-output must be between 256 and 4096")
    if args.run_budget <= 0 or args.campaign_budget <= 0 or args.reserve < 0:
        raise SystemExit("budgets must be positive and reserve must be non-negative")

    suite = load_cases()
    if args.cases:
        requested_cases = {item.strip() for item in args.cases.split(",") if item.strip()}
        known_cases = {case["id"] for case in suite["cases"]}
        unknown_cases = requested_cases - known_cases
        if unknown_cases:
            raise SystemExit(f"unknown cases: {', '.join(sorted(unknown_cases))}")
        suite = {**suite, "cases": [case for case in suite["cases"] if case["id"] in requested_cases]}
        if not suite["cases"]:
            raise SystemExit("no cases selected")
    specs = model_specs(args.models)
    key = os.environ.get("OPENROUTER_API_KEY") or dotenv_value(REPO / ".env", "OPENROUTER_API_KEY")
    price_map = prices(specs, key, online=args.execute)
    estimate = worst_case_cost(specs, suite, price_map, args.max_output)

    print("OpenConfig model-routing eval")
    print(f"  models: {', '.join(spec['alias'] for spec in specs)}")
    print(f"  cases: {len(suite['cases'])}")
    print(f"  max output: {args.max_output} tokens/request")
    print(f"  conservative run ceiling: ${estimate:.4f}")
    print(f"  run cap: ${args.run_budget:.2f} · campaign cap: ${args.campaign_budget:.2f} · reserve: ${args.reserve:.2f}")

    if estimate > args.run_budget:
        print("REFUSED: conservative ceiling exceeds --run-budget", file=sys.stderr)
        return 2
    if not args.execute:
        print("  plan only: no network call and no charge (add --execute to run)")
        return 0
    if not key:
        print("REFUSED: OPENROUTER_API_KEY is not configured", file=sys.stderr)
        return 2

    before = credits(key)
    campaign = load_campaign(before, args.campaign_budget, args.reset_campaign)
    observed_campaign_spent = max(0.0, before["used"] - float(campaign["starting_total_usage"]))
    reported_campaign_cost = float(campaign.get("reported_eval_cost", 0.0))
    guarded_campaign_debit = observed_campaign_spent + reported_campaign_cost
    if guarded_campaign_debit + estimate > args.campaign_budget:
        print(f"REFUSED: campaign would exceed cap (guard debit ${guarded_campaign_debit:.4f})", file=sys.stderr)
        return 2
    if before["remaining"] - reported_campaign_cost - estimate < args.reserve:
        print(f"REFUSED: run would cross the ${args.reserve:.2f} account reserve", file=sys.stderr)
        return 2

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = args.output or (DEFAULT_RESULTS / timestamp)
    output_dir.mkdir(parents=True, exist_ok=False)
    results = []
    reported_run_cost = 0.0

    for case in suite["cases"]:
        for spec in specs:
            body = {
                "model": spec["model"],
                "messages": [
                    {"role": "system", "content": suite["system"]},
                    {"role": "user", "content": case["prompt"]},
                ],
                "max_tokens": args.max_output,
                "reasoning": {"effort": "medium"},
            }
            if spec["provider"]:
                body["provider"] = spec["provider"]
            started = time.monotonic()
            record = {"case": case["id"], "model": spec["alias"], "requested_model": spec["model"]}
            try:
                response = request_json(f"{API_BASE}/chat/completions", key=key, body=body)
                elapsed = time.monotonic() - started
                message = response["choices"][0]["message"]
                content = message.get("content") or ""
                reasoning = message.get("reasoning") or ""
                usage = response.get("usage") or {}
                response_cost = float(usage.get("cost") or 0.0)
                record.update(
                    {
                        "ok": True,
                        "resolved_model": response.get("model"),
                        "provider": response.get("provider"),
                        "latency_seconds": round(elapsed, 3),
                        "usage": usage,
                        "finish_reason": response["choices"][0].get("finish_reason"),
                        "content": content,
                        "reasoning": reasoning,
                        "reasoning_details": message.get("reasoning_details") or [],
                        "grade": grade(content, case),
                    }
                )
            except Exception as exc:
                record.update({"ok": False, "error": str(exc), "latency_seconds": round(time.monotonic() - started, 3)})
            results.append(record)
            if record["ok"]:
                reported_run_cost += response_cost
                add_reported_cost(campaign, response_cost)

            current = credits(key)
            observed_run_spent = max(0.0, current["used"] - before["used"])
            observed_campaign_spent = max(0.0, current["used"] - float(campaign["starting_total_usage"]))
            guarded_run_debit = observed_run_spent + reported_run_cost
            guarded_campaign_debit = observed_campaign_spent + float(campaign["reported_eval_cost"])
            guarded_remaining = current["remaining"] - float(campaign["reported_eval_cost"])
            if guarded_run_debit > args.run_budget or guarded_campaign_debit > args.campaign_budget or guarded_remaining < args.reserve:
                payload = {
                    "schema_version": 2,
                    "aborted": True,
                    "results": results,
                    "before": before,
                    "after": current,
                    "reported_run_cost": reported_run_cost,
                    "guarded_run_debit": guarded_run_debit,
                    "guarded_campaign_debit": guarded_campaign_debit,
                }
                (output_dir / "results.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
                print("ABORTED: a spending guard was crossed", file=sys.stderr)
                return 3

    after = credits(key)
    payload = {
        "schema_version": 2,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "suite": str(HERE / "cases.json"),
        "models": specs,
        "before": before,
        "after": after,
        "reported_run_cost": round(reported_run_cost, 9),
        "observed_run_spend": round(max(0.0, after["used"] - before["used"]), 9),
        "observed_campaign_spend": round(max(0.0, after["used"] - float(campaign["starting_total_usage"])), 9),
        "reported_campaign_cost": round(float(campaign["reported_eval_cost"]), 9),
        "guarded_run_debit": round(max(0.0, after["used"] - before["used"]) + reported_run_cost, 9),
        "guarded_campaign_debit": round(
            max(0.0, after["used"] - float(campaign["starting_total_usage"]))
            + float(campaign["reported_eval_cost"]),
            9,
        ),
        "results": results,
    }
    (output_dir / "results.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    summary = {}
    for record in results:
        stats = summary.setdefault(record["model"], {"requests": 0, "passes": 0, "errors": 0, "latency": 0.0})
        stats["requests"] += 1
        stats["latency"] += record["latency_seconds"]
        if not record["ok"]:
            stats["errors"] += 1
        elif record["grade"]["passed"]:
            stats["passes"] += 1

    print(f"  response-reported cost: ${payload['reported_run_cost']:.4f}")
    print(f"  OpenRouter-observed campaign usage: ${payload['observed_campaign_spend']:.4f}")
    print(f"  conservative campaign guard debit: ${payload['guarded_campaign_debit']:.4f} / ${args.campaign_budget:.2f}")
    print(f"  account remaining: ${after['remaining']:.2f}")
    for model, stats in summary.items():
        avg = stats["latency"] / stats["requests"]
        print(f"  {model}: {stats['passes']}/{stats['requests']} deterministic passes · {stats['errors']} errors · {avg:.2f}s avg")
    print(f"  evidence: {output_dir / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
