#!/usr/bin/env sh
# Installs from an extracted release archive (see scripts/build-release.sh).
# No Homebrew, no prerequisites: the bun runtime, the prebuilt panel, the
# presence helper, and the pinned gjc all ship inside the payload.
set -eu
payload=${1:?payload dir}
home_dir=${HOME:?}
state_home="$home_dir/.openinstinct"
mkdir -p "$state_home/bin"

# The bundled bun is the runtime, always. A host bun on PATH is not consulted:
# an older one cannot read this lockfile ("Unknown lockfile version", #1), and
# the daemon must run on the exact version the release was built against.
cp "$payload/bun" "$state_home/bin/bun-runtime.new"
chmod 755 "$state_home/bin/bun-runtime.new"
mv -f "$state_home/bin/bun-runtime.new" "$state_home/bin/bun-runtime"
ln -sf "$state_home/bin/bun-runtime" "$state_home/bin/bun"
PATH="$state_home/bin:$PATH"; export PATH
[ "$(command -v bun)" = "$state_home/bin/bun" ] || { echo "error: bundled bun did not take precedence on PATH" >&2; exit 1; }

# gjc is installed by install.sh from the payload (pinned to the SDK version).

# Stage a source tree at a stable path (install.sh copies from a repo root).
src="$state_home/src"
rm -rf "$src"; mkdir -p "$src"
cp -R "$payload/daemon" "$payload/scripts" "$payload/docs" "$payload/panel" "$payload/presence" "$src/"
cp "$payload/package.json" "$payload/bun.lock" "$payload/tsconfig.json" "$src/"
(cd "$src" && bun install --frozen-lockfile --production >/dev/null)
# What is running, for the panel's update check. Local source installs
# (scripts/install.sh from a checkout) leave this absent and get no update offer.
if [ -f "$payload/VERSION" ]; then cp "$payload/VERSION" "$state_home/VERSION"; fi

# Real Chrome binary so the browser tool can decrypt the owner's cookies.
env_file="$state_home/env"
touch "$env_file"; chmod 600 "$env_file"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && ! grep -q '^PUPPETEER_EXECUTABLE_PATH=' "$env_file"; then
  printf 'PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n' >> "$env_file"
fi

OI_SKIP_PANEL_BUILD=1 OI_BUN="$state_home/bin/bun-runtime" OI_GJC_PAYLOAD="$payload/gjc" sh "$src/scripts/install.sh"
