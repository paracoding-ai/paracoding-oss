#!/bin/bash
# fleet-backup.sh -- one-file PLAIN (.tar.gz) system backup -> GCS.  [FLEET-BACKUP-V2 2026-10-31]
# Built from LOCAL paths only: the consolidated vmcp box holds everything a rebuild needs, and the
# old GCS data-lake bucket no longer exists.
#   core: db/fleet.dump  (Postgres `fleet` -- oa, vrp, public, msgraph_authz ...)
#         etc-fleet/     (/etc/fleet: control-plane.env, gate-exec.env, install.conf, ops-token, fleet-pg.env)
#   full: core + lake/   (/srv/fleet/lake)
#              + gitlab/ (a FRESH gitlab-backup tar = repos + CI + gitlabhq_production, plus
#                         gitlab-secrets.json, gitlab.rb and the gitlab-runner config.toml)
# Secret Manager is NOT included: it lives in GCP and survives the VM.
# THE ARCHIVE IS NOT ENCRYPTED and contains gitlab-secrets.json and /etc/fleet tokens -- guard the bucket.
# Runs as ROOT (ops-exec root daemon). Records state in oa.backups.
# Env: BACKUP_SCOPE=full|core (default full), BACKUP_ID (default bk_<ts>), BACKUP_BY (default operator),
#      BACKUP_KEEP (default 7: newest archives of this scope kept in the bucket; older ones pruned).
set -uo pipefail
GSUTIL=/srv/fleet/google-cloud-sdk/bin/gsutil; [ -x "$GSUTIL" ] || GSUTIL=$(command -v gsutil)  # [V21-PARAM]
PGDUMP=/opt/gitlab/embedded/bin/pg_dump
PSQL=/opt/gitlab/embedded/bin/psql
LAKEDIR=/srv/fleet/lake
GLBK=/var/opt/gitlab/backups
[ -f /etc/fleet/backup.env ] && . /etc/fleet/backup.env  # [V21-PARAM] written by the installer
BACKUPS="${BACKUP_BUCKET:?set BACKUP_BUCKET in /etc/fleet/backup.env}"
PGSOCK="postgres://fleet@/fleet?host=/var/opt/gitlab/postgresql"
PGSUPER="postgres://gitlab-psql@/fleet?host=/var/opt/gitlab/postgresql"
SCOPE="${BACKUP_SCOPE:-full}"
BY="${BACKUP_BY:-operator}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
ID="${BACKUP_ID:-bk_$TS}"
BASE="fleet-backup-$TS-$SCOPE"
STAGE="/var/tmp/$BASE"; ARCHIVE="/var/tmp/$BASE.tar.gz"
GLTAR=""

pgq() { su -s /bin/bash fleet -c "$PSQL '$PGSOCK' -q -v ON_ERROR_STOP=1" >/dev/null 2>&1; }
cleanup() { rm -rf "$STAGE" "$ARCHIVE" "/var/tmp/$BASE.meta.json" 2>/dev/null; }
fail() { local m="${1//$/}"; m="${m//\"/}"; { printf "update oa.backups set status='failed', error=\$\$%s\$\$, finished_at=now() where id='%s';\n" "$m" "$ID"; } | pgq; echo "{\"ok\":false,\"id\":\"$ID\",\"error\":\"$m\"}"; cleanup; exit 1; }

case "$SCOPE" in full|core) ;; *) echo '{"ok":false,"error":"scope must be full or core"}'; exit 1;; esac

{ printf 'create schema if not exists oa; create table if not exists oa.backups (id text primary key, created_at timestamptz not null default now(), scope text, status text, object text, bucket text, size_bytes bigint, sha256 text, manifest jsonb, error text, created_by text, finished_at timestamptz);\n'; } | pgq || true
{ printf "insert into oa.backups (id,scope,status,bucket,created_by) values ('%s','%s','running','%s','%s') on conflict (id) do update set status='running', error=null;\n" "$ID" "$SCOPE" "$BACKUPS" "${BY//\'/}"; } | pgq || true

mkdir -p "$STAGE/db" "$STAGE/etc-fleet"
chown gitlab-psql:gitlab-psql "$STAGE/db"

# 1. fleet DB (custom compressed format)
su -s /bin/bash gitlab-psql -c "$PGDUMP '$PGSUPER' -Fc -Z6 -f '$STAGE/db/fleet.dump'" || fail "pg_dump failed"

# 2. config (live files only; the *.bak* copies are not needed for a rebuild)
cp -a /etc/fleet/. "$STAGE/etc-fleet/" 2>/dev/null || true
find "$STAGE/etc-fleet" -name '*.bak*' -delete 2>/dev/null || true

