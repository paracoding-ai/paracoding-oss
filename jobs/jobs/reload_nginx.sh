set -euo pipefail
nginx -t
systemctl reload nginx
echo "nginx reloaded OK"
