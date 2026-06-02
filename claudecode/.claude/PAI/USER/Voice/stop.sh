#!/bin/bash
# Compatibility wrapper for the historical PAI Voice stop path.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
exec "$REPO_ROOT/scripts/stop.sh" "$@"
