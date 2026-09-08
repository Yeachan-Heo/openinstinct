#!/usr/bin/env sh
# Installs the gjc binary OpenInstinct owns: exactly the version of the vendored
# SDK (@gajae-code/coding-agent in daemon/package.json), into ~/.openinstinct/bin/gjc.
# A host-wide `gjc` (any version) is never used by the daemon.
set -eu
repo_root=${1:?repo root}
state_home="${HOME:?}/.openinstinct"
payload_bin="${2:-}"   # optional prebuilt binary from the release payload

version=$(sed -nE 's/.*"@gajae-code\/coding-agent": *"([0-9][^"]*)".*/\1/p' "$repo_root/daemon/package.json" | head -1)
[ -n "$version" ] || { echo "cannot read SDK version from daemon/package.json" >&2; exit 1; }
target="$state_home/bin/gjc"
mkdir -p "$state_home/bin" "$state_home/gjc"

current=$("$target" --version 2>/dev/null | sed -nE 's#^gjc/([0-9][^ ]*).*#\1#p' || true)
if [ "$current" = "$version" ]; then
  exit 0
fi

if [ -n "$payload_bin" ] && [ -x "$payload_bin" ]; then
  cp "$payload_bin" "$target.new"
else
  case "$(uname -m)" in
    arm64) asset=gjc-darwin-arm64 ;;
    x86_64) asset=gjc-darwin-x64 ;;
    *) echo "unsupported architecture" >&2; exit 1 ;;
  esac
  curl -fsSL "https://github.com/Yeachan-Heo/gajae-code/releases/download/v$version/$asset" -o "$target.new"
fi
chmod 755 "$target.new"
xattr -d com.apple.quarantine "$target.new" 2>/dev/null || true
mv -f "$target.new" "$target"
"$target" --version >/dev/null

# First install: carry over the host's OAuth credentials so the owner does not
# sign in twice. Later drift stays isolated because the copy is one-time.
# models.yml is deliberately not copied: the daemon symlinks it to the host's
# so provider edits in ~/.gjc/agent/models.yml show up without a re-import.
if [ ! -f "$state_home/gjc/.imported" ] && [ -d "$HOME/.gjc/agent" ] && ! pgrep -qf "openinstinctd .*main.ts"; then
  for f in auth.db agent.db; do
    if [ -f "$HOME/.gjc/agent/$f" ]; then
      # sqlite3 backup copies a consistent snapshot including WAL contents.
      case "$f" in
        *.db) sqlite3 "$HOME/.gjc/agent/$f" ".backup '$state_home/gjc/$f'" 2>/dev/null || cp "$HOME/.gjc/agent/$f" "$state_home/gjc/$f" ;;
        *) cp "$HOME/.gjc/agent/$f" "$state_home/gjc/$f" ;;
      esac
      chmod 600 "$state_home/gjc/$f"
    fi
  done
  date -u +%FT%TZ > "$state_home/gjc/.imported"
fi
printf 'gjc %s installed at %s\n' "$version" "$target"
