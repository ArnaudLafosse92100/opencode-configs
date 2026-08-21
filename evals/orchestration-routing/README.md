# OpenConfig orchestration-routing canary

This suite tests a different boundary from `evals/model-routing`: whether the
strict Codex entry agent actually invokes OmO's existing `task` category router. It does
not rank models and does not introduce a second router.

The default command is offline and free:

```bash
./eval-orchestration.sh
```

The smallest live canary uses a temporary copy of the synthetic fixture and
one implicit security-recon prompt. The prompt deliberately never says
"delegate", because the behavior under test is automatic policy routing:

```bash
./eval-orchestration.sh --execute --cases security-recon --run-budget 0.10
```

Live execution requires the local OpenCode server and database. Evidence is
metadata-only and is written under
`~/.cache/openconfig/evals/orchestration-routing/`: parent id and agent, task category,
loaded skill names, child agent/model/provider, terminal finish, elapsed time,
and guarded cost. Prompt/response bodies and credentials are never persisted.

## Acceptance contract

| Case | Expected route |
| --- | --- |
| `trivial-direct` | `codex-router` only; no child session for a tool-free answer |
| `security-recon` | `task(category="content-aware-fast")`, embedded or explicit `content-aware-recon` contract, DeepSeek child, terminal `stop` |
| `security-deep` | `task(category="content-aware-deep")`, embedded or explicit `content-aware-audit` contract, DeepSeek child, terminal `stop` |
| `architecture-review` | `task(category="arch-review")`, subscription-gateway Sol review child, terminal `stop` |

The content-aware category prompt is the mandatory specialization contract and
travels with the category-selected model. `load_skills` is recorded as a useful
defense-in-depth signal, but a provider omitting that redundant argument does
not invalidate a correctly routed category child.

Use `--repeat 3` after the one-shot canary is healthy. A prompt-only routing
contract is accepted only if the implicit case is repeatable. The runner aborts
the canary session on timeout. It checks both OpenCode-recorded cost and the
OpenRouter credit delta after every case, using the larger value as the guard;
the default plan never creates a session.
