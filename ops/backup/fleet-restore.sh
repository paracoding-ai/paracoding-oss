#!/bin/bash
# fleet-restore.sh -- restore an archive made by fleet-backup.sh. Runs as ROOT; DB ops as gitlab-psql.  [FLEET-BACKUP-V2]
# Usage:
#   fleet-restore.sh --archive <path|gs://...> --verify
#       -> NON-destructive: restores the fleet DB dump into a scratch database, reports row counts,
#          drops it, and reports what else the archive carries (GitLab tar + version, lake file count).
#   fleet-restore.sh --archive <...> [--gitlab] [--db fleet] [--config] [--lake] --confirm
#       -> DESTRUCTIVE restore onto a rebuilt box (run the installer first):
#          --gitlab  /etc/gitlab/{gitlab-secrets.json,gitlab.rb} + runner config.toml, then gitlab-backup restore.
#                    GitLab must already be installed at the archive's gitlab_version (checked first).
#          --db      the fleet DB dump into <db>       --config  /etc/fleet       --lake  /srv/fleet/lake
#       Existing files are kept as *.pre-restore.<ts>. Secret Manager is not in the archive (it lives in GCP).
set -uo pipefail
GCLOUD=/srv/fleet/google-cloud-sdk/bin/gcloud; [ -x "$GCLOUD" ] || GCLOUD=$(command -v gcloud)
GSUTIL=/srv/fleet/google-cloud-sdk/bin/gsutil; [ -x "$GSUTIL" ] || GSUTIL=$(command -v gsutil)
PGREST=/opt/gitlab/embedded/bin/pg_restore
PSQL=/opt/gitlab/embedded/bin/psql
PROJECT=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/project-id)  # [V21-PARAM]
LAKEDIR=/srv/fleet/lake
GLVERFILE=/opt/gitlab/embedded/service/gitlab-rails/VERSION
ADMINURL="postgres://gitlab-psql@/postgres?host=/var/opt/gitlab/postgresql"
ARCHIVE=""; PASS="${BACKUP_PASSPHRASE:-}"; DB=""; DO_CONFIG=0; DO_SECRETS=0; DO_LAKE=0; DO_GITLAB=0; CONFIRM=0; VERIFY=0
while [ $# -gt 0 ]; do case "$1" in
  --archive) ARCHIVE="$2"; shift 2;;
  --db) DB="$2"; shift 2;;
  --verify) VERIFY=1; shift;;
  --config) DO_CONFIG=1; shift;;
  --secrets) DO_SECRETS=1; shift;;
  --lake) DO_LAKE=1; shift;;
  --gitlab) DO_GITLAB=1; shift;;
  --confirm) CONFIRM=1; shift;;
  *) shift;;
esac; done
rfail(){ echo "{\"ok\":false,\"error\":\"${1//\"/}\"}"; exit 1; }
[ -n "$ARCHIVE" ] || rfail "--archive required"
PASS=""
if [ -n "${BACKUP_PASSFILE:-}" ] && [ -f "$BACKUP_PASSFILE" ]; then PASS="$(cat "$BACKUP_PASSFILE")"; shred -u "$BACKUP_PASSFILE" 2>/dev/null || rm -f "$BACKUP_PASSFILE"; fi
WORK=$(mktemp -d /var/tmp/fleet-restore-XXXXXX); trap 'rm -rf "$WORK"' EXIT
LOCAL="$WORK/archive"
if [ "${ARCHIVE:0:5}" = "gs://" ]; then $GSUTIL -q cp "$ARCHIVE" "$LOCAL" || rfail "download failed"; else cp "$ARCHIVE" "$LOCAL" 2>/dev/null || rfail "archive not found"; fi
mkdir -p "$WORK/x"
# Plain .tar.gz is the current format; .tar.zst / .tar.zst.gpg still accepted so OLDER backups restore too.
case "$ARCHIVE" in
  *.tar.gz|*.tgz) tar -C "$WORK/x" -xzf "$LOCAL" || rfail "untar (gzip) failed" ;;
  *.tar.zst) zstd -d -q -f "$LOCAL" -o "$WORK/a.tar" && tar -C "$WORK/x" -xf "$WORK/a.tar" || rfail "untar (zstd) failed" ;;
  *.gpg) P="$PASS"; [ -n "$P" ] || P="$($GCLOUD secrets versions access latest --secret=backup-archive-key --project=$PROJECT 2>/dev/null)"; [ -n "$P" ] || rfail "encrypted archive needs the managed key"; printf '%s' "$P" | gpg --batch --yes --passphrase-fd 0 --pinentry-mode loopback --decrypt -o "$WORK/a.tar.zst" "$LOCAL" 2>/dev/null || rfail "decrypt failed"; zstd -d -q -f "$WORK/a.tar.zst" -o "$WORK/a.tar" && tar -C "$WORK/x" -xf "$WORK/a.tar" || rfail "untar failed" ;;
  *) rfail "unknown archive type: $ARCHIVE" ;;
