#!/usr/bin/env bash
# Backward-compatible command: the main installer now detects NetBird automatically.
set -euo pipefail
exec bash "$(dirname "$0")/install.sh" "$@"
