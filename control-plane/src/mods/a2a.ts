// SPDX-License-Identifier: Apache-2.0
// [A2A-V1] Agent-to-Agent (A2A v0.2.5) agent cards, built live from the strains registry + our
// OAuth 2.1 security scheme. Extracted VERBATIM from index.ts. oaPubBase from ../shared.js,
// strainList from ./strain.js — no import of index.ts. The /.well-known/* routes stay in index
// and call a2aServeCard.
import { oaPubBase } from '../shared.js';
import { strainList } from './strain.js';

export function a2aSecurity(b: string): any {
  return {
    securitySchemes: {
      paracoding_oauth: {
        type: 'oauth2', description: 'Paracoding fleet OAuth 2.1 (Google-backed identity, PKCE, no client secret)',
        flows: { authorizationCode: { authorizationUrl: b + '/oauth/authorize', tokenUrl: b + '/oauth/token', refreshUrl: b + '/oauth/token', scopes: { mcp: 'Fleet MCP access' } } },
      },
    },
    security: [{ paracoding_oauth: ['mcp'] }],
  };
}
export function a2aCard(role: string, display: string, b: string): any {
  const sec = a2aSecurity(b);
  return {
    protocolVersion: '0.2.5',
    name: display || role,
    description: 'Paracoding fleet strain "' + role + '" - an autonomous agent on the Paracoding control plane.',
    url: b + '/mcp',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Paracoding.AI', url: b },
    version: '1.0.0',
    documentationUrl: b + '/.well-known/agents',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    securitySchemes: sec.securitySchemes,
    security: sec.security,
    skills: [{ id: role + '.work', name: role + ' tasks', description: 'Role-scoped fleet work performed by the ' + role + ' strain.', tags: ['paracoding', 'fleet', role], inputModes: ['text/plain'], outputModes: ['text/plain'] }],
    'x-paracoding': { role, registry: b + '/api/strains', identityModel: 'per-agent (A2A)', liveTransport: 'mcp-streamable-http' },
  };
}
export async function a2aServeCard(req: any, res: any, role: string): Promise<void> {
  const b = oaPubBase(req);
  const rows = await strainList(false);
  const row = rows.find((r: any) => r.role === role);
  // [SEC-AUDIT-V105-HIDDEN-CARD] /.well-known/agents already withholds hidden roles (r.hidden
  // !== true) from the public roster, but this route served the full agent card for one anyway
  // if the caller already knew (or guessed) its name -- hidden was a roster-listing filter, not
  // an access control. A hidden strain must 404 exactly as an absent or inactive one does, with
  // the SAME body, so a prober cannot distinguish "hidden" from "does not exist" by response shape.
  if (!row || row.status !== 'active' || row.hidden === true) { res.status(404).json({ error: 'no active strain "' + role + '"' }); return; }
  res.setHeader('Content-Type', 'application/json');
  res.json(a2aCard(row.role, row.display_name || row.role, b));
}
