// SPDX-License-Identifier: Apache-2.0
// [IDENTITY-MOD-V1] Cleanly-separable identity/strain HELPER functions extracted VERBATIM from
// index.ts (strangler modularization). These are the dependency-light helpers only -- the live
// auth DECISION path (pcResolveIdentity, pcSessionLookup, pcExtract, pcBindOrRefuse,
// pcDelegatedUser, pcStrainRow, ...) and all shared session/admission state stay in index.ts.
// This module imports ONLY from ../shared.js (never ../index.js), so it carries no import cycle.
import { tsMillis, WA_APPROVER_EMAILS, PC_KEY_TTL_DAYS } from '../shared.js';

export function pcRowMillis(row: any): number {
  const t = row && row.timestamp;
  const ms = tsMillis(t);
  if (ms) return ms;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string' && t) { const p = Date.parse(t); if (!isNaN(p)) return p; }
  return 0;
}

export function pcStrainVisible(s: any, viewer: string | null): boolean {
  if (viewer === null) return true;
  if (!viewer) return false;
  const owner = String((s && s.owner_email) || '').toLowerCase();
  if (owner) {
    if (owner === viewer) return true;
    const sh = (s && Array.isArray(s.shared_with)) ? s.shared_with : [];
    for (const e of sh) { if (String(e || '').toLowerCase() === viewer) return true; }
    return false;
  }
  return WA_APPROVER_EMAILS.indexOf(viewer) >= 0;
}

const PC_TRUSTED_PROXY_HOPS = (function () {
  const n = Number(process.env.PC_TRUSTED_PROXY_HOPS || '1');
  return (isFinite(n) && n >= 0) ? Math.floor(n) : 1;
})();
export function pcTrustedClientIp(req: any): string {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map((s: string) => s.trim()).filter(Boolean);
  if (xff.length) {
    const idx = xff.length - 1 - PC_TRUSTED_PROXY_HOPS;
    return xff[idx >= 0 ? idx : 0];
  }
  return String((req && req.ip) || (req && req.connection && req.connection.remoteAddress)
    || (req && req.socket && req.socket.remoteAddress) || 'unknown');
}

export function pcDeniedText(reason: string): string {
  // [GE-USER-IDENTITY-V130] A person behind a delegating agent is not in a Cowork chat and has
  // no key to paste; the paste instructions below would send them somewhere that cannot help.
  if (reason === 'no-strain-for-user' || reason === 'user-ambiguous') {
    return 'DENIED: your Google account is signed in, but it has no Paracoding strain assigned' + (reason === 'user-ambiguous' ? ' unambiguously' : '') + '. Ask the operator to assign one (a strain with your address as user_email). Nothing was run.';
  }
  if (reason.indexOf('user-') === 0) {
    const w = reason.slice(5);
    return 'DENIED: this agent is configured to act as the signed-in person, and that identity could not be verified (' + w + '). '
      + (w === 'missing' ? 'No user token reached the control plane: the agent needs an authorization attached in Gemini Enterprise and the person must have consented to it. '
        : (w === 'unconfigured' ? 'The agent strain has no user_token_aud; the operator must set it to the authorization\'s OAuth client id. '
          : (w === 'audience' ? 'The token was minted for a different OAuth client than the one this agent is bound to. '
            : (w === 'rejected' ? 'Google would not resolve the token (expired or revoked); sign in to the agent again. '
              : 'Try again shortly; if it persists, tell the operator. '))))
      + 'Nothing was run.';
  }
  if (reason.indexOf('role-keyword:') === 0) {
    return 'DENIED (role keyword): ' + reason.slice('role-keyword:'.length) + '. Name an existing, pasteable strain by its short name (e.g. "advisor"). Create the strain first if it does not exist. Nothing was run.';
  }
  const why = (reason === 'unknown-or-revoked')
    ? 'The session key in this chat is not recognised, has EXPIRED, or has been revoked. Session keys last ' + PC_KEY_TTL_DAYS + ' days -- mint a fresh paste at the Autoclave and replace the PC-SESSION-KEY line.'
    : ((reason === 'mixed')
      ? 'This request carried more than one session key.'
      : 'This chat has not established an identity yet.');
  // [SEC-DENIED-RETRY-V143] THIS REFUSAL USED TO RECOMMEND THE ONE ACTION THAT MUST NEVER HAPPEN
  // ON A CONNECTOR-BOUND SURFACE: pasting a session key into the chat. Everything below the
  // blank line is correct for a client that authenticates WITH a key -- Cowork, Grok -- and
  // exactly wrong for a Gemini Enterprise chat, which resolves keyless from the connector
  // bearer and needs none. Measured 2026-09-07, twice: a GE chat was refused mid-turn while
  // other calls on the SAME bearer succeeded seconds either side (six git_grep admitted, the
  // next git_read refused 420ms later), read this text, and offered to ask the operator for a
  // key. It had to be told no by hand, both times. A refusal that recommends the wrong recovery
  // is worse than one that says nothing, because the model complies with it.
  // THE RETRY ADVICE IS NOT A GUESS ABOUT THE CAUSE. Whether the underlying fault is a cold
  // instance (suspected, n=2, both within ten minutes of a traffic shift) or something else,
  // the OBSERVED fact is that a plain retry succeeded immediately on both occasions. Retrying
  // is free, cannot leak anything, and is strictly safer than soliciting a credential.
  // It is offered ONLY for the no-identity case: 'unknown-or-revoked' means a key WAS presented
  // and did not resolve, and 'mixed' means two were presented -- retrying either of those just
  // repeats the same bad key, so they keep the original text unchanged.
  const _pcRetryFirst = (reason !== 'unknown-or-revoked' && reason !== 'mixed')
    ? 'IF ANY TOOL CALL HAS ALREADY SUCCEEDED IN THIS SESSION, THIS IS TRANSIENT -- RETRY ONCE BEFORE ANYTHING ELSE. '
      + 'A chat bound to a connector resolves its identity on the server and needs NO session key. Do not ask a human for one, '
      + 'and do not accept one if it is offered: it is not needed here and a chat is not a place a credential belongs. '
      + 'Only if a retry ALSO fails does the rest of this message apply to you.' + '\n\n'
    : '';
  const txt = 'DENIED: ' + why + '\n\n' + _pcRetryFirst
    + 'This MCP connector is account-level and serves every Cowork chat, so a chat must prove which strain it is before it can use any tool. '
    + 'Pass your session key as the "agent" argument on EVERY tool call. It is the line beginning PC-SESSION-KEY in this chat bootstrap paste. '
    + 'If there is no such line, ask the operator: they mint one at the Flow Hood (Autoclave, New strain session) and paste it here. '
    + 'Do NOT guess a role name -- the role is resolved from the key on the server, and a role name is not a key.';
  return txt;
}

