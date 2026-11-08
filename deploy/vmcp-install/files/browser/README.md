# Browser tools on the vmcp desktop [CDP-RESTORE-V1]

The `browser_*` MCP tools drive the Google Chrome on this VM's Linux desktop (XFCE, reached through
Chrome Remote Desktop) through a token-gated bridge:

    control plane --HTTP /rpc + X-Cdp-Token--> cdp-bridge (nic0:8025) --CDP--> Chrome (127.0.0.1:9222)

| Piece | Installed at |
| --- | --- |
| `pc-chrome` launcher: the desktop's ONE Chrome (debug port on 127.0.0.1:9222, profile `~/.config/google-chrome-desktop`) | `/usr/local/bin/pc-chrome` |
| `google-chrome` / `google-chrome-stable` shims (PATH) and the menu/default-browser entry, all routed to `pc-chrome` | `/usr/local/bin/`, `~/.local/share/applications/google-chrome.desktop` |
| desktop autostart for it | `~/.config/autostart/pc-chrome.desktop` |
| `cdp-bridge.py` (stdlib only, binds nic0 only) | `/opt/cdp-bridge.py`, unit `cdp-bridge.service`, user `pc-cdp` |
| token | `/opt/cdp-token` (root:pc-cdp 0640) |
| site policy | `/opt/cdp-policy.json` |
| control-plane settings | `/etc/fleet/cdp.env` (WS_CDP_PORT, WS_CDP_IP, CDP_TOKEN, PC_BROWSER_*) via a drop-in |
| VPC firewall | `deny-cdp-bridge-ingress` (priority 900, tcp:8025,9222 to the VM's tag) |

**One profile, yours.** Chrome 136+ refuses a DevTools port on its *default* data dir, so the
desktop's Chrome runs from `~/.config/google-chrome-desktop`, a one-time copy of the original
profile (logins and cookies carry over; the original is left untouched). Every launcher goes
through `pc-chrome`, so the Chrome you use is the Chrome agents drive; there is no second profile.
This is how the workstation setup always worked (it launched the session's Chrome with its own
`--user-data-dir`), never a separate "agent profile".

**Site policy: open by default, lockdown by choice.** The default allows every site
(`origin_allow: ["*"]`), denies none, allows click/type/key and plain http. `file://` and
`chrome://` are never driven. To lock it down, edit `/opt/cdp-policy.json`: list hosts in
`origin_allow` (exact host or `*.domain`; an empty list denies everything), add hosts to
`origin_deny` (deny always beats allow), set `allow_input` or `allow_http` to false. Edits apply on
the next request; no restart.

**Never launch Chrome from a shell whose output someone waits on** (for example a root-daemon
command): Chrome keeps the pipe open and the caller hangs. Start it detached:
`systemd-run --uid=<user> --setenv=DISPLAY=:20 ... /usr/local/bin/pc-chrome`.
