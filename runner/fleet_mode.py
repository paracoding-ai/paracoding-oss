#!/usr/bin/env python3
# fleet_mode.py -- THE fleet-mode switch. ONE implementation, imported by every runner.
#
# work_item_runner.py, answer_runner.py and sweep_runner.py all gate their spend on this file.
# It is deliberately a separate module rather than three copies of the same twenty lines: the
# same decision written twice drifts, and the drift is invisible until it costs money. That is
# the same law that forbids one algorithm in two languages, applied to two copies in one.
#
# NOTHING HERE TOUCHES FIRESTORE, THE NETWORK OR THE ENVIRONMENT. read_config_models() is handed
# an already-constructed client by its caller. So this module imports cleanly into every runner
# image without dragging a client library in behind it, and it is trivially testable.
#
# THREE POSITIONS:
# home : every model bus OFF. MCP + tools + GCP building still work; the human drives from their
#        own Claude plan. No Anthropic call, no Vertex call, no token spend.
# dual : Anthropic KEY bus + Vertex Gemini bus (the historical behaviour).
# work : Vertex Gemini + Vertex Claude, KEYLESS, billed to the hosting project (lab install where
#        the employer pays and no personal Claude plan exists).
#
# config/models.fleet_mode is the ONLY source of truth and is read live. There is deliberately no
# mirrored env var and no cached copy: a second copy of a value drifts, and the drift is invisible
# until it costs something.
#
# FAIL SAFE, IN EVERY DIRECTION: missing, unreadable, empty or unrecognised resolves to 'home',
# which spends nothing.

FLEET_MODES = ('home', 'dual', 'work')
FLEET_MODE_FALLBACK = 'home'

# The two ways a model call can be paid for. 'key' is an API key billed to a card; 'vertex' is
# keyless ADC billed to the hosting GCP project. The distinction IS the difference between the
# two on-modes, so it is a first-class argument and never inferred.
TRANSPORTS = ('key', 'vertex')

SUBSTRATES = ('gemini', 'claude')


def read_config_models(db):
    """The config/models document as a plain dict. NEVER raises; unreadable reads as {}.

    An empty dict resolves to FLEET_MODE_FALLBACK in fleet_mode() below, so an unreadable
    Firestore is indistinguishable from an absent switch and both spend nothing."""
    try:
        d = db.collection('config').document('models').get()
        return (d.to_dict() or {}) if d.exists else {}
    except Exception:
        return {}


def fleet_mode(cfg=None):
    """The live mode, from an already-read config/models dict.

    Missing, unreadable, empty or unrecognised -> FLEET_MODE_FALLBACK ('home'). A caller that
    could not read the config passes None or {} and gets the most restrictive answer, which is
    the only failure direction that cannot cost money."""
    try:
        m = str((cfg or {}).get('fleet_mode') or '').strip().lower()
        return m if m in FLEET_MODES else FLEET_MODE_FALLBACK
    except Exception:
        return FLEET_MODE_FALLBACK


def bus_allowed(mode, provider, transport):
    """May THIS substrate make a model call on THIS transport in THIS mode?

    THIS FUNCTION DISTINGUISHES THE TWO ON-MODES, WHICH IS WHAT ITS PREDECESSOR'S DOCSTRING
    CLAIMED AND ITS CODE DID NOT. The old body tested only `mode == 'home'` and then allowed any
    known provider, so 'work' -- the mode whose entire definition is KEYLESS, employer-billed --
    permitted the keyed Anthropic transport on exactly the same terms as 'dual'. A leftover
    ANTHROPIC_API_KEY on a lab install therefore billed a personal card from the one mode that
    exists so it would not. The keyed transport is now REFUSED in 'work', not merely not
    preferred.
    home : nothing at all.
    dual : gemini/vertex, claude/vertex, claude/key.
    work : gemini/vertex, claude/vertex.   claude/key and gemini/key are REFUSED.
    An unknown mode, an unknown substrate or an unknown transport is refused. Fail closed."""
    if mode not in FLEET_MODES or mode == 'home':
        return False
    if provider not in SUBSTRATES:
        return False
    if transport not in TRANSPORTS:
        return False
    if transport == 'key':
        # THE CODE IS NARROWED TO THE DOCSTRING, NOT THE DOCSTRING WIDENED TO THE CODE.
        # This tested `mode == 'dual'` with NO substrate distinction, so it also permitted
        # gemini/key -- a pair the docstring above has never listed. That is the SAME SHAPE
        # as the defect this function's own header describes: a body more permissive than
        # the statement readers act on, which is how a keyed transport reached a mode that
        # exists to be keyless. Fixing it in the permissive direction would have made the
        # header's own lesson untrue, so the refusal wins. dual's keyed transport is the
        # personal Anthropic key and nothing else; a keyed Gemini call is refused in every
        # mode. Fail closed, as the last line of the docstring says.
        return mode == 'dual' and provider == 'claude'
    return True


def any_bus_allowed(mode):
    """True iff SOME substrate/transport pair may spend in this mode.

    For the components that make no model call themselves but manufacture one for something
    else -- the sweeper writes agent_messages the answer runner pays for, and re-queues items
    the work runner pays for. Derived from bus_allowed() rather than restating it."""
    for provider in SUBSTRATES:
        for transport in TRANSPORTS:
            if bus_allowed(mode, provider, transport):
                return True
    return False


def claude_transport(cfg, mode, env_provider=''):
    """Which transport the Claude path WOULD use: 'vertex' (keyless ADC) or 'key' (billed card).

    In 'work' mode the fleet is keyless by definition, so Vertex is the only transport this mode
    has. Returning it here is not a preference that something downstream may quietly override:
    bus_allowed() refuses the keyed transport in this mode and make_client() refuses to construct
    a keyed client in it, so a work-mode deployment that cannot reach Vertex fails loudly instead
    of falling back onto somebody's card."""
    if mode == 'work':
        return 'vertex'
    p = str((cfg or {}).get('claude_provider') or env_provider or 'anthropic').strip().lower()
    return 'vertex' if p == 'vertex' else 'key'


def refusal_text(mode, provider, transport):
    """One line naming the mode, the substrate, the transport and where the switch lives.

    Fit for a journal row, a stdout line and a result_note, so all three say the same thing."""
    if mode == FLEET_MODE_FALLBACK:
        why = ("every model bus is OFF in this mode (this is also where an unreadable, absent, "
               "empty or unrecognised switch lands)")
    elif transport == 'key' and mode == 'work':
        why = ("mode 'work' is KEYLESS by definition and REFUSES the keyed transport, so a "
               "leftover API key cannot bill a card from it")
    else:
        why = "that substrate/transport pair is not permitted in this mode"
    return ("FLEET MODE '%s': %s/%s was not called -- %s. Flip it at config/models.fleet_mode "
            "(%s)." % (mode, provider, transport, why, ' | '.join(FLEET_MODES)))
