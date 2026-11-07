#!/bin/bash
# Paracoding v21 VM first boot (instance startup-script). Every value comes from instance metadata.
# Each stage runs once (markers in /var/lib/paracoding); progress goes to the serial console as PARACODING-*.
set -uo pipefail
S=/var/lib/paracoding; mkdir -p $S
md(){ curl -s -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
say(){ echo "PARACODING-STEP $*"; }
fail(){ echo "PARACODING-FAILED $*"; exit 1; }
[ -f $S/ready ] && { echo "PARACODING-READY (installed earlier)"; exit 0; }
P=$(md project/project-id); PN=$(md project/numeric-project-id)
CON=$(md instance/attributes/console-url); MCP=$(md instance/attributes/mcp-url); ADMIN=$(md instance/attributes/admin-email)
SRC=$(md instance/attributes/source-uri); BK=$(md instance/attributes/backup-bucket); GLV=$(md instance/attributes/gitlab-version)
ZONE=$(md instance/zone | awk -F/ '{print $NF}'); R=${ZONE%-*}; VM=$(hostname)
export DEBIAN_FRONTEND=noninteractive
PSQL="/opt/gitlab/embedded/bin/psql -h /var/opt/gitlab/postgresql"

if [ ! -f $S/gitlab ]; then say "gitlab $GLV"
  apt-get update -qq >/dev/null; apt-get install -y -qq curl openssh-server ca-certificates tzdata perl python3 >/dev/null
  curl -fsSL https://packages.gitlab.com/install/repositories/gitlab/gitlab-ce/script.deb.sh | bash >/dev/null 2>&1
  mkdir -p /etc/gitlab; cat > /etc/gitlab/gitlab.rb <<RB
external_url '$CON/gitlab'
nginx['listen_port'] = 80
nginx['listen_https'] = false
nginx['proxy_set_headers'] = { "X-Forwarded-Proto" => "https", "X-Forwarded-Ssl" => "on", "Host" => "\$http_host" }
nginx['custom_gitlab_server_config'] = "rewrite ^/gitlab/gitlab/(.*)\$ /gitlab/\$1 last;\n"
postgresql['custom_pg_hba_entries'] = { 'fleet' => [ { 'type' => 'local', 'database' => 'fleet', 'user' => 'fleet', 'cidr' => '', 'method' => 'trust' } ] }
puma['worker_processes'] = 2
prometheus_monitoring['enable'] = false
gitlab_rails['usage_ping_enabled'] = false
RB
  EXTERNAL_URL="$CON/gitlab" apt-get install -y -qq "gitlab-ce=${GLV}-ce.0" >/var/log/paracoding-gitlab-install.log 2>&1 || fail "gitlab install, see /var/log/paracoding-gitlab-install.log"
  touch $S/gitlab; fi

if [ ! -f $S/controlplane ]; then say "control plane"
  gcloud storage cp "$SRC" /tmp/src.tgz --quiet || fail "source download $SRC"
  rm -rf /srv/fleet/src; mkdir -p /srv/fleet/src; tar -xzf /tmp/src.tgz -C /srv/fleet/src
  id fleet >/dev/null 2>&1 || useradd --system --home-dir /srv/fleet --shell /usr/sbin/nologin fleet
  mkdir -p /srv/fleet/lake /etc/fleet; chown -R fleet:fleet /srv/fleet; chmod 750 /etc/fleet; chgrp fleet /etc/fleet
  command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1; apt-get install -y -qq nodejs >/dev/null; }
  cd /srv/fleet/src/control-plane && sudo -u fleet -H npm ci --no-audit --no-fund >/var/log/paracoding-npm.log 2>&1 \
    && sudo -u fleet -H npm run build >>/var/log/paracoding-npm.log 2>&1 || fail "control-plane build, see /var/log/paracoding-npm.log"
  for i in $(seq 1 60); do [ -S /var/opt/gitlab/postgresql/.s.PGSQL.5432 ] && break; sleep 5; done
  sudo -u gitlab-psql $PSQL -d postgres -tAc "select 1 from pg_roles where rolname='fleet'" | grep -q 1 || sudo -u gitlab-psql $PSQL -d postgres -qc "create role fleet login"
  sudo -u gitlab-psql $PSQL -d postgres -tAc "select 1 from pg_database where datname='fleet'" | grep -q 1 || sudo -u gitlab-psql $PSQL -d postgres -qc "create database fleet owner fleet"
  sudo -u fleet $PSQL -U fleet -d fleet -q -v ON_ERROR_STOP=1 -f /srv/fleet/src/ops/db/schema.sql || fail "fleet DB schema"
  cat > /etc/fleet/control-plane.env <<EOF
