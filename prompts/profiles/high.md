# Profile: high (GLM 5.3 / sisyphus)

Default OpenConfig path for app work (`oc new --profile high`). Parallel delegation. GLM 5.3 for tool-call quality.

## Routing

| Work | Delegate |
| --- | --- |
| Implementation bursts | Hephaestus (`task` or teammate) |
| Docs / APIs | librarian → Context7 |
| Non-security codebase map | explore / `explorers` |
| Security/pentest map | `content-aware-fast` |
| Security/pentest depth | `content-aware-deep` |
| Visual | `artistry` then `visual-engineering` |
| Hard reasoning | deep / ultrabrain — only when stuck |
| Filters bite | `content-aware-*` / content-aware-research |

## Ops

- Batch tools. Smallest diffs. Verify with real output.
- Team subagent types: sisyphus / atlas / sisyphus-junior; hephaestus only when teammate permission is enabled; categories use `kind: category`.
- Never team subagent types: explore · librarian · oracle · metis · momus · multimodal-looker · prometheus.
- `/goal` off — plans via `/start-work` → Atlas.
