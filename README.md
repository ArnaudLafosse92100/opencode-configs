# OpenConfig

Pinned global config for [OpenCode](https://opencode.ai) + [OpenRouter](https://openrouter.ai) + [oh-my-openagent (OmO)](https://omo.vibetip.help/docs).

**v1.5.60** · CLI **`oc`** · identity `openconfig/opencode-configs`

```bash
git clone --branch main https://github.com/ArnaudLafosse92100/opencode-configs.git
cd opencode-configs
oc install --quick          # or: ./install.sh --yes

# Fresh machine
curl -fsSL https://raw.githubusercontent.com/ArnaudLafosse92100/opencode-configs/main/install.sh | bash
source ~/.zshrc && oc doctor && oc launch
```

| | |
| --- | --- |
| **Pins** | OpenConfig `1.5.60` · OpenCode `1.18.17+` · OmO `oh-my-openagent@4.19.4` · `@opencode-ai/plugin` `1.18.17` |
| **Default lead** | `sisyphus` (runtime-profile routed; normal GLM 5.3, pentest DeepSeek) |
| **Codex model-picker entry** | `codex-router` (runtime-profile routed, task-only workspace access) |
| **Public config path** | `~/.config/opencode` → `~/.local/state/openconfig/compat/current` (generated compatibility view) |
| **Projects home** | `oc new` → `~/Projects/<name>` |
| **Health** | `oc doctor` · `oc versions` · `oc test` |

Canonical distribution: `ArnaudLafosse92100/opencode-configs@main`.

Upstream comparison reference: `jesseoue/opencode-configs@a63966fd2788a85a8c3b6773fdc7d48399cd1940` (OpenConfig 1.5.60). This is a source snapshot, not an ancestry claim: the fork selectively ports the upstream model/provider invariants and adds the documented normal/pentest, subscription-gateway and retry-policy extensions.

> Plugin name must stay **`oh-my-openagent@…`** (not legacy `oh-my-opencode`).  
> Schema URL basename stays `oh-my-opencode.schema.json` (the `oh-my-openagent.schema.json` path 404s).

Decision log: [`AGENTS.md`](./AGENTS.md) · Stance: [`prompts/core.md`](./prompts/core.md) · Changelog: [`CHANGELOG.md`](./CHANGELOG.md)

---

## Install

```bash
export OPENROUTER_API_KEY=…     # required
export LLM_GATEWAY_OPENAI_BASE_URL=https://proxy.unbeatn.ai/v1
export LLM_GATEWAY_API_KEY=…    # GPT subscription lane (Hephaestus / Oracle / Momus / …)
export EXA_API_KEY=…            # OmO websearch
export CONTEXT7_API_KEY=…       # library docs

oc install --quick
oc signature && oc test && oc versions && oc doctor
oc launch
```

Or edit keys after install:

```bash
$EDITOR ~/.config/opencode/.env   # chmod 600; never commit
source ~/.zshrc
oc doctor && oc launch
```

---

## CLI

```bash
oc install --quick     # install / refresh
oc check               # validate + doctor --quick
oc heal                # probe-first self-repair
oc launch [dir]        # TUI (never starts in the config repo)
oc new myapp           # scaffold under ~/Projects
oc run "…"             # headless to completion
oc admin health        # live OpenRouter + subscription-gateway probes
oc models --providers  # OpenRouter provider health for routed models
oc versions            # pins vs npm + GitHub (+ other opencode.json)
oc versions --fix       # align ~/.opencode @opencode-ai/plugin to CLI
oc plugin doctor       # OmO pin-cache doctor (also: oc plugin --fix)
oc locate              # repo / CLI / keys
oc signature           # identity fingerprint
oc test                # smoke + idempotency
oc doctor              # full readiness
oc doctor --quick --json   # machine summary (heal/check tooling)
```

Prefer `oc <cmd>` over raw `./foo.sh`. Full help: `oc help`.

**Aliases:** `oc health`/`ready` → check · `oc repair` → heal · `oc verify` → validate · `oc where` → locate · `oc sig` → signature · `oc pins` → versions · `oc omo` → plugin

---

## Package pins

Floors and the OmO pin live in [`versions.json`](./versions.json). The OmO plugin string in `opencode.json` must match. Audit anytime:

```bash
oc versions              # local pins + npm/GitHub latest
oc versions --local      # no network
oc versions --json       # machine-readable
oc versions --fix         # set ~/.opencode @opencode-ai/plugin to match OpenCode CLI
```

| Package | Source of truth | Current |
| --- | --- | --- |
| OpenConfig | `versions.json` → `opencode_configs` | `1.5.60` |
| OpenCode CLI | install + `versions.json` → `opencode.min` | `1.18.17+` |
| OmO | `opencode.json` plugin + `versions.json` → `oh_my_openagent.pin` | `4.19.4` |
| `@opencode-ai/plugin` | `~/.opencode/package.json` (peer; not in this repo) | match CLI |

`oc versions` also lists other `opencode.json` files under `~/Projects` and `/Users/Shared`. Those are project overlays — OmO stays pinned globally here.

---

## Tools

| Need | Tool | Notes |
| --- | --- | --- |
| Local code | `read` · `grep` · `glob` · codegraph · LSP | Always first |
| Library / framework APIs | **Context7** MCP | `resolve-library-id` → `query-docs` |
| GitHub call sites | **grep_app** (OmO) | Public-repo patterns |
| Current web | **websearch** (Exa) | Ideal-page queries; then webfetch |
| Known URL | **webfetch** | Clean markdown |
| Screenshots / UI | **look_at** (OmO) | multimodal-looker |

**Exa:** describe the ideal page, not keyword soup. Optional: `category:company` · `category:people` · `category:news` · `category:research paper`.

| Surface | Status |
| --- | --- |
| Context7 MCP | Enabled (`CONTEXT7_API_KEY`) |
| Exa websearch | Enabled (`EXA_API_KEY`) |
| codegraph | Enabled · telemetry off · `~/.omo/codegraph` |
| LSP | TypeScript · Python · Go only |
| Formatters | Prettier + Ruff |
| Skills | `content-aware-recon` · `content-aware-audit` under `skills/` (fenced) |
| OmO `security-*` skills | Disabled (hang headless `oc run`) — use local content-aware skills |
| Extra MCPs | Disabled (PostHog, Sentry, Playwright MCP, …) |
| Telemetry | Off (OpenCode share/OTel · OmO PostHog · codegraph · `DO_NOT_TRACK`) |

Disabled on purpose (noisy / footguns): `interactive_bash`, monitor tools, `session_list` / `session_search`.

Encoded in `prompts/core.md`, `sisyphus`, and `librarian`.

---

## Agents

### Primary

| Agent | Routing authority | Role |
| --- | --- | --- |
| **codex-router** | Runtime-profile routed | Strict Codex bridge entry; delegates workspace actions to OmO categories |
| **sisyphus** | Runtime-profile routed | Default orchestrator / lead |
| **hephaestus** | Runtime-profile routed | Implementation |
| **prometheus** | Runtime-profile routed | Planner |
| **atlas** | Runtime-profile routed | Plan executor after `/start-work` |
| **content-aware-research** | Runtime-profile routed (normal Hermes, pentest Flash 0731) | Full-depth research (edit denied) |

### Subagents (`task` / `call_omo_agent` — not team members)

| Agent | Model | Role |
| --- | --- | --- |
| oracle | `runtime-profile.json` | Critique / adjudication |
| librarian | `runtime-profile.json` | Docs (Context7-first) |
| explore | `runtime-profile.json` | Codebase map |
| multimodal-looker | `runtime-profile.json` | Vision (`look_at`) in normal mode |
| metis | `runtime-profile.json` | Pre-planning critic |
| momus | `runtime-profile.json` | Plan / review gate |
| sisyphus-junior | `runtime-profile.json` | Cheap delegated work |

Native OpenCode `build` is disabled. `plan` stays demoted for hyperplan handoff — do **not** put it in `disabled_agents`.

`codex-router` is selected only by `/Volumes/PERSO/OpenCode-Codex-Bridge`.
Its final permission rules are `* = deny`, then `task = allow`, so it cannot
silently inspect or modify a workspace on the GLM parent. The OmO category
still owns the child model, skills/category prompt, and fallbacks. Normal
OpenCode TUI sessions continue to use `sisyphus`.

---

## Categories

| Category | Routing authority | Use |
| --- | --- | --- |
| `bug-hunt` | Runtime-profile routed | Reproduce → root cause → fix |
| `refactor-safe` | Runtime-profile routed | Behavior-preserving refactors |
| `arch-review` | Runtime-profile routed | Coupling / blast radius |
| `content-aware-fast` | `runtime-profile.json` | Attack-surface recon |
| `content-aware-deep` | `runtime-profile.json` | Deep vuln research |
| `agentic-deep-kimi` | Runtime-profile routed | Explicit long-horizon escalation after evaluation |
| `writing` | Runtime-profile routed | Docs / prose |
| `visual-engineering` | Runtime-profile routed | Ship UI |
| `artistry` | Runtime-profile routed | Design direction |
| `quick` | `runtime-profile.json` | Cheap fast tasks |
| `deep` / `ultrabrain` | `runtime-profile.json` | Heavy / max reasoning |
| `unspecified-low` / `unspecified-high` | Runtime-profile routed | Hyperplan critics |

---

## Keywords & handoff

| Say | Effect |
| --- | --- |
| `ultrawork` / `ulw` | GLM 5.3 max inside Sisyphus |
| `team` | Team-mode expansion |
| `hyperplan` / `hpp` / `/hyperplan` | Adversarial planning (from **sisyphus**) |
| `/goal` | **Disabled** — OmO 4.19 goal hook breaks `/start-work`. Use `/start-work` → Atlas (`prompts/goal.md`) |
| `/start-work` | Atlas executes an approved Prometheus plan |

---

## Teams

Lead: **sisyphus**. Specs in `teams/` are **symlinked** to `~/.omo/teams/` by `oc setup`.

Eligible: `sisyphus`, `atlas`, `sisyphus-junior`, `hephaestus` (`teammate: allow`), or `kind: category`.  
Hard-rejected as teammates: explore · librarian · oracle · metis · momus · multimodal-looker · prometheus.

Knobs: `max_parallel_members=4` · `max_members=5` · mailbox poll `1000ms` · tmux `main-vertical` / `inline`.

| Team | Members (inline prompts: ROLE / DELIVERABLE / Mailbox) |
| --- | --- |
| `explorers` | scout-code (`content-aware-fast`) + scout-docs (`quick`) |
| `ship-feature` | forge (hephaestus) + junior + verifier (`bug-hunt`) |
| `debug-team` | reproducer (`bug-hunt`) + root-cause (`content-aware-deep`) |
| `review-panel` | arch (`content-aware-deep`) + bugs (`bug-hunt`) + cleanup (`refactor-safe`) |
| `refactor-team` | analyzer (`arch-review`) + executor (`refactor-safe`) |
| `docs-team` | api-docs + guide (`writing`) |
| `content-aware-audit` | recon (`content-aware-fast`) + deep (`content-aware-deep`) |

---

## Model routing

`runtime-profile.json` is the only hand-maintained route matrix. The table below is generated from it and `oc validate` rejects documentation drift.

<!-- BEGIN GENERATED: runtime-routing -->
<!-- Generated by scripts/render-routing-docs.py; do not edit this block manually. -->
| Route | Normal primary | Pentest primary |
| --- | --- | --- |
| `agents.atlas` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.codex-router` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.content-aware-research` | `openrouter/nousresearch/hermes-4-405b` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.explore` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.hephaestus` | `subscription-gateway/gpt-5.6-terra` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.librarian` | `openrouter/deepseek/deepseek-v4-flash-0731` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.metis` | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.momus` | `subscription-gateway/gpt-5.6-sol-review` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.multimodal-looker` | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.oracle` | `subscription-gateway/gpt-5.6-sol` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.prometheus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `agents.sisyphus-junior` | `openrouter/deepseek/deepseek-v4-flash-0731` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.agentic-deep-kimi` | `openrouter/moonshotai/kimi-k2.7-code` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.arch-review` | `subscription-gateway/gpt-5.6-sol-review` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.artistry` | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.bug-hunt` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.content-aware-deep` | `openrouter/deepseek/deepseek-v4-pro-0813` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.content-aware-fast` | `openrouter/deepseek/deepseek-v4-flash-0731` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.deep` | `subscription-gateway/gpt-5.6-sol` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.quick` | `openrouter/deepseek/deepseek-v4-flash-0731` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.refactor-safe` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.ultrabrain` | `subscription-gateway/gpt-5.6-sol` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.unspecified-high` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.unspecified-low` | `openrouter/deepseek/deepseek-v4-flash-0731` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.visual-engineering` | `openrouter/google/gemini-3.1-pro-preview` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |
| `categories.writing` | `openrouter/google/gemini-3.7-flash` | `openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput` |

Fallback order and reasoning remain machine-readable through `oc profile resolve <normal|normal-private|pentest> <agents|categories> <name>`. `normal-private` composes normal routes with subscription-gateway removed and OpenRouter ZDR constraints.
<!-- END GENERATED: runtime-routing -->

OpenRouter owns the heterogeneous paid-model lane for GLM, DeepSeek, Gemini, Kimi, Hermes, and MiniMax. GPT Sol/Terra roles use the subscription gateway through `llm-agent-*` aliases; they are not routed through OpenRouter as an automatic paid fallback. Fallbacks + `runtime_fallback` run on API errors. Stream timeouts: **600s**.

Runtime fallback is OpenConfig/OmO-owned. OpenConfig patches the pinned OmO
package cache so transient primary-provider glitches retry the same primary
model before model fallback. The native OmO `runtime_fallback` stays
upstream-schema compatible with `timeout_seconds=20`; the custom
retry knobs are OpenConfig-owned environment exports:
`OPENCONFIG_OMO_SAME_MODEL_RETRIES_BEFORE_FALLBACK=3` and
`OPENCONFIG_OMO_FIRST_PROMPT_TIMEOUT_SECONDS=20`. Thus pentest executes
**Flash ZDR Throughput initial attempt + three Flash ZDR Throughput retries → exactly one Pro
0813 ZDR Throughput attempt → terminal failure**. No GLM, GPT, Kimi, or other model can be
selected. Quota, missing-key, model-not-found, 400/401/403, abort, and
context-overflow failures do not retry or transition. Reapply/verify the patch
with `oc plugin --fix`; `oc doctor` reports whether it is present.

The same governed patch makes OmO's canonical `agents.*.models` priority
arrays effective for `task(subagent_type=...)`: the first entry is the primary,
the remaining entries are its fallback order, and supported per-entry settings
are retained. Native agent registration consumes those arrays too, matching
categories; `oc plugin --fix` fails closed if its pinned anchors drift.

Runtime profiles can override this matrix without removing native OmO agents/categories. `runtime-profile.json` declares the immutable profiles and the tracked configs remain the `normal` source baseline. `oc profile normal|normal-private|pentest` renders a complete machine-local generation under `~/.local/state/openconfig/{runtime,compat}/generations`; **`oc profile path` remains the stable runtime-overlay API** for integrations, while `oc profile compat-path` exposes the writable compatibility home and `oc profile env` returns the paired active config/XDG snapshot. `oc profile resolve <profile> <agents|categories> <name>` remains the stable route API. Normal uses role-preserving chains of at most two model transitions and price-first caps without `provider.only`: fast helpers use Flash Floor → MiniMax, general work uses GLM → Kimi → Pro, subscription lanes use a compatible Pro → GLM recovery path, and vision remains Gemini Pro → Gemini Flash → MiniMax. It keeps collection allowed. `normal-private` derives that same ordering with gateway rungs removed. `pentest` remains stricter: every agent, category, small model, and helper is Flash 0731 ZDR Throughput, then the sole Pro 0813 ZDR Throughput fallback. The sequence is Flash initial + three Flash retries, exactly one Pro attempt, then terminal failure. There is deliberately no fake USD runtime hard-cap: exact observer costs are asynchronous, so only the existing evaluation campaign budgets are enforced synchronously.

### Bounded model-routing eval

`oc eval` prints a zero-cost DeepSeek/Kimi/GLM comparison plan. `oc eval --execute` runs three evidence-only cases with a default **$1 per-run cap**, a cumulative **$20 campaign cap**, and a **$2 account reserve**. Results and the conservative campaign ledger live under `~/.cache/openconfig/evals/model-routing/`; see `evals/model-routing/README.md` for the staged promotion gate. Kimi remains an explicit escalation lane until the canary demonstrates a measurable quality gain.

### Concurrency

Priority: `modelConcurrency` → `providerConcurrency` → `defaultConcurrency`. `oc heal` / `fix.sh` re-apply caps if they drift.

| Knob | Value |
| --- | --- |
| `background_task.defaultConcurrency` | **6** |
| OpenRouter / subscription gateway / Anthropic | **8 / 4 / 2** |
| DeepSeek Flash Floor / Gemini Flash | **10 / 10** |
| GLM / MiniMax | **8 / 8** |
| DeepSeek Pro / Kimi / Gemini Pro / Sol | **5 / 5 / 5 / 3** |
| Hermes / Opus 5 / Fable | **2 / 1 / 1** |
| Team parallel / max members | **4 / 5** |
| Goal / stale / TTL | **off / 180s / 30m** |

---

## API keys

| Key | Required | Enables |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | **yes** | OpenRouter models |
| `LLM_GATEWAY_OPENAI_BASE_URL` + `LLM_GATEWAY_API_KEY` | **yes** for GPT subscription lane | Hephaestus / Oracle / Momus / deep / … |
| `EXA_API_KEY` | for websearch | OmO Exa |
| `CONTEXT7_API_KEY` | recommended | Context7 |
| `OPENROUTER_MGMT_KEY` | optional | `oc admin` |
| `OC_PROJECTS_DIR` | optional | `oc new` home (default `~/Projects`) |

Copy `.env.example` → `.env` (`chmod 600`). Never commit `.env`.  
`oc setup --sync-env` imports **allowlisted keys only** from Infisical/Doppler — never a full vault dump.

---

## Prompts

Every OmO agent/category loads a `prompt_append` from `prompts/`. Profiles under `prompts/profiles/` brief `oc new` scaffolds.

| Path | What |
| --- | --- |
| `prompts/core.md` | Session-wide stance, tool matrix, team eligibility |
| `prompts/goal.md` | Why `/goal` is off; use `/start-work` → Atlas |
| `prompts/agents/*.md` | Agent appends |
| `prompts/categories/*.md` | Category appends |
| `prompts/profiles/*.md` | Profile briefs |
| `agents/content-aware-research.md` | OpenCode primary-agent def (synced with prompts) |
| `agents/codex-router.md` + `prompts/agents/codex-router.md` | Native definition + strict task-only OmO prompt for the Codex bridge |

---

## Profiles & scaffolding

```bash
oc new myapp                     # ~/Projects/myapp · profile high
oc new myapp --profile research
oc new myapp --profile content-aware
oc projects --list
```

<!-- BEGIN GENERATED: scaffold-profiles -->
<!-- Generated by scripts/render-routing-docs.py; do not edit this block manually. -->
| Profile | Default agent | Main model | Small model |
| --- | --- | --- | --- |
| `high` | `sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `low` | `sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `fast` | `hephaestus` | `subscription-gateway/gpt-5.6-terra` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `research` | `sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `debug` | `sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `writing` | `sisyphus` | `openrouter/z-ai/glm-5.3` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| `content-aware` | `content-aware-research` | `openrouter/nousresearch/hermes-4-405b` | `openrouter/deepseek/deepseek-v4-flash-0731` |
<!-- END GENERATED: scaffold-profiles -->

Each project gets `opencode.json` + `AGENTS.md`. Do not set `OPENCODE_CONFIG` to `.opencode/profile.json`.

---

## Safety

- Allow-everything locally for normal tools (trusted box).
- Hard-deny bash: `rm -rf /|~`, `mkfs`, `sudo`, `git push --force*`, `gh repo delete*`.
- Providers allowed: OpenRouter + subscription gateway; direct OpenAI is disabled in this fork.
- Server: `127.0.0.1:4097` · share disabled · mdns off · Basic Auth via
  `~/.local/state/opencode-codex-bridge/opencode-server-password` when managed
  by the bridge.

---

## Terminal

- **Ghostty** ≥ 1.3.0 · **tmux** ≥ 3.3 (rec. 3.7+) · zsh snippet
- OpenCode leader **Ctrl+X** · tmux prefix **Ctrl+B** · Tab cycles agents
- Teardown never sends `\033[?1049l` (won’t wipe the visible screen)
- `opencode()` / `oc launch` never start inside the config repo or bare `~/Projects`

---

## Layout

```
opencode-configs/
├── oc · install.sh · setup.sh · doctor.sh · validate.sh · fix.sh
├── models.sh · versions.sh · cleanup.sh · signature.sh · locate.sh
├── opencode.json · oh-my-openagent.json · tui.json
├── versions.json · signature.json · projects.json · AGENTS.md
├── agents/content-aware-research.md · agents/codex-router.md
├── profiles/ · prompts/ · teams/ · skills/
├── .env.example
└── zshrc.snippet · ghostty.conf · tmux.conf

~/.config/opencode  →  ~/.local/state/openconfig/compat/current
~/Projects/         →  oc new home
~/.omo/teams/       →  team specs
~/.opencode-backups/→  backups + heal/install logs
```

---

## Verify

```bash
oc signature && oc test && oc validate && oc versions && oc doctor
python3 scripts/render-routing-docs.py --check
oc plugin doctor                     # pin cache + OpenConfig OmO patch
# Optional raw upstream/schema debug:
oc plugin doctor --upstream
```

Idempotency: re-running install / setup / heal / fix on a healthy box must not clobber `.env`, rewrite correct symlinks, or bump clean config mtimes.

---

## Upstream

This fork is the canonical install source. `jesseoue/opencode-configs` remains the comparison upstream, pinned in `signature.json` by full reference commit; upstream prose is informative, while executable JSON plus local validation remain authoritative.

| Layer | Docs | Source |
| --- | --- | --- |
| OpenCode | [opencode.ai/docs](https://opencode.ai/docs) | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| OmO | [omo.vibetip.help/docs](https://omo.vibetip.help/docs) | [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) |
| OpenRouter | [openrouter.ai/docs](https://openrouter.ai/docs) | Provider routing / model variants |
| Context7 | [context7.com](https://context7.com) | [upstash/context7](https://github.com/upstash/context7) |
| Exa | [docs.exa.ai](https://docs.exa.ai) | [exa-labs](https://github.com/exa-labs) |

Installer pulls OpenCode from `https://opencode.ai/install` and OmO from npm `oh-my-openagent@4.19.4` only.

---

## Anti-patterns

- Don’t rename the plugin away from `oh-my-openagent`
- Don’t add Cloudflare / AI Gateway / OpenAI-compatible shims
- Don’t put `plan` in `disabled_agents` (breaks hyperplan)
- Don’t commit `.env`, `package.json`, `node_modules`, `.omo`, `.sisyphus`, or `plugins/` here
- Don’t scaffold apps into this repo — use `oc new`
- Don’t load `.opencode/profile.json` as `OPENCODE_CONFIG`
- Don’t re-enable telemetry or OmO `security-*` skills
- Don’t re-enable `/goal` on OmO 4.19 until `/start-work` is safe

---

## Config-only scope

**Keep:**
- Prompt tweaks when a lane misbehaves
- Local skills under `skills/` (fenced) — never re-enable OmO `security-*`
- Weekly `oc models --providers` after OpenRouter host churn (don’t hand-edit `order`/`ignore` blindly)
- `oc versions` after OpenCode / OmO releases (bump `versions.json` + plugin pin together)
- Project scaffolds via `oc new` (apps stay outside this tree)

**Skip:**
- Extra MCP servers — keep `disabled_mcps`
- Cloudflare AI Gateway / Claude Code bridge imports
- Packaging as npm / shipping `node_modules` into the config dir
- Turning this repo into an application
# Compatibility config home

`/Volumes/PERSO/OpenConfig` is immutable source. Setup renders each profile to
immutable runtime and writable compatibility generations at
`~/.local/state/openconfig/{runtime,compat}/generations/<generation-id>`.
`~/.config/opencode` points atomically to `compat/current`, not to the Git
checkout. The view contains effective profile config plus wrappers back to the
source `oc`/launch/admin scripts and a linked `.env`; sessions remain in
OpenCode's normal data directory. `oc profile env --shell` resolves the paired
`OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` from one selected profile.
For diagnostics, `oc profile snapshot` returns one lock-consistent JSON
observation (`desiredProfile`, raw applied marker, paired current paths, and
expected v3 identity); it never renders, activates, repairs, or switches.
`runtime/current` and `active-profile` are stable aliases through that same
commit pointer. The XDG snapshot (`compat/current/xdg`) is rendered inside the
same compatibility generation. Staging occurs under unreferenced `.staging`
directories; only a complete, validated generation is published by replacing
`compat/current`. Its fingerprint covers the generator, copied configuration,
and every source-side component reached by the compat view (`oc`, profile and
launch wrappers, the zsh snippet, and `lib/`) by path, type, mode, and bytes;
it never hashes `.env`: secrets remain a dynamic linked input. Compatibility identity records only whether `.env` exists and
its resolved path, so setup can expose a newly created `.env` without making
secret-value edits regenerate a profile. Runtime and compatibility manifests detect drift in managed
payloads and generated links (including the source/lib/snippet/runtime links).
The compatibility identity also inventories immediate non-OpenCode XDG
siblings by name/type/resolved target, never their contents or secrets. Raw
OpenCode package artifacts are intentionally outside these manifests and do
not force needless regeneration. A future operator-approved native alias may likewise target
`compat/current/.omo.jsonc`, a complete `[opencode]` envelope that preserves
unmanaged root keys. Its generated native routes use OmO 4.19.4 `models`
priority arrays (not legacy `model` + `fallback_models`) and carry both
`2026-07-opencode-config-unification` and `2026-08-reasoning-unification`
markers, so OmO startup has no native migration to write. `runtime-profile.json`
remains the routing SSoT and retains its profile-oriented route representation.
The normal generated `codex-router` agent definition (apart from its canonical
profile model frontmatter) and `content-aware-deep` prompt remain at their
tracked baselines; the authoring mirror `prompts/agents/codex-router.md` is
copied byte-for-byte. Only the pentest generation adds a soft cost-aware overlay
to the effective router definition and deep category prompt: Flash
reconnaissance/deduplication before Pro adjudication, bounded evidence batches
and resumed-gap work, and explicit unverified gaps after the target tool-call
rounds. This prompt guidance is not a hard runtime cap and does not change
routes, permissions, or global OmO limits.
Runtime-profile never creates that native symlink itself:
`oc setup`/install do so only after profile/envelope/source consensus and make
a recoverable backup carrying the original mode and SHA-256. Until setup has
done that, regular native OmO config remains journal-protected and a later
`oc profile` reader rolls an interrupted switch back before reporting.

`oc profile normal|normal-private|pentest` commits the desired profile immediately. When a
LaunchAgent is present it writes `applied-profile.json` only after a fresh
launchd-owned bridge `/healthz` identity (schema, PID/listener, upstream and
new instance ID), OpenCode health, and the expected `codex-router` model all verify.
The pre-restart instance ID is captured from the exact health schema even when
the bridge is legitimately returning 503 while its upstream recovers, so that
an ineffective restart cannot reuse that process as fresh proof. A
v3 marker binds that proof to the selected profile, runtime fingerprint and
generation, compatibility generation/identities/manifest, and model. A
restart failure exits non-zero and leaves the marker absent; without a
LaunchAgent the command succeeds as explicitly **desired-only** and asks for
`oc launch`.
OpenConfig treats `~/.omo/omo.jsonc` as an OpenConfig-owned generated alias;
direct OmO writers are unsupported because they may reject or replace that
symlink. If
`~/.omo/.migration-journal.json` exists, `oc profile` and setup fail closed;
inspect and explicitly resolve that OmO migration before permitting any native
write, especially where its journal names a source-checkout file.

The one-time native migration accepts no `[opencode]` semantic drift except
the known Sisyphus `prompt_append` relocation from the managed legacy profile
path to `file://~/.config/opencode/prompts/agents/sisyphus.md`. OmO rejects a
direct absolute prompt path below the immutable `~/.local/state` generation;
the allowed stable config-home alias resolves through `compat/current` to the
same selected generation and is covered by its applied identity. Both paths
and the selected profile are checked exactly; every other difference blocks
before backup.
