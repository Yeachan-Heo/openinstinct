#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
home_dir=${HOME:?HOME must be set}
uid=$(id -u)

case "$home_dir" in
  /*) ;;
  *) printf '%s\n' "HOME must be absolute" >&2; exit 1 ;;
esac

state_home="$home_dir/.openinstinct"
binary="$state_home/bin/openinstinctd"
library="$state_home/lib"
library_stage="$state_home/lib.new.$$"
library_previous="$state_home/lib.previous.$$"
plist="$home_dir/Library/LaunchAgents/co.openinstinct.daemon.plist"
# OI_BUN pins the runtime (bootstrap-from-payload.sh passes the bundled one);
# otherwise the first bun on PATH. The lockfile needs the version package.json
# declares, so refuse anything older instead of failing inside `bun install`.
bun_path=${OI_BUN:-$(command -v bun || true)}
[ -n "$bun_path" ] || { printf '%s\n' "bun is required (or run the release installer, which bundles it)" >&2; exit 1; }
required_bun=$(sed -nE 's/.*"packageManager": *"bun@([0-9.]+)".*/\1/p' "$repo_root/package.json")
if [ -n "$required_bun" ]; then
  have_bun=$("$bun_path" --version)
  if [ "$(printf '%s\n%s\n' "$required_bun" "$have_bun" | sort -V | head -n 1)" != "$required_bun" ]; then
    printf '%s\n' "bun $have_bun at $bun_path is older than the $required_bun this release needs; install a newer bun or use the release archive, which bundles one" >&2
    exit 1
  fi
fi

cleanup() {
  if [ -n "$library_previous" ] && [ -d "$library_previous" ] && [ ! -e "$library" ]; then
    mv "$library_previous" "$library"
  fi
  [ -z "$library_stage" ] || rm -rf "$library_stage"
  [ -z "$library_previous" ] || rm -rf "$library_previous"
}
trap cleanup 0
trap 'exit 1' 1 2 15

model_catalog_valid() {
  found=0
  for catalog in "$library_stage"/node_modules/.bun/@gajae-code+ai@*/node_modules/@gajae-code/ai/src/models.json; do
    [ -f "$catalog" ] || continue
    found=1
    [ -s "$catalog" ] || return 1
    "$bun_path" -e '
      const catalog = await Bun.file(process.argv[1]).json();
      if (catalog === null || Array.isArray(catalog) || typeof catalog !== "object") {
        process.exit(1);
      }
    ' "$catalog" >/dev/null || return 1
  done
  [ "$found" -eq 1 ]
}

