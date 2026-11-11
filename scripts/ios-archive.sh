#!/usr/bin/env bash

# Build a production App Store archive and export it (macOS only).
# Usage: pnpm ios:archive [vite-mode]   default mode `prod` (.env.prod)
# Env:   IOS_UPLOAD=1  upload the export to App Store Connect (needs the Apple
#                      account signed in to Xcode); otherwise writes an .ipa.
#        BUILD_KEYCHAIN / BUILD_KEYCHAIN_PASS_FILE  as in ios-device.sh (SSH).
set -Eeuo pipefail

cd "$(dirname "$0")/.."
mode="${1:-prod}"
keychain="${BUILD_KEYCHAIN:-$HOME/Library/Keychains/tickit-build.keychain-db}"
pass_file="${BUILD_KEYCHAIN_PASS_FILE:-$HOME/.tickit-build-kc}"
out="ios/build"
archive="$out/App.xcarchive"
version="$(node -p "require('./package.json').version")"
# App Store Connect requires a build number that grows on every upload.
build_number="$(date -u +%Y%m%d%H%M)"

pnpm exec vite build --mode "$mode"
pnpm run build:print-agent
pnpm exec cap sync ios

sign_flags=()
if [[ -f "$keychain" && -f "$pass_file" ]]; then
  security unlock-keychain -p "$(cat "$pass_file")" "$keychain"
  sign_flags=(OTHER_CODE_SIGN_FLAGS="--keychain $keychain")
fi

rm -rf "$archive"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$archive" -allowProvisioningUpdates \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build_number" \
  ${sign_flags[@]+"${sign_flags[@]}"} -quiet archive

destination="export"
[[ "${IOS_UPLOAD:-}" == "1" ]] && destination="upload"
options="$out/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>2W97PK6779</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/export" \
  -exportOptionsPlist "$options" -allowProvisioningUpdates
echo "Tickit POS $version ($build_number) [$mode] -> $destination"
