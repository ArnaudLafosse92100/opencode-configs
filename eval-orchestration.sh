#!/usr/bin/env bash
# eval-orchestration.sh — bounded OpenCode/OmO delegation canary.
#
# Default: plan only, zero network calls. Add --execute for the tiny live case.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$REPO/evals/orchestration-routing/run.py" "$@"
