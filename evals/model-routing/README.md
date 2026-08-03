# OpenConfig model-routing canary

This eval answers one bounded question: should Kimi K3 become an explicit escalation lane without replacing the cheap DeepSeek/GLM defaults?

It is intentionally not a leaderboard. All models receive the same evidence-only cases and output contract. Deterministic checks cover schema adherence, required evidence, known hallucinations, and false execution claims. Human review is still required for architectural quality.

## Budget contract

- Total campaign cap: **$20**.
- Account reserve: **$2** by default.
- Stage 1 direct-model baseline: default **$1** run cap; expected to cost far less.
- Stage 2 OpenCode single-agent canary: maximum **$4**, only after reviewing Stage 1.
- Stage 3 representative real tasks: maximum **$10**, only after Stage 2.
- Final reserve inside the campaign: at least **$5** for retries or a contradictory result.

The campaign ledger is `~/.cache/openconfig/evals/model-routing/campaign.json`. It records the OpenRouter total-usage baseline and the costs reported directly by eval responses. The guard adds both signals because the credits endpoint can lag behind completed requests. This can temporarily count an eval charge twice after the account total catches up, but it cannot undercount that known request. Unrelated OpenRouter traffic observed since the baseline also counts against the cap.

## Commands

```bash
oc eval
oc eval --execute
oc eval --execute --models deepseek --cases bounded-architecture-plan
```

The default is a zero-cost plan. Billable calls require `--execute`. The runner refuses a batch when its conservative maximum exceeds the per-run cap, when cumulative usage would cross the campaign cap, or when the account reserve would be consumed.

Use `--models` and `--cases` for a targeted retry after diagnosing a failed request. The default 2,400-token allowance was selected because a 1,200-token DeepSeek canary spent its entire completion on hidden reasoning and returned no visible content. The evidence records the finish reason, visible content, reasoning payload when supplied by the provider, and token breakdown. A response that exhausts its allowance on hidden reasoning and returns no content is an integration failure, not a quality verdict.

Stage 1 compares:

- `deepseek/deepseek-v4-flash` — cheap baseline and current 0731 route;
- `moonshotai/kimi-k3` — proposed deep-agentic escalation;
- `anthropic/claude-sonnet-5` — paid API control on the identical harness.

The Sonnet request is deliberately included despite the active Claude subscription because that subscription cannot be used through OpenRouter, and changing the harness would make the comparison ambiguous. The stage is small enough that this control costs only a few cents.

## Promotion gate

Do not promote Kimi globally. Consider it for `agentic-deep-kimi` or a premium fallback only when:

1. it has no deterministic regression against Sonnet on the shared cases;
2. it materially beats DeepSeek on at least one representative difficult task;
3. its additional cost or latency buys fewer retries or less human correction;
4. the task is appropriate for the selected provider and data policy;
5. the fallback remains bounded and observable.

Reject the promotion if Kimi mainly produces longer answers, requires more repair loops, or makes the 13-persona Buzz fan-out materially more expensive without a measurable acceptance gain.
