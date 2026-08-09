"""Minter: turn a verified human approval into a short-lived, job-scoped GCP credential.

No private key lives here. Signing happens in Cloud KMS, so compromising this service lets an
attacker sign WHILE THEY ARE INSIDE IT, but gives them nothing to carry away and nothing that
keeps working after they are evicted. That is the whole reason the key is in KMS and not in a
file or a secret.

Chain: KMS asymmetricSign -> our JWT -> Google STS token-exchange -> impersonate the exec SA.
The resulting credential lasts minutes and carries exactly the roles that SA holds.
"""
import base64, json, os, time, urllib.request, urllib.parse, urllib.error

PROJECT_NUM = os.environ.get('PC_PROJECT_NUMBER', '')
POOL = os.environ.get('PC_WIF_POOL', 'pc-minter-pool')
PROVIDER = os.environ.get('PC_WIF_PROVIDER', 'pc-minter-prov')
ISSUER = os.environ.get('PC_MINT_ISSUER', 'https://minter.paracoding.test')
AUDIENCE = os.environ.get('PC_MINT_AUDIENCE', 'paracoding-minter')
KMS_KEY = os.environ.get('PC_KMS_KEY', '')  # full resource name incl. /cryptoKeyVersions/N
KID = os.environ.get('PC_KMS_KID', 'pc-kms-1')
EXEC_SA = os.environ.get('PC_EXEC_SA', '')

b64u = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')

class MintError(Exception):
    pass

def _post(url, data, hdrs=None, form=False, timeout=20):
    body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=hdrs or {})
    if not form:
        req.add_header('Content-Type', 'application/json')
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        raise MintError('%s -> %d %s' % (url.split('?')[0], e.code, e.read().decode()[:300]))

def _own_token():
    """This service's own identity, from the metadata server. Used only to call KMS."""
    req = urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())['access_token']

def sign_jwt(claims, ttl=300):
    if not KMS_KEY:
        raise MintError('PC_KMS_KEY not configured')
    now = int(time.time())
    payload = dict(claims)
    payload.update({'iss': ISSUER, 'aud': AUDIENCE, 'iat': now, 'exp': now + ttl})
    si = b64u(json.dumps({'alg': 'RS256', 'typ': 'JWT', 'kid': KID}).encode()) + '.' + b64u(json.dumps(payload).encode())
    import hashlib
    digest = b64u(hashlib.sha256(si.encode()).digest()).replace('-', '+').replace('_', '/')
    digest = base64.b64encode(hashlib.sha256(si.encode()).digest()).decode()
    r = _post('https://cloudkms.googleapis.com/v1/%s:asymmetricSign' % KMS_KEY,
              {'digest': {'sha256': digest}},
              {'Authorization': 'Bearer ' + _own_token()})
    return si + '.' + b64u(base64.b64decode(r['signature']))

def mint_job_credential(job_id, command_sha256, approver_email, ttl=300):
    """Returns (access_token, expire_time). Raises MintError. Never log the token."""
    jwt = sign_jwt({'sub': 'pc-minter', 'job': job_id, 'cmd': command_sha256, 'approver': approver_email}, ttl=ttl)
    aud = '//iam.googleapis.com/projects/%s/locations/global/workloadIdentityPools/%s/providers/%s' % (PROJECT_NUM, POOL, PROVIDER)
    sts = _post('https://sts.googleapis.com/v1/token', {
        'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
        'audience': aud,
        'scope': 'https://www.googleapis.com/auth/cloud-platform',
        'requested_token_type': 'urn:ietf:params:oauth:token-type:access_token',
        'subject_token': jwt,
        'subject_token_type': 'urn:ietf:params:oauth:token-type:jwt',
    }, form=True)
    if not EXEC_SA:
        raise MintError('PC_EXEC_SA not configured')
    imp = _post('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken' % EXEC_SA,
                {'scope': ['https://www.googleapis.com/auth/cloud-platform'], 'lifetime': '%ds' % ttl},
                {'Authorization': 'Bearer ' + sts['access_token']})
    return imp['accessToken'], imp.get('expireTime')


def load_creds():
    """Enrolled WebAuthn credentials, from a Secret Manager secret only the MINTER can read.

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
