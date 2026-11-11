#!/usr/bin/env bash

# Build, sign, install and launch the iOS app on a connected device (macOS only).
# Usage: pnpm ios:device [vite-mode]   e.g. `pnpm ios:device prod`
# Env:   IOS_DEVICE=<udid>  pick a device (default: first connected iPhone/iPad)
#        BUILD_KEYCHAIN / BUILD_KEYCHAIN_PASS_FILE  dedicated signing keychain;
#        needed over SSH, where the login keychain stays locked.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
mode="${1:-production}"
keychain="${BUILD_KEYCHAIN:-$HOME/Library/Keychains/tickit-build.keychain-db}"
pass_file="${BUILD_KEYCHAIN_PASS_FILE:-$HOME/.tickit-build-kc}"
derived="ios/DerivedData"

device="${IOS_DEVICE:-$(xcrun xctrace list devices 2>/dev/null \
  | sed -n '/== Devices ==/,/== Devices Offline ==/p' \
  | grep -E 'iPhone|iPad' | grep -oE '\(([0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40})\)' | tr -d '()' | head -1)}"
if [[ -z "$device" ]]; then
  echo "No connected iPhone/iPad found (set IOS_DEVICE=<udid>)." >&2
  exit 1
fi

pnpm exec vite build --mode "$mode"
pnpm run build:print-agent
pnpm exec cap sync ios

sign_flags=()
if [[ -f "$keychain" && -f "$pass_file" ]]; then
  security unlock-keychain -p "$(cat "$pass_file")" "$keychain"
  sign_flags=(OTHER_CODE_SIGN_FLAGS="--keychain $keychain")
fi

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$device" -derivedDataPath "$derived" -allowProvisioningUpdates \
  ${sign_flags[@]+"${sign_flags[@]}"} -quiet build

xcrun devicectl device install app --device "$device" "$derived/Build/Products/Debug-iphoneos/App.app"
xcrun devicectl device process launch --device "$device" com.tickit.pos