# 3. full only: GitLab (fresh backup + the files a GitLab restore cannot work without) and the lake
TARX=()
GLVER=null; GLREF=null; LAKEREF=null
if [ "$SCOPE" = "full" ]; then
  [ -d "$LAKEDIR" ] || fail "lake dir $LAKEDIR missing"
  mkdir -p "$STAGE/gitlab"
  BEFORE=$(ls -t $GLBK/*_gitlab_backup.tar 2>/dev/null | head -1)
  GITLAB_ASSUME_YES=1 /usr/bin/gitlab-backup create CRON=1 > "$STAGE/gitlab/gitlab-backup-create.log" 2>&1 || fail "gitlab-backup create failed"
  GLTAR=$(ls -t $GLBK/*_gitlab_backup.tar 2>/dev/null | head -1)
  { [ -n "$GLTAR" ] && [ "$GLTAR" != "$BEFORE" ]; } || fail "gitlab-backup produced no new tar"
  ln "$GLTAR" "$STAGE/gitlab/" 2>/dev/null || cp -a "$GLTAR" "$STAGE/gitlab/" || fail "gitlab tar stage failed"
  cp -a /etc/gitlab/gitlab-secrets.json /etc/gitlab/gitlab.rb "$STAGE/gitlab/" || fail "gitlab config copy failed"
  cp -a /etc/gitlab-runner/config.toml "$STAGE/gitlab/gitlab-runner-config.toml" 2>/dev/null || true
  GLN=$(basename "$GLTAR"); GLREF="\"gitlab/$GLN\""
  GLVER="\"$(echo "$GLN" | sed -E 's/^[0-9]+_[0-9]{4}_[0-9]{2}_[0-9]{2}_(.+)_gitlab_backup\.tar$/\1/')\""
  LAKEREF='"lake/"'
  TARX=(-C /srv/fleet lake)
fi

# 4. manifest
OSS_SHA=$(git -C /srv/fleet/src -c safe.directory=/srv/fleet/src rev-parse HEAD 2>/dev/null || echo unknown)
DBSHA=$(sha256sum "$STAGE/db/fleet.dump" | cut -d' ' -f1)
cat > "$STAGE/MANIFEST.json" <<EOF
{"id":"$ID","format":"fleet-backup-v2","created_at":"$TS","scope":"$SCOPE","hostname":"$(hostname)","oss_git_sha":"$OSS_SHA","pg_version":"17","gitlab_version":$GLVER,"created_by":"$BY","components":{"db":"db/fleet.dump","config":"etc-fleet/","lake":$LAKEREF,"gitlab":$GLREF},"db_sha256":"$DBSHA","restore":"tar -xzf FILE.tar.gz (or any archive tool), then ops/backup/fleet-restore.sh --archive FILE --gitlab --db fleet --config --lake --confirm. GitLab must be installed at gitlab_version first."}
EOF

# 5. tar + gzip -1 (the big parts are already compressed). A file changing under tar is a warning, not a failure.
tar -C "$STAGE" --warning=no-file-changed -cf - . "${TARX[@]}" | gzip -1 > "$ARCHIVE"
PS=("${PIPESTATUS[@]}")
{ [ "${PS[0]}" -le 1 ] && [ "${PS[1]}" -eq 0 ]; } || fail "tar/gzip failed (tar=${PS[0]} gzip=${PS[1]})"

SIZE=$(stat -c%s "$ARCHIVE"); SHA=$(sha256sum "$ARCHIVE" | cut -d' ' -f1); OBJ="$BASE.tar.gz"

# 6. upload archive + sidecar meta (no secrets in meta)
$GSUTIL -q cp "$ARCHIVE" "gs://$BACKUPS/$OBJ" || fail "upload failed"
cat > "/var/tmp/$BASE.meta.json" <<EOF
{"id":"$ID","ts":"$TS","scope":"$SCOPE","object":"$OBJ","bucket":"$BACKUPS","size_bytes":$SIZE,"sha256":"$SHA","db_sha256":"$DBSHA","oss_git_sha":"$OSS_SHA","gitlab_version":$GLVER,"encrypted":false,"status":"done"}
EOF
$GSUTIL -q cp "/var/tmp/$BASE.meta.json" "gs://$BACKUPS/$OBJ.meta.json" || true

# 7. record done
MAN=$(cat "$STAGE/MANIFEST.json")
{ printf "update oa.backups set status='done', object='%s', size_bytes=%s, sha256='%s', finished_at=now(), manifest=\$\$" "$OBJ" "$SIZE" "$SHA"; printf '%s' "$MAN"; printf "\$\$::jsonb where id='%s';\n" "$ID"; } | pgq || true

# 8. retention: keep the newest $BACKUP_KEEP archives of THIS scope in the bucket (default 7).
#    Names sort by their UTC timestamp, so lexical order is age order.
KEEP="${BACKUP_KEEP:-7}"
if [ "$KEEP" -ge 1 ] 2>/dev/null; then
  $GSUTIL ls "gs://$BACKUPS/fleet-backup-*-$SCOPE.tar.gz" 2>/dev/null | sort | head -n -"$KEEP" | while read -r o; do
    [ -n "$o" ] || continue
    $GSUTIL -q rm "$o" 2>/dev/null && $GSUTIL -q rm "$o.meta.json" 2>/dev/null
    { printf "update oa.backups set status='pruned' where object='%s';\n" "$(basename "$o")"; } | pgq || true
    echo "pruned $o" >&2
  done
fi

# the GitLab tar this run made now lives in the archive; do not let local copies pile up
[ -n "$GLTAR" ] && rm -f "$GLTAR"
cleanup
echo "{\"ok\":true,\"id\":\"$ID\",\"object\":\"$OBJ\",\"bucket\":\"$BACKUPS\",\"size_bytes\":$SIZE,\"sha256\":\"$SHA\",\"scope\":\"$SCOPE\",\"gitlab_version\":$GLVER}"
