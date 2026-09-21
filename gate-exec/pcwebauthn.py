"""Minter-side WebAuthn assertion verification.

WHY THIS EXISTS: today the control plane verifies the passkey and writes status=confirmed,
and the executor trusts that verdict. A compromised control plane therefore approves anything
by writing one field. Moving verification here means the control plane must FORWARD a real
assertion it cannot forge -- it would need the operator's device.

Public keys are stored as JSON {crv,x,y}, NOT COSE/CBOR, so this module needs no CBOR parser
and the conversion happens once at enrolment where a mistake is loud instead of silent.
"""
import base64, hashlib, json, os, re, struct
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
from cryptography.exceptions import InvalidSignature

def b64u_dec(s):
    s = s + '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode())

FLAG_UP = 0x01
FLAG_UV = 0x04

# [SEC-ASSERT-ORIGIN-COUNTER-V1] THE PARSE STOPPED AT THE FLAGS BYTE, SO ONE CAPTURED
# ASSERTION APPROVED THE SAME JOB FOREVER. authenticatorData is rpIdHash(32) + flags(1) +
# signCount(4); verify() read 33 bytes and dropped the rest. Nothing looked at the signature
# counter, so a replayed assertion was indistinguishable from a fresh tap, and nothing looked
# at clientData.origin, so one signed at a look-alike page verified exactly as well as one
# signed at the console. The challenge is no help against either: it is supplied by the
# CALLER, this service keeps no record that it ever issued one, and challenge_is_bound() only
# asserts the trailing 32 bytes equal sha256(jobId|action) -- a hash the caller computes for
# itself. Binding therefore says WHICH job an assertion is for, never HOW MANY TIMES.
#
# WHY AN ALLOWLIST FROM THE ENVIRONMENT, WITH A DERIVED DEFAULT. The origin an operator signs
# at is the console host, which is per-install. PC_RP_ID already carries exactly that host --
# the installer writes it from $CP_HOST and says so at oss/gen.py [SEC-EXEC-RPID-INSTALL-V1],
# and smoke F5.4 asserts it EQUALS the console host -- so the default is derived from the same
# rp id this call already checks the rpIdHash against. An install that serves the console
# elsewhere sets PC_ALLOWED_ORIGINS. Deriving it means arming this path needs no new variable,
# and a wrong origin cannot disagree with a wrong rpIdHash by accident.
#
# EMPTY REFUSES, IT DOES NOT FALL THROUGH TO "ANY ORIGIN". That case is real rather than
# theoretical: exec_server.py's /run path calls verify() with os.environ.get("PC_RP_ID", ""),
# and with the variable unset the rpIdHash comparison is against sha256(b"") -- a digest an
# attacker puts in authenticatorData as easily as we compute it. An empty rp id and an unset
# allowlist yield an empty list here, and verify() refuses on it.
#
# THE VARIABLE NAME IS A QUOTED LITERAL AT THE CALL SITE AND MUST STAY ONE.
# pipeline/collect-evidence.py's RE_ENV_PY resolves os.environ.get() only when the name is
# quoted right there (its note at :1193); a name reached through a constant is invisible to
# the scan, and F3.2 would then report PC_ALLOWED_ORIGINS as "set on the revision, read
# nowhere" the day an install sets it -- the manufactured finding that file exists to avoid.
def allowed_origins(expected_rp_id):
    """Origins an assertion may have been signed at. AN EMPTY LIST MEANS REFUSE, NEVER ALLOW.

    Split on whitespace as well as commas, for the reason lockout_check._envlist() gives in
    full: `gcloud run deploy --set-env-vars` is itself comma-delimited, so a comma-written
    value arrives cut into separate variables and only a space-written one survives.
    """
    out = [x for x in re.split(r"[,\s]+", os.environ.get("PC_ALLOWED_ORIGINS", "").strip()) if x]
    if out:
        return out
    rp = (expected_rp_id or "").strip() if isinstance(expected_rp_id, str) else ""
    return ["https://" + rp] if rp else []


class Rejected(Exception):
    pass

