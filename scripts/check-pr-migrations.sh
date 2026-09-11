#!/usr/bin/env bash

# Stable shell entrypoint for CI and local tooling. The unit-testable checker
# lives in JavaScript so SQL normalization does not depend on shell utilities.
set -Eeuo pipefail

exec node scripts/check-migrations.mjs "$@"
