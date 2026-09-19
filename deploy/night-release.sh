#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
exec "${UFV_RELEASE_PYTHON:-/opt/ufv/.venv/bin/python}" deploy/night-release.py "$@"
