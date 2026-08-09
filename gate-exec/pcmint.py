"""Credential store reader for the gated executor's independent approval check.

[SEC-MINTER-REMOVE-V1] THIS FILE WAS THE MINTER AND THE MINTER IS GONE. It used to carry
mint_job_credential(): KMS asymmetricSign -> our own JWT -> Google STS token-exchange ->
impersonate an exec service account. That chain read PC_KMS_KEY, PC_PROJECT_NUMBER,
PC_EXEC_SA, PC_WIF_POOL and PC_WIF_PROVIDER, and NO INSTALLER EVER CREATED ANY OF THEM --
there was no Workload Identity pool, no signing key and no exec SA. Nothing in the execution
path ever called it either: approved jobs run on the APPROVER's OAuth token, injected as
CLOUDSDK_AUTH_ACCESS_TOKEN by exec_server.py. Its only caller was the /selftest endpoint,
which therefore reported mint:{ok:false} on every deployment that has ever existed.

Dead credential machinery is not free. It is the pattern the symmetric approval-MAC key
already cost this fleet once: an unused credential path that still has to be read, audited
and reasoned about at every review, and that keeps an API (iamcredentials) enabled for
nothing. So it is deleted rather than provisioned, and the /selftest row that reported on it
is deleted with it -- a self-test must not name a component that no longer exists.

THE FILE AND ITS NAME SURVIVE BECAUSE load_creds() DOES. exec_server.py imports pcmint for
load_creds() on the PC_REQUIRE_ASSERTION path, gate-exec/Dockerfile COPYs it, and the release
generator lists it in both its copy table and its REQUIRED gate. Renaming it would touch four
places for cosmetics; the docstring is the cheaper honest answer.

CREDENTIALS: none in this file. _own_token() asks the metadata server for the identity Cloud
Run already attached to the revision.
"""
import base64, json, os, urllib.request


def _own_token():
    """This service's own identity, from the metadata server."""
    req = urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())['access_token']


def load_creds():
    """Enrolled WebAuthn credentials, from a Secret Manager secret only the EXECUTOR can read.

    Deliberately NOT Firestore. Firestore IAM has no per-collection granularity, so the control
    plane -- which needs datastore.user to do its job -- could otherwise enrol its own key and
    then forge assertions against itself. Keeping the credential list somewhere the control
    plane cannot write is what makes verification here mean anything.

    Returns {} when unset, and the caller MUST treat that as refuse-to-approve, not as allow.
    """
    name = os.environ.get('PC_CREDS_SECRET', '')
    if not name:
        return {}
    req = urllib.request.Request(
        'https://secretmanager.googleapis.com/v1/%s/versions/latest:access' % name,
        headers={'Authorization': 'Bearer ' + _own_token()})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=10).read())
        return json.loads(base64.b64decode(d['payload']['data']).decode())
    except Exception:
        return {}