case "$bun_path" in
  /*) ;;
  *) printf '%s\n' "bun must resolve to an absolute path" >&2; exit 1 ;;
esac

mkdir -p "$state_home/bin" "$state_home/logs" "$state_home/run" "$(dirname "$plist")"
rm -rf "$library_stage" "$library_previous"
mkdir -p "$library_stage"
cp "$repo_root/package.json" "$repo_root/bun.lock" "$library_stage/"
cp -R "$repo_root/daemon" "$library_stage/daemon"
rm -rf "$library_stage/daemon/node_modules"
(
  cd "$library_stage"
  "$bun_path" install --frozen-lockfile --production
)
if ! model_catalog_valid; then
  rm -rf "$library_stage/node_modules" "$library_stage/daemon/node_modules"
  (
    cd "$library_stage"
    "$bun_path" install --force --frozen-lockfile --production
  )
fi
model_catalog_valid || {
  printf '%s\n' "installed AI package has no valid model catalog; existing daemon was left untouched" >&2
  exit 1
}
# The staged tree must at least parse and start. A checkout with unresolved
# merge markers, or a missing module, would otherwise be copied into lib/ and
# only fail on the next restart — leaving the daemon down with the panel
# saying "restarting". Boot it once in a throwaway HOME and require it to
# still be alive after a few seconds.
if grep -rlE '^(<<<<<<<|>>>>>>>) ' "$library_stage/daemon/src" >/dev/null 2>&1; then
  printf '%s\n' "daemon source has unresolved merge conflict markers; existing daemon was left untouched:" >&2
  grep -rlE '^(<<<<<<<|>>>>>>>) ' "$library_stage/daemon/src" >&2
  exit 1
fi
smoke_home=$(mktemp -d -t oi-smoke)
mkdir -p "$smoke_home/.openinstinct/logs" "$smoke_home/.openinstinct/run"
( cd "$library_stage" && HOME="$smoke_home" OI_CONTROL_SOCKET="$smoke_home/.openinstinct/run/control.sock" \
    "$bun_path" daemon/src/main.ts >"$smoke_home/boot.log" 2>&1 ) &
smoke_pid=$!
i=0; while [ "$i" -lt 60 ] && kill -0 "$smoke_pid" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
if kill -0 "$smoke_pid" 2>/dev/null; then
  kill "$smoke_pid" 2>/dev/null; wait "$smoke_pid" 2>/dev/null || true
  rm -rf "$smoke_home"
else
  wait "$smoke_pid" 2>/dev/null; smoke_rc=$?
  printf '%s\n' "daemon failed to start from the staged source (exit $smoke_rc); existing daemon was left untouched:" >&2
  tail -n 15 "$smoke_home/boot.log" >&2
  rm -rf "$smoke_home"
  exit 1
fi
# Wait (up to ~5 s) for every process matching a pattern to exit. bootout and
# pkill return before the process is gone; replacing a bundle while its old
# binary is still mapped is how a "stale" panel or a launchd respawn of the
# previous copy happens.
wait_gone() {
  i=0
  while pgrep -f "$1" >/dev/null 2>&1 && [ "$i" -lt 50 ]; do
    sleep 0.1; i=$((i + 1))
  done
}

# Stop the agent before touching its executable: overwriting a running, TCC-trusted
# binary in place makes launchd kill the next spawn with OS_REASON_CODESIGNING.
if launchctl print "gui/$uid/co.openinstinct.daemon" >/dev/null 2>&1; then
  daemon_pid=$(launchctl print "gui/$uid/co.openinstinct.daemon" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -1)
  launchctl bootout "gui/$uid/co.openinstinct.daemon" 2>/dev/null || true
  i=0
  while [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null && [ "$i" -lt 50 ]; do
    sleep 0.1; i=$((i + 1))
  done
fi
if [ -d "$library" ]; then
  mv "$library" "$library_previous"
fi
if ! mv "$library_stage" "$library"; then
  [ ! -d "$library_previous" ] || mv "$library_previous" "$library"
  exit 1
fi
library_stage=
rm -rf "$library_previous"
library_previous=
# Keep the same inode (and TCC grant) unless bun itself changed.
if ! cmp -s "$bun_path" "$binary"; then
  cp "$bun_path" "$binary.new"
  chmod 700 "$binary.new"
  mv -f "$binary.new" "$binary"
fi
# gjc: the exact SDK version, owned by OpenInstinct, isolated state dir.
sh "$repo_root/scripts/install-gjc.sh" "$repo_root" "${OI_GJC_PAYLOAD:-}"
# Presence helper (typing / read receipts). Prebuilt in the payload, or built here.
if [ -x "$repo_root/presence/.build/release/oi-presence" ]; then
  cp "$repo_root/presence/.build/release/oi-presence" "$state_home/bin/oi-presence.new"
elif command -v swift >/dev/null 2>&1; then
  swift build --package-path "$repo_root/presence" -c release >/dev/null
  cp "$repo_root/presence/.build/release/oi-presence" "$state_home/bin/oi-presence.new"
fi
if [ -f "$state_home/bin/oi-presence.new" ]; then
  chmod 755 "$state_home/bin/oi-presence.new"
  mv -f "$state_home/bin/oi-presence.new" "$state_home/bin/oi-presence"
fi
# `gjc` (vendored) is a `#!/usr/bin/env bun` shim; expose our runtime as `bun`.
ln -sf "$binary" "$state_home/bin/bun"
"$bun_path" "$repo_root/scripts/render-plist.ts" "$home_dir" "$plist"
plutil -lint "$plist"
launchctl bootstrap "gui/$uid" "$plist"
# macOS 26 defers RunAtLoad/KeepAlive nondemand spawns ("inefficient" heuristic);
# kickstart guarantees the daemon is actually started after (re)install.
launchctl kickstart "gui/$uid/co.openinstinct.daemon"

# Menu-bar panel: build, install to ~/Applications, and run it at login.
if [ -d "$repo_root/panel/.build/OpenInstinctPanel.app" ] || command -v swift >/dev/null 2>&1; then
  if [ "${OI_SKIP_PANEL_BUILD:-0}" != "1" ] && command -v swift >/dev/null 2>&1; then
    bash "$repo_root/scripts/build-panel.sh" >/dev/null
  fi
  panel_app="$home_dir/Applications/OpenInstinctPanel.app"
  panel_plist="$home_dir/Library/LaunchAgents/co.openinstinct.panel.plist"
  mkdir -p "$home_dir/Applications"
  # bootout first so launchd's KeepAlive cannot respawn the old bundle in the
  # window between pkill and the new copy landing; then wait for exit.
  launchctl bootout "gui/$uid/co.openinstinct.panel" 2>/dev/null || true
  pkill -f "OpenInstinctPanel.app/Contents/MacOS/OpenInstinctPanel" 2>/dev/null || true
  wait_gone "OpenInstinctPanel.app/Contents/MacOS/OpenInstinctPanel"
  rm -rf "$panel_app"
  cp -R "$repo_root/panel/.build/OpenInstinctPanel.app" "$panel_app"
  cat > "$panel_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>co.openinstinct.panel</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-W</string><string>-a</string><string>$panel_app</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
PLIST
  plutil -lint "$panel_plist"
  launchctl bootstrap "gui/$uid" "$panel_plist"
  launchctl kickstart "gui/$uid/co.openinstinct.panel"
fi