PORT=8090
GCP_PROJECT=$P
PC_CONSOLE_URL=$CON
GE_PUBLIC_URL=$CON
MCP_PUBLIC_URL=$MCP
PC_IAP_AUD=/projects/$PN/locations/$R/services/vmcp-ui
WA_APPROVER_EMAILS=$ADMIN
OAUTH_DEFAULT_ROLE=fleet-onboarder
PC_AUTO_APPROVE=1
PC_GUARDRAILS=0
PC_SESSION_ENFORCE=1
PC_TOOLS_ENFORCE=1
GATE_EXEC_URL=http://127.0.0.1:8091
PC_LAKE_LOCAL_ROOT=/srv/fleet/lake
DATA_LAKE_BUCKET=local-only
PC_GL_VM_NAME=$VM
PC_RUN_CONSOLE_SERVICE=vmcp-ui
PC_RUN_MCP_SERVICE=vmcp-mcp
PCGIT_BACKEND=gitlab
VERTEX_LOCATION=us-central1
EOF
  { echo "PC_PG_URL=postgres://fleet@/fleet?host=/var/opt/gitlab/postgresql"; for k in PC_OAUTH_STORE PC_STRAINS_STORE PC_JOURNAL_STORE PC_MEMORY_STORE PC_WORKITEMS_STORE PC_CHATHISTORY_STORE PC_KV_CONFIG PC_KV_MSG PC_KV_CONFIRMS PC_KV_SESS PC_KV_BUDGET PC_TOKENUSAGE PC_KV_CHAT PC_KV_EXEC; do echo "$k=pg"; done; } > /etc/fleet/fleet-pg.env
  echo "BACKUP_BUCKET=$BK" > /etc/fleet/backup.env
  chmod 640 /etc/fleet/*.env; chgrp fleet /etc/fleet/*.env
  cat > /usr/local/sbin/fleet-load-cp-secrets.sh <<'LOADER'
#!/bin/bash
set -uo pipefail; umask 077
MD=http://metadata.google.internal/computeMetadata/v1
P=$(curl -s -H Metadata-Flavor:Google $MD/project/project-id)
AT=$(curl -s -H Metadata-Flavor:Google $MD/instance/service-accounts/default/token | sed 's/.*"access_token":"//;s/".*//')
S(){ curl -s -H "Authorization: Bearer $AT" "https://secretmanager.googleapis.com/v1/projects/$P/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | sed 's/.*"data": *"//;s/"$//' | base64 -d 2>/dev/null; }
T=$(mktemp); { printf 'WA_SESSION_SECRET=%s\n' "$(S wa-session-secret)"; printf 'AGENT_TOKENS_B64=%s\n' "$(S agent-tokens-b64)"; printf 'APPROVAL_MAC_KEY=%s\n' "$(S approval-mac-key)"; } > $T
if grep -q '^WA_SESSION_SECRET=.\+' $T; then install -m 640 -o fleet -g fleet $T /run/fleet/control-plane-secrets.env; echo "[secret-loader] loaded $(grep -c '=.\+' $T)/3"; else echo "[secret-loader] WA_SESSION_SECRET empty; refusing" >&2; fi; rm -f $T
LOADER
  chmod 755 /usr/local/sbin/fleet-load-cp-secrets.sh
  cat > /etc/systemd/system/fleet-control-plane.service <<'UNIT'
[Unit]
Description=Paracoding control plane (Flow Hood console + MCP server)
After=network-online.target gitlab-runsvdir.service
Wants=network-online.target
[Service]
User=fleet
Group=fleet
WorkingDirectory=/srv/fleet/src/control-plane
RuntimeDirectory=fleet
RuntimeDirectoryMode=0750
ExecStartPre=+/usr/local/sbin/fleet-load-cp-secrets.sh
EnvironmentFile=/etc/fleet/control-plane.env
EnvironmentFile=/etc/fleet/fleet-pg.env
EnvironmentFile=-/run/fleet/control-plane-secrets.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/fleet /run/fleet
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable --now fleet-control-plane
  for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/.well-known/oauth-authorization-server); [ "$c" = 200 ] && break; sleep 3; done
  [ "$c" = 200 ] || fail "control plane did not come up: journalctl -u fleet-control-plane"
  touch $S/controlplane; fi

