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
# [BACKUP-CRYPT-V1] Secret Manager secret holding the backup passphrase (install.sh creates backup-passphrase).
# Absent -> backup-passphrase; "none" -> plain .tar.gz backups (not recommended).
BKSEC=$(curl -sf -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/instance/attributes/backup-encrypt-secret" || true)
BKSEC=${BKSEC:-backup-passphrase}; case "$BKSEC" in none) BKSEC="";; *[!A-Za-z0-9_-]*) fail "bad backup-encrypt-secret metadata";; esac
ZONE=$(md instance/zone | awk -F/ '{print $NF}'); R=${ZONE%-*}; VM=$(hostname)
export DEBIAN_FRONTEND=noninteractive
PSQL="/opt/gitlab/embedded/bin/psql -h /var/opt/gitlab/postgresql"

if [ ! -f $S/gitlab ]; then say "gitlab $GLV"
  apt-get update -qq >/dev/null; apt-get install -y -qq curl openssh-server ca-certificates tzdata perl python3 gnupg >/dev/null
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
  { echo "BACKUP_BUCKET=$BK"; [ -n "$BKSEC" ] && echo "BACKUP_ENCRYPT_SECRET=$BKSEC"; } > /etc/fleet/backup.env
  chmod 640 /etc/fleet/*.env; chgrp fleet /etc/fleet/*.env
  cat > /usr/local/sbin/fleet-load-cp-secrets.sh <<'LOADER'
#!/bin/bash
set -uo pipefail; umask 077
MD=http://metadata.google.internal/computeMetadata/v1
P=$(curl -s -H Metadata-Flavor:Google $MD/project/project-id)
AT=$(curl -s -H Metadata-Flavor:Google $MD/instance/service-accounts/default/token | sed 's/.*"access_token":"//;s/".*//')
S(){ curl -s -H "Authorization: Bearer $AT" "https://secretmanager.googleapis.com/v1/projects/$P/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | sed 's/.*"data": *"//;s/"$//' | base64 -d 2>/dev/null; }
T=$(mktemp); { printf 'WA_SESSION_SECRET=%s\n' "$(S wa-session-secret)"; printf 'AGENT_TOKENS_B64=%s\n' "$(S agent-tokens-b64)"; printf 'APPROVAL_MAC_KEY=%s\n' "$(S approval-mac-key)"
  # OPS_TOKEN (vmcp_sudo -> ops-exec) is local to this box, not in Secret Manager: read the daemon's own token
  # (root 0600) on every start, so a rotated token reaches the control plane on its next restart.
  [ -s /opt/pc-ops-token ] && printf 'OPS_TOKEN=%s\n' "$(tr -d ' \n' </opt/pc-ops-token)"; } > $T
if grep -q '^WA_SESSION_SECRET=.\+' $T; then install -m 640 -o fleet -g fleet $T /run/fleet/control-plane-secrets.env; echo "[secret-loader] loaded $(grep -c '=.\+' $T) values"; else echo "[secret-loader] WA_SESSION_SECRET empty; refusing" >&2; fi; rm -f $T
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

# [V21-EXEC-STAGE-V1] run_command needs the signed executor (gate-exec, 127.0.0.1:8091) and vmcp_sudo
# needs the root ops daemon (ops-exec, 127.0.0.1:8022). install.sh created the KMS signing key, the
# exec-records bucket and their IAM, and passed the names as metadata.
if [ ! -f $S/exec ]; then say "executor (gate-exec) and root ops daemon (ops-exec)"
  F=/srv/fleet/src/deploy/vmcp-install/files
  mdf(){ curl -sf -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
  KV=$(mdf approval-sig-key-version); XB=$(mdf exec-bucket)
  case "$KV" in projects/"$P"/locations/*/keyRings/*/cryptoKeys/*/cryptoKeyVersions/[0-9]*) ;;
    *) fail "instance metadata approval-sig-key-version is missing or malformed ('$KV'); re-run install.sh";; esac
  printf '%s' "$XB" | grep -Eq '^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$' || fail "instance metadata exec-bucket is missing or malformed ('$XB'); re-run install.sh"
  CONHOST=${CON#https://}; CONHOST=${CONHOST%%/*}
  [ -n "$CONHOST" ] || fail "console-url metadata gives no host for PC_RP_ID"

  # 1) The VM SA must be able to sign (control plane) and read the public key (gate-exec). IAM can
  #    take a few minutes to propagate after install.sh granted it, so retry before failing.
  ok=""; pk=""; sg=""; for i in $(seq 1 30); do
    AT=$(curl -s -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed 's/.*"access_token":"//;s/".*//')
    pk=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AT" "https://cloudkms.googleapis.com/v1/$KV/publicKey")
    sg=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $AT" -H 'content-type: application/json' \
      -d '{"digest":{"sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}' "https://cloudkms.googleapis.com/v1/$KV:asymmetricSign")
    [ "$pk" = 200 ] && [ "$sg" = 200 ] && ok=1 && break; sleep 10; done
  unset AT
  [ -n "$ok" ] || fail "KMS key $KV not usable by this VM's service account (publicKey HTTP $pk, asymmetricSign HTTP $sg); check roles/cloudkms.signer + roles/cloudkms.publicKeyViewer on the key"

  # 2) gate-exec: python venv with the deps gate-exec/Dockerfile installs (versions as verified in production).
  apt-get install -y -qq python3-venv >/dev/null 2>&1 || fail "apt-get install python3-venv"
  [ -x /srv/fleet/gate-exec-venv/bin/python ] || sudo -u fleet -H python3 -m venv /srv/fleet/gate-exec-venv || fail "gate-exec venv"
  sudo -u fleet -H /srv/fleet/gate-exec-venv/bin/pip install -q --no-cache-dir --disable-pip-version-check \
    flask==3.1.3 cryptography==50.0.2 google-cloud-firestore==2.34.0 >/var/log/paracoding-gate-exec-pip.log 2>&1 \
    || fail "gate-exec python deps, see /var/log/paracoding-gate-exec-pip.log"
  # Jobs resolve gcloud through the unit's PATH; wait for the tarball Cloud SDK the control plane installs
  # (the snap gcloud cannot start under NoNewPrivileges).
  for i in $(seq 1 60); do sudo -u fleet -H /srv/fleet/google-cloud-sdk/bin/gcloud --version >/dev/null 2>&1 && break; sleep 5; done
  sudo -u fleet -H /srv/fleet/google-cloud-sdk/bin/gcloud --version >/dev/null 2>&1 || echo "PARACODING-WARN /srv/fleet/google-cloud-sdk not ready; run_command jobs fall back to the snap gcloud"
  cat > /etc/fleet/gate-exec.env <<EOF
PORT=8091
EXEC_TIMEOUT=870
APPROVAL_REQUIRE_SIGNED=1
APPROVAL_SIG_KEY_VERSIONS=$KV
PC_EXEC_BUCKET=$XB
PC_LOCKOUT_CP_SVC=vmcp-ui
PC_LOCKOUT_MC_SVC=vmcp-mcp
PC_LOCKOUT_SERVICES=vmcp-ui vmcp-mcp
PC_LOCKOUT_SECRETS=wa-session-secret agent-tokens-b64 approval-mac-key
PC_GUARDRAILS=0
PC_RP_ID=$CONHOST
EOF
  chown root:fleet /etc/fleet/gate-exec.env; chmod 640 /etc/fleet/gate-exec.env
  install -m 644 $F/systemd/fleet-gate-exec.service /etc/systemd/system/fleet-gate-exec.service
  install -d -m 755 /etc/systemd/system/fleet-gate-exec.service.d
  install -m 644 $F/systemd/fleet-gate-exec.service.d/10-sdk-path.conf /etc/systemd/system/fleet-gate-exec.service.d/10-sdk-path.conf
  systemctl daemon-reload; systemctl enable fleet-gate-exec >/dev/null 2>&1; systemctl restart fleet-gate-exec
  c=""; for i in $(seq 1 30); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8091/healthz); [ "$c" = 200 ] && break; sleep 2; done
  [ "$c" = 200 ] || fail "gate-exec not healthy (HTTP $c: $(curl -s http://127.0.0.1:8091/healthz | head -c 300)); journalctl -u fleet-gate-exec"

  # 3) ops-exec: random token (root 0600), daemon + unit, health and token checks.
  if [ ! -s /opt/pc-ops-token ]; then (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /opt/pc-ops-token); fi
  chown root:root /opt/pc-ops-token; chmod 600 /opt/pc-ops-token
  install -m 755 -o root -g root $F/ops-exec.py /opt/ops-exec.py
  install -m 644 $F/systemd/ops-exec.service /etc/systemd/system/ops-exec.service
  systemctl daemon-reload; systemctl enable ops-exec >/dev/null 2>&1; systemctl restart ops-exec
  c=""; for i in $(seq 1 20); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8022/); [ "$c" = 200 ] && break; sleep 1; done
  [ "$c" = 200 ] || fail "ops-exec not listening on 127.0.0.1:8022; journalctl -u ops-exec"
  H=$(mktemp); chmod 600 "$H"; printf 'X-Ops-Token: %s\n' "$(cat /opt/pc-ops-token)" > "$H"
  r=$(curl -s -H @"$H" --data-binary 'id -u' http://127.0.0.1:8022/); rm -f "$H"
  case "$r" in *'"exit": 0'*'"stdout": "0\n"'*) ;; *) fail "ops-exec token round-trip failed: $(printf '%s' "$r" | head -c 200)";; esac
  c=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Ops-Token: wrong' --data-binary 'true' http://127.0.0.1:8022/)
  [ "$c" = 403 ] || fail "ops-exec accepted a wrong token (HTTP $c)"

  # 4) Control plane: the signing key + exec bucket go in its env file; OPS_TOKEN comes from the
  #    secret loader (it reads /opt/pc-ops-token as root on every start). Restart once and verify.
  sed -i '/^APPROVAL_SIG_KEY_VERSION=/d;/^PC_EXEC_BUCKET=/d' /etc/fleet/control-plane.env
  printf 'APPROVAL_SIG_KEY_VERSION=%s\nPC_EXEC_BUCKET=%s\n' "$KV" "$XB" >> /etc/fleet/control-plane.env
  grep -q OPS_TOKEN /usr/local/sbin/fleet-load-cp-secrets.sh || fail "secret loader does not deliver OPS_TOKEN"
  systemctl restart fleet-control-plane
  c=""; for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/.well-known/oauth-authorization-server); [ "$c" = 200 ] && break; sleep 3; done
  [ "$c" = 200 ] || fail "control plane did not come back after the executor stage: journalctl -u fleet-control-plane"
  grep -q '^OPS_TOKEN=.\+' /run/fleet/control-plane-secrets.env || fail "OPS_TOKEN did not reach /run/fleet/control-plane-secrets.env"
  CPPID=$(systemctl show -p MainPID --value fleet-control-plane)
  tr '\0' '\n' < "/proc/$CPPID/environ" | grep -qxF "APPROVAL_SIG_KEY_VERSION=$KV" || fail "control plane is not running with APPROVAL_SIG_KEY_VERSION"
  touch $S/exec; fi

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

