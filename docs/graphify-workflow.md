# Graphify workflow

Graphify is a local code-navigation index for OpenConfig. The code-only corpus
covers executable shell/Python/JavaScript under `scripts/`, `tests/`, root
runtime scripts and `oc`. Prompts, agents, profiles, JSON configuration, `.env`,
credentials and generated runtime state are excluded and must be read directly.
The graph never proves the active profile, provider, model, runtime health or a
successful request.

Use only `/Users/arnaud/.local/share/openconfig-graphify/.venv/bin/graphify`,
pinned to `0.9.44`. The shared supervisor runs the fail-closed controller every
30 seconds. Live status is
`/Users/arnaud/.local/share/openconfig-graphify/health.json`; verify with
`node scripts/verify-graphify-output.mjs`.

Memory is external at `/Users/arnaud/.local/share/openconfig-graphify/memory`.
Use the graph runtime pointers and never store raw memory in the repository.
Stage and verify any full directed rebuild outside the repository before
promotion.