esac
rm -f "$LOCAL" "$WORK/a.tar" "$WORK/a.tar.zst"
[ -f "$WORK/x/db/fleet.dump" ] || rfail "archive missing db/fleet.dump"
MAN=$(cat "$WORK/x/MANIFEST.json" 2>/dev/null || echo '{}')
chown -R gitlab-psql:gitlab-psql "$WORK/x/db"; chmod a+rX "$WORK" "$WORK/x" "$WORK/x/db"

GT=$(ls "$WORK/x/gitlab"/*_gitlab_backup.tar 2>/dev/null | head -1)
GID=""; GVER=""
if [ -n "$GT" ]; then
  GID=$(basename "$GT" _gitlab_backup.tar)
  GVER=$(echo "$GID" | sed -E 's/^[0-9]+_[0-9]{4}_[0-9]{2}_[0-9]{2}_//')
fi
HAVE_VER=$(cat "$GLVERFILE" 2>/dev/null || echo none)
LAKEN=$( [ -d "$WORK/x/lake" ] && find "$WORK/x/lake" -type f | wc -l || echo 0 )

if [ "$VERIFY" = 1 ]; then
  SDB="fleet_rstverify_$$"
  su -s /bin/bash gitlab-psql -c "$PSQL '$ADMINURL' -q -c 'drop database if exists $SDB' -c 'create database $SDB'" 2>/dev/null || rfail "scratch db create failed"
  su -s /bin/bash gitlab-psql -c "$PGREST -d 'postgres://gitlab-psql@/$SDB?host=/var/opt/gitlab/postgresql' --no-owner --no-privileges '$WORK/x/db/fleet.dump'" >/dev/null 2>&1 || true
  CNT=$(su -s /bin/bash gitlab-psql -c "$PSQL 'postgres://gitlab-psql@/$SDB?host=/var/opt/gitlab/postgresql' -tAc \"select json_build_object('oa_journal',(select count(*) from oa.journal),'oa_kv',(select count(*) from oa.kv),'oa_chat_history',(select count(*) from oa.chat_history),'oa_mem_entities',(select count(*) from oa.mem_entities),'vrp_findings',(select count(*) from vrp.findings),'vrp_leads',(select count(*) from vrp.leads))\"" 2>/dev/null)
  su -s /bin/bash gitlab-psql -c "$PSQL '$ADMINURL' -q -c 'drop database if exists $SDB'" 2>/dev/null || true
  GTOK=false; [ -n "$GT" ] && tar -tf "$GT" backup_information.yml >/dev/null 2>&1 && GTOK=true
  GSEC=false; [ -s "$WORK/x/gitlab/gitlab-secrets.json" ] && GSEC=true
  echo "{\"ok\":true,\"mode\":\"verify\",\"restored_counts\":${CNT:-null},\"gitlab\":{\"tar\":\"${GID}\",\"tar_readable\":$GTOK,\"secrets_present\":$GSEC,\"backup_version\":\"$GVER\",\"installed_version\":\"$HAVE_VER\"},\"lake_files\":$LAKEN,\"manifest\":$MAN}"
  exit 0
fi

[ "$CONFIRM" = 1 ] || rfail "destructive restore requires --confirm"
T0=$(date +%s); R=""
keep(){ [ -e "$1" ] && cp -a "$1" "$1.pre-restore.$T0"; return 0; }

# GitLab first: it owns the Postgres cluster the fleet DB lives in.
if [ "$DO_GITLAB" = 1 ]; then
  [ -n "$GT" ] || rfail "archive has no gitlab backup tar (core-scope backup?)"
  [ "$GVER" = "$HAVE_VER" ] || rfail "GitLab version mismatch: backup is $GVER, installed is $HAVE_VER. Install gitlab-ce=$GVER-ce.0 first."
  GLLOG=/var/tmp/fleet-restore-gitlab-$T0.log
  for f in gitlab-secrets.json gitlab.rb; do keep "/etc/gitlab/$f"; cp -a "$WORK/x/gitlab/$f" "/etc/gitlab/$f" || rfail "copy $f failed"; done
  if [ -f "$WORK/x/gitlab/gitlab-runner-config.toml" ]; then mkdir -p /etc/gitlab-runner; keep /etc/gitlab-runner/config.toml; cp -a "$WORK/x/gitlab/gitlab-runner-config.toml" /etc/gitlab-runner/config.toml; fi
  cp "$GT" /var/opt/gitlab/backups/ && chown git:git "/var/opt/gitlab/backups/$(basename "$GT")" || rfail "stage gitlab tar failed"
  { gitlab-ctl reconfigure && gitlab-ctl stop puma && gitlab-ctl stop sidekiq \
    && GITLAB_ASSUME_YES=1 gitlab-backup restore BACKUP="$GID" force=yes \
    && gitlab-ctl restart; } > "$GLLOG" 2>&1 || rfail "gitlab restore failed -- see $GLLOG"
  systemctl restart gitlab-runner 2>/dev/null || true
  R="$R gitlab:$GID"
fi
if [ -n "$DB" ]; then
  su -s /bin/bash gitlab-psql -c "$PSQL '$ADMINURL' -q -tAc \"select 1 from pg_database where datname='$DB'\"" 2>/dev/null | grep -q 1 || su -s /bin/bash gitlab-psql -c "$PSQL '$ADMINURL' -q -c 'create database $DB'" 2>/dev/null || true
  su -s /bin/bash gitlab-psql -c "$PGREST -d 'postgres://gitlab-psql@/$DB?host=/var/opt/gitlab/postgresql' --clean --if-exists --no-owner --no-privileges '$WORK/x/db/fleet.dump'" >/dev/null 2>&1 || true
  R="$R db:$DB"
fi
if [ "$DO_CONFIG" = 1 ] && [ -d "$WORK/x/etc-fleet" ]; then mkdir -p /etc/fleet; for f in "$WORK/x/etc-fleet"/*; do keep "/etc/fleet/$(basename "$f")"; done; cp -a "$WORK/x/etc-fleet/." /etc/fleet/; R="$R config"; fi
if [ "$DO_SECRETS" = 1 ] && [ -d "$WORK/x/secrets" ]; then
  for f in "$WORK/x/secrets"/*; do [ -f "$f" ] || continue; n=$(basename "$f"); $GCLOUD secrets create "$n" --project=$PROJECT --replication-policy=automatic >/dev/null 2>&1 || true; $GCLOUD secrets versions add "$n" --project=$PROJECT --data-file="$f" >/dev/null 2>&1 || true; done
  R="$R secrets"
fi
if [ "$DO_LAKE" = 1 ] && [ -d "$WORK/x/lake" ]; then mkdir -p "$LAKEDIR"; cp -a "$WORK/x/lake/." "$LAKEDIR/" || rfail "lake copy failed"; R="$R lake"; fi
echo "{\"ok\":true,\"mode\":\"restore\",\"restored\":\"$(echo $R | xargs)\",\"manifest\":$MAN}"