if [ ! -f $S/desktop ] && [ "$(curl -sf -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/attributes/desktop || true)" != "off" ]; then
  say "desktop, Chrome and browser tools"
  # [V21.2-DESKTOP] An XFCE desktop reached through Chrome Remote Desktop, whose ONE Chrome is the
  # browser agents drive through the browser_* tools (control plane -> cdp-bridge -> Chrome DevTools
  # on 127.0.0.1:9222). Pairing Remote Desktop is a human step; the installer prints the command.
  DU=paracoding; DH=/home/$DU; F=/srv/fleet/src/deploy/vmcp-install/files
  apt-get install -y -qq --no-install-recommends xfce4 xfce4-session xfce4-terminal dbus-x11 xbase-clients xvfb \
    fonts-dejavu-core >/var/log/paracoding-desktop.log 2>&1 || fail "desktop packages, see /var/log/paracoding-desktop.log"
  for d in google-chrome-stable chrome-remote-desktop; do
    if ! dpkg -s $d >/dev/null 2>&1; then
      curl -fsSL -o /tmp/$d.deb "https://dl.google.com/linux/direct/${d}_current_amd64.deb" || fail "download $d"
      apt-get install -y -qq /tmp/$d.deb >>/var/log/paracoding-desktop.log 2>&1 || fail "install $d, see /var/log/paracoding-desktop.log"
      rm -f /tmp/$d.deb
    fi
  done
  echo "exec /usr/bin/startxfce4" > /etc/chrome-remote-desktop-session
  id $DU >/dev/null 2>&1 || useradd -m -s /bin/bash -c "Paracoding desktop" $DU
  # Current Remote Desktop packages no longer create this group; older pairing flows still check it.
  getent group chrome-remote-desktop >/dev/null || groupadd --system chrome-remote-desktop   # [V21.2-CRD-GROUP]
  usermod -aG chrome-remote-desktop $DU
  # One Chrome, one profile: every launcher goes through pc-chrome (CDP-ONE-PROFILE-V1).
  install -m 0755 $F/browser/pc-chrome /usr/local/bin/pc-chrome
  for n in google-chrome google-chrome-stable; do install -m 0755 $F/browser/google-chrome-shim /usr/local/bin/$n; done
  install -d -o $DU -g $DU $DH/.local $DH/.local/share $DH/.local/share/applications $DH/.config $DH/.config/autostart
  sed -E 's#^Exec=/usr/bin/google-chrome-stable#Exec=/usr/local/bin/pc-chrome#' /usr/share/applications/google-chrome.desktop > $DH/.local/share/applications/google-chrome.desktop
  install -m 0644 $F/browser/pc-chrome.desktop $DH/.config/autostart/pc-chrome.desktop
  chown $DU:$DU $DH/.local/share/applications/google-chrome.desktop $DH/.config/autostart/pc-chrome.desktop
  runuser -u $DU -- xdg-settings set default-web-browser google-chrome.desktop >/dev/null 2>&1 || true
  # The bridge: its own user, a random token, the open policy (every site; lock down by editing it).
  getent group pc-cdp >/dev/null || groupadd --system pc-cdp
  id pc-cdp >/dev/null 2>&1 || useradd --system --gid pc-cdp --home-dir /nonexistent --shell /usr/sbin/nologin pc-cdp
  [ -s /opt/cdp-token ] || { install -m 0640 -o root -g pc-cdp /dev/null /opt/cdp-token; openssl rand -hex 32 | tr -d '\n' > /opt/cdp-token; }
  chown root:pc-cdp /opt/cdp-token; chmod 0640 /opt/cdp-token
  install -m 0755 $F/cdp-bridge.py /opt/cdp-bridge.py
  [ -f /opt/cdp-policy.json ] || install -m 0644 $F/browser/cdp-policy.json /opt/cdp-policy.json
  install -m 0644 $F/systemd/cdp-bridge.service /etc/systemd/system/cdp-bridge.service
  systemctl daemon-reload; systemctl enable --now cdp-bridge >/dev/null 2>&1
  NIC=$(curl -sf -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip) || fail "no nic0 address"
  for i in $(seq 1 30); do c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST http://$NIC:8025/rpc); [ "$c" = 403 ] && break; sleep 2; done
  [ "$c" = 403 ] || fail "cdp-bridge not answering on $NIC:8025 (journalctl -u cdp-bridge)"
  # The control plane registers browser_* when WS_CDP_PORT is set.
  umask 027; { echo "WS_CDP_PORT=8025"; echo "WS_CDP_IP=$NIC"; printf 'CDP_TOKEN=%s\n' "$(cat /opt/cdp-token)"
    echo "PC_BROWSER_SCREENSHOT=1"; echo "PC_BROWSER_INPUT=1"; echo "PC_BROWSER_EVAL=1"; } > /etc/fleet/cdp.env; umask 022
  chown root:fleet /etc/fleet/cdp.env; chmod 0640 /etc/fleet/cdp.env
  mkdir -p /etc/systemd/system/fleet-control-plane.service.d
  printf '[Service]\nEnvironmentFile=-/etc/fleet/cdp.env\n' > /etc/systemd/system/fleet-control-plane.service.d/20-cdp.conf
  systemctl daemon-reload; systemctl restart fleet-control-plane
  for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/.well-known/oauth-authorization-server); [ "$c" = 200 ] && break; sleep 3; done
  [ "$c" = 200 ] || fail "control plane did not come back after the browser-tools settings"
  touch $S/desktop
fi

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
