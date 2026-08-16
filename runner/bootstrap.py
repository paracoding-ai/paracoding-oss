import os, sys, types, traceback
from flask import Flask
from google.cloud import storage

# Hot-loader: the container is a thin shell; the real runner logic is pulled from
# the lake (GCS) on each request. Change work_item_runner.py in the lake and the
# next tick runs it — no rebuild, no redeploy. A bad push falls back to last-good.
#
# [SEC-LAKE-NOGUESS-V1] BUCKET HAS NO DEFAULT AND MUST NOT ACQUIRE ONE. It used to default to one
# particular operator's datalake. That is worse here than anywhere else in this tree: this file
# does not merely READ that bucket, it exec()s what it finds there. A forgotten BUCKET meant
# executing another tenant's code under this deployment's service account.
BUCKET      = os.environ.get("BUCKET", "").strip()
if not BUCKET:
    raise RuntimeError(
        "BUCKET is unset. The hot-loader EXECUTES the code it downloads, so it will not guess "
        "which bucket to execute from. Set BUCKET to the lake bucket the installer created for "
        "THIS lane, then redeploy.")
RUNNER_PATH = os.environ.get("RUNNER_PATH", "shared/runner/work_item_runner.py")
# The runner imports the one shared fleet-mode switch. It is hot-loaded from the lake beside the
# runner, so the switch a hot-loaded runner gates on is the same file the built images carry and
# is updated on the same push -- not a stale copy baked into this thin shell.
MODE_PATH   = os.environ.get("FLEET_MODE_PATH", RUNNER_PATH.rsplit("/", 1)[0] + "/fleet_mode.py")
_gcs   = storage.Client()
_cache = {"code": None, "ns": None, "mode": None}

def _load_mode():
    # Registered in sys.modules so the runner's plain `from fleet_mode import ...` resolves.
    code = _gcs.bucket(BUCKET).blob(MODE_PATH).download_as_text()
    if code != _cache["mode"] or "fleet_mode" not in sys.modules:
        m = types.ModuleType("fleet_mode")
        m.__file__ = MODE_PATH
        exec(compile(code, MODE_PATH, "exec"), m.__dict__)
        if not hasattr(m, "FLEET_MODES"):
            raise RuntimeError("fleet_mode.py at %s is not the mode switch" % MODE_PATH)
        sys.modules["fleet_mode"] = m
        _cache["mode"] = code
        _cache["code"] = None      # force the runner to re-exec against the new switch

def _load_ns():
    _load_mode()
    code = _gcs.bucket(BUCKET).blob(RUNNER_PATH).download_as_text()
    if code != _cache["code"] or _cache["ns"] is None:
        ns = {"__name__": "work_item_runner"}   # so the runner's __main__ guard is False
        exec(compile(code, RUNNER_PATH, "exec"), ns)
        _cache["code"] = code
        _cache["ns"]   = ns
    return _cache["ns"]

app = Flask(__name__)

@app.route("/", methods=["GET", "POST"])
def go():
    try:
        ns = _load_ns()
    except Exception:
        if _cache["ns"] is None:
            return ("hot-loader: runner code failed to load:\n" + traceback.format_exc()[:1200], 500)
        ns = _cache["ns"]   # syntax error in new code -> keep serving last-good
    try:
        return ns["run"]()
    except Exception:
        return ("hot-loader: runner raised:\n" + traceback.format_exc()[:1200], 500)

@app.route("/healthz")
def healthz():
    return ("ok", 200)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
