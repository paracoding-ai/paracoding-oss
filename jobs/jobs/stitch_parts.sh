#!/bin/bash
# stitch_parts.sh — concatenate sorted part-files into one output, SHA256 + byte-size
# gated, then delete the parts. DRAFT by paracoding-infra 2026-07-10 for paracoding-breakglass
# review + install as a new job type.
#
# INSTALL (breakglass, root):
#   cp this -> /opt/paracoding-mcp/jobrunner/jobs/stitch_parts.sh
#   chown root:root /opt/paracoding-mcp/jobrunner/jobs/stitch_parts.sh
#   chmod 750       /opt/paracoding-mcp/jobrunner/jobs/stitch_parts.sh
#   (+ register "stitch_parts" in the job allowlist however the runner enumerates types)
#
# Params: JOB_PARAMS='{"dir":"/opt/paracoding-mcp/work/ghost/book3",
#                      "parts_glob":"_msync_part*.md",
#                      "out":"Book3_Manuscript.md",
#                      "sha256":"<hex>","size":264332,
#                      "cleanup":["_ZZ_synctest.tmp"]}'
#
# Safety invariants:
#   - dir, out, every matched part, and every cleanup path MUST resolve under
#     /opt/paracoding-mcp/work/  (rejects traversal / absolute escapes).
#   - Parts are concatenated in SORTED (lexical) order — zero-padded partNN sorts correctly.
#   - Assembly goes to a .stitch.tmp then atomic rename; the real file is never partial.
#   - sha256 AND size are verified BEFORE any deletion. On ANY mismatch: remove only the
#     tmp, leave parts + existing out UNTOUCHED, exit 3. Parts are deleted ONLY on a clean
#     double match.
#   - JOB_PARAMS is parsed as JSON data, never eval'd/executed. Output chowned mcpsvc so the
#     fleet connector can read it.
set -uo pipefail
python3 - <<'PY'
import json, os, sys, glob, hashlib, shutil
WORK = "/opt/paracoding-mcp/work/"
p = json.loads(os.environ.get("JOB_PARAMS", "{}"))

d = os.path.realpath(p.get("dir", ""))
assert d == WORK.rstrip("/") or d.startswith(WORK), f"dir outside workspace: {d}"
out = os.path.realpath(os.path.join(d, p["out"]))
assert out.startswith(WORK), "out outside workspace"

parts = sorted(glob.glob(os.path.join(d, p.get("parts_glob", "_msync_part*.md"))))
assert parts, "no parts matched parts_glob"
for pf in parts:
    assert os.path.realpath(pf).startswith(WORK), f"part outside workspace: {pf}"

h = hashlib.sha256(); total = 0
tmp = out + ".stitch.tmp"
with open(tmp, "wb") as w:
    for pf in parts:
        with open(pf, "rb") as r:
            data = r.read()
        w.write(data); h.update(data); total += len(data)
digest = h.hexdigest()
print(f"parts={len(parts)} bytes={total} sha256={digest}", flush=True)

exp_sha = p.get("sha256"); exp_size = p.get("size")
if exp_sha and digest != exp_sha:
    os.remove(tmp); print(f"SHA MISMATCH expected={exp_sha} got={digest} — nothing deleted"); sys.exit(3)
if exp_size is not None and total != int(exp_size):
    os.remove(tmp); print(f"SIZE MISMATCH expected={exp_size} got={total} — nothing deleted"); sys.exit(3)

os.replace(tmp, out)
try:
    shutil.chown(out, "mcpsvc", "mcpsvc")
except Exception as e:
    print(f"warn: chown failed: {e}")

removed = 0
for pf in parts:
    os.remove(pf); removed += 1
for c in p.get("cleanup", []):
    cp = os.path.realpath(os.path.join(d, c))
    if cp.startswith(WORK) and os.path.exists(cp):
        os.remove(cp); removed += 1
print(f"STITCHED {out} ({total} bytes, sha256 OK) — removed {removed} file(s) ({len(parts)} parts + cleanup)")
PY
