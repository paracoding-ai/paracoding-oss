---
page: model-config
title: Model configuration
section: extend
status: live
audience: public
owner: unassigned
generated_by: starter-edition
verified_at: "2026-08-10"
verified_by: starter-edition
watch:
  - "lake:shared/wiki/_release.txt@71b8aebd9209c5b60ca8ccc1ef4bb906ec2a7a5e39d77743e915866794b5d323"
---

# Model configuration

## The default, and why it is that

Console chat defaults to **`gemini-3.7-flash` over Vertex AI, at location `global`,
with no API key required.** Claude is a one-click escalation from the same page.

Vertex means the request is authenticated by the control plane's own Google service
account, billed to your project, and never leaves your cloud account boundary. There
is no third-party key to store, rotate, or leak. That is the whole argument for the
default.

Gemini is the floor because it is the substrate a fresh install can actually reach:
it needs no key of any kind, and the 3.x publisher models are served from the
`global` endpoint, which the control plane pins for any model id beginning `gemini-3`
regardless of the configured region. Claude on Vertex depends on a per-project
allocation you may not have. Claude is not removed and not degraded -- it is the
substrate you escalate to, by clicking Claude in the console header (or in
**Layers > Settings**), which wins over the default for that request.

Set `CHAT_DEFAULT_PROVIDER=claude` to make Claude the default again. It is an
environment variable, so it takes a config revision and no rebuild. Any value other
than `claude` or `gemini` falls back to Gemini rather than being trusted -- an
unrecognised substrate name is a typo, and a typo must not silently pick the
expensive side. The console reads the same value: `GET /api/models` publishes it as
`default_provider`, and the page applies it only when you have not picked a
substrate yourself.

Claude also reaches the direct Anthropic API instead of Vertex when
`CHAT_CLAUDE_PROVIDER=anthropic` (`api`, `key` and `direct` are accepted spellings)
and a Claude API key is stored. Vertex is the default and a key sitting in Secret
Manager cannot change the transport on its own -- it is data, not configuration.

**Effort is a Claude setting**, sent as `medium` by default. `high` is the API
default and is sent by omitting the effort field entirely; `medium` is sent
explicitly and costs less per turn. If the endpoint rejects the effort field, the
request is retried without it and the console reports the effort it **actually**
used. The badge is not allowed to claim a setting the request did not carry. The
Gemini path does not send an effort field at all, which is why no effort appears on
a Gemini reply's stamp.

The model catalog offered in the UI is built from the environment, and **the order
is the default** -- there is no separate "default model" field. Gemini lists
`gemini-3.7-flash` first with `gemini-3.1-pro-preview` as a second button; Claude
lists `claude-opus-5` first with `claude-sonnet-5` second. On a fresh install with
nothing configured you get all four, and the two the default paths pick are the
first of each list.

## What you need for the default to work

The control plane's service account needs Vertex access:

```
gcloud projects add-iam-policy-binding <your-project> \
  --member serviceAccount:<control-plane-service-account> \
  --role roles/aiplatform.user
```

Without it, Vertex returns 403 and **both** chat providers fail. The console now
surfaces that 403 and its message rather than an opaque "request failed", so you will
see what is actually wrong. See **Troubleshooting**.

You also need the Anthropic publisher models enabled for your project in the Vertex
region being used. That is a per-publisher enablement in Model Garden, done once, in
the Google Cloud console.

## Pointing it at a direct API key instead

Transport selection is explicit configuration, not inference. A key sitting in Secret
Manager is **data**; it cannot change the transport. This matters -- an earlier design
inferred "use the direct API" from the mere presence of a key, and a stale key left
over from months earlier silently diverted every request to an endpoint it could no
longer authenticate against.

To opt in to the direct Anthropic API:

```
gcloud run services update <console-service> \
  --region <your-region> --project <your-project> \
  --update-env-vars CHAT_CLAUDE_PROVIDER=anthropic
```

Accepted values for direct-API mode: `anthropic`, `api`, `key`, `direct`. **Anything
else, including unset, means Vertex.**

Then give it a key, by either route:

- set `ANTHROPIC_API_KEY` on the console service, or
- store it in Secret Manager as `chat-key-claude` -- the console's key page writes
  exactly that secret, and the key never touches your browser on the way back out.

If you set `CHAT_CLAUDE_PROVIDER=anthropic` with nothing to authenticate with, the
request fails with a precise error rather than silently falling back. That is a real
misconfiguration and it should be reported.

To go back to Vertex, remove the variable:

```
gcloud run services update <console-service> \
  --region <your-region> --project <your-project> \
  --remove-env-vars CHAT_CLAUDE_PROVIDER
```

Clear any stale `chat-key-claude` secret version while you are there. It can no
longer divert your traffic, but it is still a credential you are storing for no
reason.

## Where Gemini fits

Gemini is the second provider in the console's model toggle. It does not run queued
work -- there is no autonomous loop and nothing that dispatches. It follows the same rule as Claude:
**Vertex by default**, billed to your project, authenticated by the service account.

The AI Studio endpoint is an explicit opt-in and needs both the switch and a real key:

```
CHAT_GEMINI_PROVIDER=studio
GEMINI_API_KEY=...        (or the chat-key-gemini secret)
```

One trap worth knowing: the configured Gemini model id is a **Vertex publisher** id.
It does not exist on AI Studio. Sending it there returns 404 no matter how valid your
key is. If you switch to Studio, switch the model id too.

The Vertex region for Gemini defaults to `global`, which is served by the bare
`aiplatform.googleapis.com` host rather than a regionalised one. A global-only
publisher model will 404 against a regional host. If you override the region, check
the model is published there.

## Seeing what it actually picked

You should never have to read code to answer "which model, which transport".

**Per request**, the console logs one resolution line to Cloud Logging: provider,
transport, region, host, model, effort, and whether a key was present. `key_present`
is a boolean. No key value and no bearer token ever enters that object.

**On demand**, `GET /api/keys/status` returns a `chat` object with the same resolved
view for both providers. Behind the gate session, like everything else on the console.

Confirm a change landed by making one chat request per provider and then reading that
endpoint. On a stock install the Gemini entry says `transport: vertex`,
`region: global` and `model: gemini-3.7-flash`; the Claude entry says
`transport: vertex` and `model: claude-opus-5`.

## Cost

Model access ships **off** by default (`fleet_mode=home`). The system spends nothing
until you turn something on. When you do, it is your Vertex quota and your project's
bill -- there is no intermediary metering you.

Chat is per-turn and interactive, and it is the only thing here that can spend. Nothing
in this product runs queued work on its own, so there is no unattended spend to turn on.

## If a change seems to do nothing

Environment changes need a redeploy of the affected service, and a source change
needs a rebuild. Check the revision that is actually serving before concluding the
setting is broken -- see **Changing the code**, step 5.
