# SPDX-License-Identifier: Apache-2.0
"""
Generates route-baseline.json.

WHY PYTHON: the enforcement half (route-audit.mjs) must be JS because the build
image is node:24-slim. The generation half must be PYTHON because it runs on the
gate executor, which has python3 and NO node. Two languages is not a choice, it
is the shape of the two machines.

The two implementations are cross-tested against each other on identical input
before this is ever staged. If they ever disagree, the build check is measuring
something different from what was baselined, and that is a dead check.
"""
import json, re, sys

src_path, base_path = sys.argv[1], sys.argv[2]
SRC = open(src_path, encoding="utf-8").read()

GUARDS = [
    "waSessionOk", "assertIdentity", "waGate", "waElevatedOk", "oaBearerRole",
    "waEnrollTokenOk", "bootstrapSecret", "WA_BOOTSTRAP_SECRET",
    "rlCheck", "checkLockout", "oaGet('oauth_clients'",
]

RE = re.compile(r"^app\.(get|post|put|delete|patch|all|use)\(\s*(['\"`])([^'\"`]+)\2", re.M)
found = [{"method": m.group(1).upper(), "path": m.group(3), "at": m.start()}
         for m in RE.finditer(SRC)]
assert found, "found zero route registrations -- wrong file or wrong regex"
found.sort(key=lambda r: r["at"])

for i, r in enumerate(found):
    end = found[i + 1]["at"] if i + 1 < len(found) else len(SRC)
    body = SRC[r["at"]:end]
    r["guarded"] = any(g in body for g in GUARDS)

pub = sorted(r["method"] + " " + r["path"] for r in found if not r["guarded"])
guarded = sorted(r["method"] + " " + r["path"] for r in found if r["guarded"])

print("total routes : %d" % len(found))
print("guarded      : %d" % len(guarded))
print("public       : %d" % len(pub))
for p in pub:
    print("    public: " + p)

json.dump({
    "note": "Routes that are PUBLIC (no auth guard found in the handler) as of the commit that created this file. A NEW public route not listed here fails the build. Removing an entry here is how you assert a route has been given a guard. Adding one is a deliberate decision to ship a public route -- say why in the commit message.",
    "generated_from": src_path,
    "public": pub,
}, open(base_path, "w"), indent=2)
open(base_path, "a").write("\n")
print("baseline written:", base_path)
