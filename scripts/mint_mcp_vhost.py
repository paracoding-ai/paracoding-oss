#!/usr/bin/env python3
"""Mint the live mcp vhost from nginx/mcp.example.com.conf.redacted: a fresh unique secret path per agent location, AND the
nginx-bound X-Agent-Id (per-agent identity) from each location's '# agent:<name>' label.
Prints 'agent<TAB>path' per line. Arg1=repo root, Arg2=out file."""
import re,secrets,sys
root=sys.argv[1]; out=sys.argv[2]
lines=open(root+"/nginx/mcp.example.com.conf.redacted").read().splitlines(keepends=True)
res=[]; cur=None; minted=[]
for ln in lines:
    m=re.match(r'\s*#\s*agent:\s*([a-z0-9-]+)', ln)
    if m: cur=m.group(1)
    if '/<SECRET_PATH_REDACTED>/' in ln:
        p=secrets.token_hex(20); ln=ln.replace('/<SECRET_PATH_REDACTED>/','/'+p+'/'); minted.append((cur or 'agent',p))
    res.append(ln)
    if cur and re.match(r'\s*proxy_pass http://127\.0\.0\.1:820[01]/;', ln):
        ind=ln[:len(ln)-len(ln.lstrip())]; res.append(f"{ind}proxy_set_header X-Agent-Id {cur};\n"); cur=None
open(out,"w").write("".join(res))
for a,p in minted: print(f"{a}\t{p}")
