#!/usr/bin/env bash
# Shared transport only. The root-owned VPS receiver owns backup and migration execution.
set -Eeuo pipefail
umask 077

: "${SSH_PRIVATE_KEY:?Configure the environment-specific SSH private key.}"
: "${SSH_KNOWN_HOSTS:?Configure the verified environment-specific SSH host key.}"
: "${SSH_HOST:?Configure the environment-specific SSH host.}"
: "${SSH_USER:?Configure the restricted deployment SSH user.}"
: "${COOLIFY_SUPABASE_PROJECT:?Configure the verified Coolify Supabase project.}"
: "${APP_VERSION:?Configure the exact release SHA.}"

operation="${DEPLOY_OPERATION:-apply}"
ssh_port="${SSH_PORT:-22}"
if [[ "$operation" != check && "$operation" != apply ]]; then
  echo "DEPLOY_OPERATION must be check or apply." >&2
  exit 1
fi
if [[ ! "$SSH_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ||
      ! "$SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ||
      ! "$ssh_port" =~ ^[0-9]{1,5}$ ]] || (( 10#$ssh_port < 1 || 10#$ssh_port > 65535 )); then
  echo "Invalid deployment SSH user, host or port." >&2
  exit 1
fi

package_root="$(mktemp -d)"
trap 'rm -rf "$package_root"' EXIT
printf '%s\n' "$SSH_PRIVATE_KEY" > "$package_root/key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$package_root/known_hosts"
chmod 600 "$package_root/key" "$package_root/known_hosts"

node scripts/prepare-production-migrations.mjs supabase/migrations "$package_root/migrations"
PACKAGE_ROOT="$package_root" DEPLOY_OPERATION="$operation" node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
if (!/^[a-z0-9_-]+$/.test(process.env.COOLIFY_SUPABASE_PROJECT ?? '') || !/^[0-9a-f]{40}$/.test(process.env.APP_VERSION ?? '')) {
  throw new Error('Invalid Coolify project or release SHA.')
}
writeFileSync(join(process.env.PACKAGE_ROOT, 'deployment.json'), JSON.stringify({
  protocol: 3,
  coolify_project: process.env.COOLIFY_SUPABASE_PROJECT,
  commit: process.env.APP_VERSION,
  operation: process.env.DEPLOY_OPERATION,
}))
NODE

# A legacy receiver rejects the manifest or protocol before connecting to any database.
tar -czf - -C "$package_root" deployment.json migrations \
  | ssh -T \
      -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="$package_root/known_hosts" \
      -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -p "$ssh_port" -i "$package_root/key" "${SSH_USER}@${SSH_HOST}"
