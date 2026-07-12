#!/usr/bin/env bash
# Commit+push every agent workspace under /opt/paracoding-mcp/work/<agent> that is a git repo.
# Runs as root (reads the org token). Token is used transiently, NEVER stored in .git/config.
set -uo pipefail
export HOME=/root
GH=$(cat /etc/fleet/gh_token 2>/dev/null)
[ -n "$GH" ] || { echo "no token"; exit 1; }
git config --global --add safe.directory '*' 2>/dev/null || true
for d in /opt/paracoding-mcp/work/*/; do
  [ -d "${d}.git" ] || continue
  cd "$d" || continue
  raw=$(git remote get-url origin 2>/dev/null || echo "")
  case "$raw" in https://*) : ;; *) continue ;; esac
  clean=$(printf '%s' "$raw" | sed -E 's#https://[^@]*@#https://#')
  [ "$clean" != "$raw" ] && git remote set-url origin "$clean"   # scrub stored credential every run
  git add -A 2>/dev/null || continue
  git diff --cached --quiet && continue
  name=$(basename "$d")
  push_url=$(printf '%s' "$clean" | sed -E "s#https://#https://x-access-token:${GH}@#")
  git -c user.email=autosync@example.com -c user.name=paracoding-autosync commit -q -m "autosync $(date -u +%FT%TZ)"
  if git push -q "$push_url" HEAD:main 2>err.log; then echo "synced $name"; else echo "$name push FAILED:"; sed "s#${GH}#TOKEN#g" err.log; fi
  rm -f err.log
done
