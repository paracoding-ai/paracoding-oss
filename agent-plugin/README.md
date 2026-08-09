# Agent Plugins package

This directory is an [Agent Plugins](https://agent-plugins.org) 1.0.0 package. It exists so
that agent clients other than this project's own console can reach the control plane.

`mcp.json` ships with a placeholder URL. Your control plane's hostname is assigned by Cloud
Run at deploy time and cannot be known when this release is cut, so substitute it:

    sed -i.bak 's#https://REPLACE-WITH-YOUR-CONTROL-PLANE-HOST#https://YOUR-HOST#' mcp.json

`install.sh` prints the exact value at the end of a successful run, and writes a
ready-to-use copy of this directory to `agent-plugin.local/` beside the release. That copy
is generated at install time and is deliberately NOT in `MANIFEST.txt`: editing a manifested
file in place is the drift this release refuses to allow.

## Authentication is not optional

`POST /mcp` answers 401 to anything unauthenticated, and identity enforcement ships on
(`PC_SESSION_ENFORCE=1`). A client that connects with no credential resolves to no role and
receives exactly one tool, `whoami`, which explains why. Mint a session key at
`<your-host>/pastes` first. The manifest declares no `headers` block for that reason: the
credential is yours, it expires (seven days by default), and it does not belong in a file
that ships in a release tarball.
