"""Minter-side WebAuthn assertion verification.

WHY THIS EXISTS: today the control plane verifies the passkey and writes status=confirmed,
and the executor trusts that verdict. A compromised control plane therefore approves anything
by writing one field. Moving verification here means the control plane must FORWARD a real
assertion it cannot forge -- it would need the operator's device.

Public keys are stored as JSON {crv,x,y}, NOT COSE/CBOR, so this module needs no CBOR parser
and the conversion happens once at enrolment where a mistake is loud instead of silent.
"""
import base64, hashlib, json, struct
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
from cryptography.exceptions import InvalidSignature

def b64u_dec(s):
    s = s + '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode())

FLAG_UP = 0x01
FLAG_UV = 0x04

class Rejected(Exception):
    pass

def verify(assertion, creds, expected_challenge_b64u, expected_rp_id, require_uv=True):
    """assertion: {id, response:{clientDataJSON, authenticatorData, signature}}
    creds: {credential_id_b64u: {'crv':'P-256','x':b64u,'y':b64u}}
    Returns the credential id on success. Raises Rejected otherwise."""
    cid = assertion.get('id') or ''
    if cid not in creds:
        raise Rejected('unknown credential id')
    r = assertion.get('response') or {}
    cdj = b64u_dec(r.get('clientDataJSON') or '')
    ad = b64u_dec(r.get('authenticatorData') or '')
    sig = b64u_dec(r.get('signature') or '')
    cd = json.loads(cdj.decode())
    if cd.get('type') != 'webauthn.get':
        raise Rejected('wrong clientData type')
    if cd.get('challenge') != expected_challenge_b64u:
        raise Rejected('challenge mismatch')
    if len(ad) < 37:
        raise Rejected('authenticatorData too short')
    if ad[:32] != hashlib.sha256(expected_rp_id.encode()).digest():
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
    return cid

def challenge_is_bound(expected_challenge_b64u, job_id, action):
    """The last 32 bytes of the challenge must be sha256(jobId|action). This is what makes an
    assertion usable for exactly one job -- without it a valid assertion approves anything."""
    raw = b64u_dec(expected_challenge_b64u)
    if len(raw) < 32:
        return False
    return raw[-32:] == hashlib.sha256((job_id + '|' + action).encode()).digest()
