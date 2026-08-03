#!/usr/bin/env bash
# eval-models.sh — bounded DeepSeek/Kimi/Sonnet routing evaluation.
#
# Usage:
#   ./eval-models.sh                         # plan only; zero cost
#   ./eval-models.sh --execute               # first controlled run (default cap $1)
#   ./eval-models.sh --execute --run-budget 2 --campaign-budget 20
#
# Results live under ~/.cache/openconfig/evals/model-routing/. The campaign cap
# counts all OpenRouter usage observed after its first run, not only this script.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$REPO/evals/model-routing/run.py" "$@"
