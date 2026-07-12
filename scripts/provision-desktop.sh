#!/bin/bash
# provision-desktop.sh <project> <mcp_internal_ip> [zone] [vm_name]
#
# Stands up the OPERATOR DESKTOP as a SEPARATE VM from the MCP server (see docs/DESKTOP.md):
#   * e2-standard-4 (4 vCPU / 16 GB) — a desktop needs the RAM; the always-on MCP e2-small can't
#     run one, and up-sizing an always-on box = a big always-on bill. Separate = cheaper + safer
#     (no browser bolted onto the hardened backend).
#   * XFCE + Chrome (Claude-for-Chrome force-installed) + Claude Desktop + Chrome Remote Desktop.
#   * IDLE-STOPS itself after 30 min unused -> compute billing stops (~$0 when you're off it).
#   * Same project/VPC as the MCP server; reaches it over the INTERNAL private IP (no public
#     domain/TLS) with the server's self-signed cert trusted on the box.
# Two one-time HUMAN steps at the end (CRD register + Claude sign-in) — normal, not failures.
set -euo pipefail
PROJ="${1:?usage: provision-desktop.sh <project> <mcp_internal_ip> [zone] [vm_name]}"
MCP_IP="${2:?need MCP server internal IP: gcloud compute instances describe paracoding-mirror --zone=<z> --format='value(networkInterfaces[0].networkIP)'}"
ZONE="${3:-us-central1-a}"
VM="${4:-paracoding-desktop}"

cat > /tmp/desktop-startup.sh <<'STARTUP'
#!/bin/bash
exec >>/var/log/paracoding-desktop-setup.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq xfce4 xfce4-goodies dbus-x11 xprintidle curl ca-certificates openssl
# Chrome + Chrome Remote Desktop host
curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
curl -fsSLo /tmp/crd.deb    https://dl.google.com/linux/direct/chrome-remote-desktop_current_amd64.deb
apt-get install -yq /tmp/chrome.deb /tmp/crd.deb
# Force-install the Claude-for-Chrome extension via Chrome managed policy (proven method)
mkdir -p /etc/opt/chrome/policies/managed
echo '{"ExtensionInstallForcelist":["fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"]}' > /etc/opt/chrome/policies/managed/claude-for-chrome.json
# Claude Desktop (Linux) — best-effort per Anthropic's apt repo; if unavailable, Claude-for-Chrome covers it
curl -fsSL https://downloads.claude.ai/claude-desktop/apt/keyring.asc -o /usr/share/keyrings/claude-desktop-archive-keyring.asc 2>/dev/null \
  && echo "deb [signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" > /etc/apt/sources.list.d/claude-desktop.list \
  && apt-get update -q && apt-get install -yq claude-desktop \
  || echo "NOTE: claude-desktop apt not reachable — use the force-installed Claude-for-Chrome extension, or install Claude Desktop manually."
# CRD session = XFCE
echo 'exec /etc/X11/Xsession /usr/bin/xfce4-session' > /etc/chrome-remote-desktop-session
# Reach the always-on MCP server over its INTERNAL IP (no public TLS): hosts entry + trust its self-signed cert
grep -q paracoding-mcp.internal /etc/hosts || echo "__MCP_IP__ paracoding-mcp.internal" >> /etc/hosts
( echo | openssl s_client -connect __MCP_IP__:443 -servername paracoding-mcp.internal 2>/dev/null | openssl x509 > /usr/local/share/ca-certificates/paracoding-mcp.crt 2>/dev/null && update-ca-certificates ) \
  || echo "NOTE: MCP cert not fetched (server may still be starting) — re-run: update-ca-certificates after grabbing /...paracoding-mcp.crt"
# Idle-off: self-stop after 30 min of no input (proven workstation pattern; billing stops)
cat > /usr/local/bin/paracoding-idle-stop.sh <<'IDLE'
#!/bin/bash
IDLE_MIN=30
u=$(ls /home 2>/dev/null | grep -vE '^(lost\+found)$' | head -1)
disp=$(ls /tmp/.X11-unix/ 2>/dev/null | sed 's/X/:/' | head -1)
[ -z "$disp" ] && exit 0
xauth=$(find /home/$u -maxdepth 2 -name '.Xauthority' 2>/dev/null | head -1)
idle_ms=$(sudo -u "$u" DISPLAY="$disp" XAUTHORITY="$xauth" xprintidle 2>/dev/null || echo 0)
[ "${idle_ms:-0}" -gt $((IDLE_MIN*60*1000)) ] && { logger "paracoding-idle-stop: idle > ${IDLE_MIN}m, self-stopping (billing off)"; /sbin/shutdown -h now; }
IDLE
chmod +x /usr/local/bin/paracoding-idle-stop.sh
printf '%s\n' '[Unit]' 'Description=operator desktop idle auto-stop (self-stop when unused)' '[Service]' 'Type=oneshot' 'ExecStart=/usr/local/bin/paracoding-idle-stop.sh' > /etc/systemd/system/paracoding-idle-stop.service
printf '%s\n' '[Unit]' 'Description=check desktop idle every 5 min' '[Timer]' 'OnBootSec=10min' 'OnUnitActiveSec=5min' '[Install]' 'WantedBy=timers.target' > /etc/systemd/system/paracoding-idle-stop.timer
systemctl daemon-reload && systemctl enable --now paracoding-idle-stop.timer
touch /var/log/paracoding-desktop-ready
STARTUP
sed -i "s/__MCP_IP__/${MCP_IP}/g" /tmp/desktop-startup.sh

gcloud compute instances create "$VM" --project="$PROJ" --zone="$ZONE" \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata-from-file startup-script=/tmp/desktop-startup.sh
rm -f /tmp/desktop-startup.sh

cat <<DONE

Desktop VM '$VM' is creating (e2-standard-4, idle-off armed). First-boot setup runs ~6-8 min.
  progress: gcloud compute ssh $VM --zone=$ZONE --command='sudo tail -n30 /var/log/paracoding-desktop-setup.log'
  ready when: /var/log/paracoding-desktop-ready exists on the VM

TWO ONE-TIME HUMAN STEPS (normal — not failures):
 1) REGISTER THE DESKTOP with Chrome Remote Desktop (the host can't self-register):
    - In your browser (signed into your Google account): https://remotedesktop.google.com/headless
      -> Begin -> Next -> Authorize -> copy the "Debian Linux" authorization command.
    - Run that command ON THE DESKTOP VM as the desktop user:
        gcloud compute ssh $VM --zone=$ZONE
      then paste it, and set a 6-digit PIN. The desktop then appears at remotedesktop.google.com.
 2) SIGN IN TO CLAUDE: connect via CRD (your PIN) -> open Claude Desktop (or Chrome) -> sign in
    to Claude once (the datacenter-IP check is one-time and persists) + the Chrome extension.

Connecting to the fleet: the desktop reaches the always-on MCP server at
  https://paracoding-mcp.internal/   (internal IP $MCP_IP, self-signed cert trusted on the box).
Add your MCP connector URL (printed by the server's rebuild.sh, path only) in claude.ai — connectors are account-synced.
DONE