def verify(assertion, creds, expected_challenge_b64u, expected_rp_id, require_uv=True):
    """assertion: {id, response:{clientDataJSON, authenticatorData, signature}}
    creds: {credential_id_b64u: {'crv':'P-256','x':b64u,'y':b64u}}
    Returns (credential_id, signature_counter) on success -- see the counter note below for
    why the counter comes back out rather than being enforced here. Raises Rejected, AND ONLY
    Rejected, otherwise: [fleet: verifier-must-not-crash-on-hostile-input] a verifier on the
    approval path that raises something else on a truncated, non-base64 or non-JSON body is a
    denial of service aimed at that path, and an unexpected exception type is how a FAILED
    verification quietly becomes a caught-and-forgiven one. Every decode below is inside that
    contract."""
    if not isinstance(assertion, dict):
        raise Rejected('malformed assertion')
    cid = assertion.get('id') or ''
    if not isinstance(cid, str) or cid not in creds:
        raise Rejected('unknown credential id')
    r = assertion.get('response')
    if not isinstance(r, dict):
        raise Rejected('malformed assertion response')
    try:
        cdj = b64u_dec(r.get('clientDataJSON') or '')
        ad = b64u_dec(r.get('authenticatorData') or '')
        sig = b64u_dec(r.get('signature') or '')
        cd = json.loads(cdj.decode())
    except Exception:
        raise Rejected('assertion is not decodable')
    if not isinstance(cd, dict):
        raise Rejected('clientData is not an object')
    if cd.get('type') != 'webauthn.get':
        raise Rejected('wrong clientData type')
    _origins = allowed_origins(expected_rp_id)
    if not _origins:
        raise Rejected('no allowed origin is configured; refusing rather than accepting any')
    if cd.get('origin') not in _origins:
        raise Rejected('origin not allowed')
    if cd.get('challenge') != expected_challenge_b64u:
        raise Rejected('challenge mismatch')
    if len(ad) < 37:
        raise Rejected('authenticatorData too short')
    if ad[:32] != hashlib.sha256((expected_rp_id or '').encode()).digest():
        raise Rejected('rpIdHash mismatch')
    flags = ad[32]
    if not (flags & FLAG_UP):
        raise Rejected('user presence not set')
    if require_uv and not (flags & FLAG_UV):
        raise Rejected('user verification not performed')
    jwk = creds[cid]
    pub = ec.EllipticCurvePublicNumbers(
        int.from_bytes(b64u_dec(jwk['x']), 'big'),
        int.from_bytes(b64u_dec(jwk['y']), 'big'),
        ec.SECP256R1()).public_key()
    signed = ad + hashlib.sha256(cdj).digest()
    try:
        pub.verify(sig, signed, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise Rejected('signature invalid')
    except Exception:
        # The signature bytes are attacker-supplied and are parsed as DER in here, so a
        # malformed one must be a refusal like any other, not an escaping ValueError.
        raise Rejected('signature not verifiable')
    # [SEC-ASSERT-ORIGIN-COUNTER-V1] THE SIGNATURE COUNTER, READ AFTER THE SIGNATURE AND NOT
    # BEFORE. Bytes 33..36 are inside `signed`, so the number is worth something only once
    # pub.verify() has passed; read any earlier it is four bytes the caller chose.
    #
    # WHAT THIS MODULE CAN AND CANNOT DO WITH IT, SAID PLAINLY INSTEAD OF IMPLIED. Enforcing
    # monotonicity needs a floor that SURVIVES the request and that the control plane cannot
    # rewrite, and this verifier has no such store: creds arrive from pcmint.load_creds(), a
    # read-only Secret Manager access, and the one datastore the executor can write is
    # Firestore -- which load_creds()'s own docstring rejects for exactly this purpose,
    # because the control plane holds datastore.user and could reset any floor it disliked.
    # So the floor is enforced WHERE IT EXISTS -- an enrolment record may carry sign_count,
    # written where credentials are managed, which is the one place the control plane cannot
    # write -- and where it does not exist the counter is RETURNED to the caller rather than
    # silently dropped. A returned counter nobody persists is not a replay defence and is not
    # claimed as one; it is the value a caller with a store needs to build one.
    counter = int.from_bytes(ad[33:37], 'big')
    try:
        floor = int(jwk.get('sign_count')) if isinstance(jwk, dict) else 0
    except (TypeError, ValueError):
        floor = 0
    # floor 0 or absent means no floor was ever recorded; counter 0 means this authenticator
    # does not implement counters at all -- U2F-era keys and several platform authenticators
    # report 0 forever. Neither is evidence of replay, so neither refuses on its own.
    if floor > 0 and counter <= floor:
        raise Rejected('signature counter did not advance: %d <= %d' % (counter, floor))
    return cid, counter

def challenge_is_bound(expected_challenge_b64u, job_id, action):
    """The last 32 bytes of the challenge must be sha256(jobId|action). This is what makes an
    assertion usable for exactly one job -- without it a valid assertion approves anything.

    [SEC-ASSERT-ORIGIN-COUNTER-V1] [fleet: verifier-must-not-crash-on-hostile-input] The
    question this answers is "does this challenge bind to this job?", and for an undecodable
    challenge or a non-string job id that question HAS an answer -- no. It used to raise one
    of binascii.Error, TypeError or AttributeError instead, straight out of a caller-supplied
    string, on the rung ABOVE the signature check."""
    try:
        raw = b64u_dec(expected_challenge_b64u)
        want = hashlib.sha256((job_id + '|' + action).encode()).digest()
    except Exception:
        return False
    if len(raw) < 32:
        return False
    return raw[-32:] == want