if [ ! -f $S/sso ]; then say "gitlab single sign-on"
  CID=""; for i in $(seq 1 60); do
    CID=$(curl -s -X POST "$MCP/oauth/register" -H 'content-type: application/json' -d "{\"client_name\":\"GitLab\",\"redirect_uris\":[\"$CON/gitlab/gitlab/users/auth/paracoding/callback\",\"$CON/gitlab/users/auth/paracoding/callback\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("client_id",""))' 2>/dev/null)
    [ -n "$CID" ] && break; sleep 10; done
  [ -n "$CID" ] || fail "could not register GitLab with $MCP/oauth/register (is the vmcp-mcp router deployed?)"
  cat >> /etc/gitlab/gitlab.rb <<RB
gitlab_rails['omniauth_enabled'] = true
gitlab_rails['omniauth_allow_single_sign_on'] = ['paracoding']
gitlab_rails['omniauth_block_auto_created_users'] = false
gitlab_rails['omniauth_auto_link_user'] = ['paracoding']
gitlab_rails['omniauth_providers'] = [
  { 'name' => 'paracoding', 'label' => 'Paracoding IAP', 'app_id' => '$CID', 'app_secret' => 'pkce-no-secret',
    'args' => { 'name' => 'paracoding', 'strategy_class' => 'OmniAuth::Strategies::OAuth2Generic',
      'client_options' => { 'site' => '$MCP', 'authorize_url' => '$CON/oauth/authorize', 'token_url' => '$MCP/oauth/token', 'user_info_url' => '$MCP/oauth/userinfo' },
      'authorize_params' => { 'scope' => 'mcp' }, 'pkce' => true,
      'user_response_structure' => { 'root_path' => [], 'id_path' => 'email', 'attributes' => { 'email' => 'email', 'name' => 'name', 'username' => 'email' } } } }
]
RB
  gitlab-ctl reconfigure >/var/log/paracoding-sso-reconfigure.log 2>&1 || fail "gitlab reconfigure for SSO, see /var/log/paracoding-sso-reconfigure.log"
  echo 'ApplicationSetting.current.update!(signup_enabled: false)' > /tmp/paracoding-nosignup.rb; chmod 644 /tmp/paracoding-nosignup.rb
  gitlab-rails runner /tmp/paracoding-nosignup.rb >/dev/null 2>&1 || echo "PARACODING-WARN could not disable GitLab sign-ups; do it in Admin > Settings"
  touch $S/sso; fi

if [ ! -f $S/extras ]; then say "backups, patching, idle-off"
  F=/srv/fleet/src/deploy/vmcp-install/files
  install -m 644 $F/apt/52vmcp-security-boot /etc/apt/apt.conf.d/52vmcp-security-boot
  install -m 644 $F/apt/fleet-series-pins /etc/apt/preferences.d/fleet-series-pins
  install -m 755 $F/vmcp-idle-off.sh /usr/local/sbin/vmcp-idle-off.sh
  for u in vmcp-security-updates.service vmcp-idle-off.service vmcp-idle-off.timer gitlab-gcs-backup.service gitlab-gcs-backup.timer; do install -m 644 $F/systemd/$u /etc/systemd/system/$u; done
  chmod 755 /srv/fleet/src/ops/backup/*.sh
  systemctl daemon-reload; systemctl enable vmcp-security-updates.service >/dev/null 2>&1; systemctl enable --now vmcp-idle-off.timer gitlab-gcs-backup.timer >/dev/null 2>&1
  touch $S/extras; fi

touch $S/ready; echo "PARACODING-READY console=$CON mcp=$MCP"
