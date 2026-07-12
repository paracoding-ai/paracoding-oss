#!/bin/bash
# workspace_patch.sh — proposed job type: apply an exact-string patch spec to ONE file
# under /opt/paracoding-mcp/work/. DRAFT by paracoding-infra 2026-07-09 for paracoding-breakglass review.
# Install: /opt/paracoding-mcp/jobrunner/jobs/workspace_patch.sh (root:root 750).
# Params: JOB_PARAMS='{"spec":"/opt/paracoding-mcp/work/<...>.spec.json"}'
# Spec: {file, backup_dir, edits:[{id,op:replace_once|insert_after_once,before/after|anchor/text}]}
# Safety: file+spec+backup_dir must resolve under /opt/paracoding-mcp/work/; every match must be
# EXACTLY once or the whole patch aborts untouched; atomic tmp+rename; backup first;
# result chowned mcpsvc. Reports per-edit status, wc -w, line count, sha256 before/after.
set -uo pipefail
python3 - <<'PY'
import json, os, sys, hashlib, shutil, time
WORK="/opt/paracoding-mcp/work/"
p=json.loads(os.environ.get("JOB_PARAMS","{}")); spec_path=os.path.realpath(p.get("spec",""))
assert spec_path.startswith(WORK), f"spec outside workspace: {spec_path}"
spec=json.load(open(spec_path))
f=os.path.realpath(spec["file"]); bdir=os.path.realpath(spec.get("backup_dir",WORK+"infra/patches/backups"))
assert f.startswith(WORK) and bdir.startswith(WORK), "file/backup outside workspace"
src=open(f, encoding="utf-8").read()
print(f"before: sha256={hashlib.sha256(src.encode()).hexdigest()} words={len(src.split())} lines={src.count(chr(10))+1}")
out=src; results=[]
for e in spec["edits"]:
    op=e["op"]
    if op=="replace_once":
        n=out.count(e["before"])
        if n!=1: results.append((e["id"],f"ABORT match_count={n}")); break
        out=out.replace(e["before"],e["after"],1); results.append((e["id"],"ok"))
    elif op=="insert_after_once":
        n=out.count(e["anchor"])
        if n!=1: results.append((e["id"],f"ABORT anchor_count={n}")); break
        i=out.index(e["anchor"])+len(e["anchor"])
        out=out[:i]+e["text"]+out[i:]; results.append((e["id"],"ok"))
    else: results.append((e["id"],f"ABORT unknown_op={op}")); break
for rid,st in results: print(f"edit {rid}: {st}")
if any("ABORT" in st for _,st in results):
    print("NO CHANGES WRITTEN (all-or-nothing)"); sys.exit(3)
os.makedirs(bdir,exist_ok=True)
bak=os.path.join(bdir,os.path.basename(f)+time.strftime(".%Y%m%d-%H%M%S.bak"))
shutil.copy2(f,bak); print(f"backup: {bak}")
tmp=f+".tmp.patch"
open(tmp,"w",encoding="utf-8").write(out); os.replace(tmp,f)
shutil.chown(f,"mcpsvc","mcpsvc"); shutil.chown(bak,"mcpsvc","mcpsvc")
print(f"after:  sha256={hashlib.sha256(out.encode()).hexdigest()} words={len(out.split())} lines={out.count(chr(10))+1}")
print("PATCH APPLIED")
PY
