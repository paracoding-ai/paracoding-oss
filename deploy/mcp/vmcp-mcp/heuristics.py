# ============================================================================
# VENDORED — pinned mirror of root/paracoding-security : prompt-guard/heuristics.py
# @ 2d4ff3dbedec84891df8fcc5ab0fc607ac6d05b4  (DO NOT EDIT HERE)
# Owner: fleet-security (Picket) lane. Refresh: ./refresh-picket.sh <ref>
# ============================================================================
# SPDX-License-Identifier: Apache-2.0
"""
Signature layer for the injection guard -- the always-on "Snort rules" tier.

Pure-Python, zero model, microseconds per call. Runs ALWAYS: as a fast pre-filter
in front of the model and as the fail-safe when the model is loading or degraded.
Each rule is (name, compiled_regex, severity, note). Severity: critical|high|medium.

Aimed at the two things that actually hurt an agent fleet holding owner-level tools:
  (1) prompt-injection / instruction-override reaching the model (direct + indirect), and
  (2) classic web-injection (SQLi / traversal / command / SSRF) riding in content.

False positives here only FLAG (see policy in app.py); only a "critical" signature or
the model tier BLOCKS by default.
"""
import re

_R = re.IGNORECASE | re.DOTALL

RULES = [
    # ---- prompt injection / instruction override --------------------------------
    ("pi.override_instructions",
     re.compile(r"\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instruction|prompt|rule|context|message)s?\b", _R),
     "high", "classic 'ignore previous instructions'"),
    ("pi.reveal_system_prompt",
     re.compile(r"\b(reveal|show|print|repeat|output|dump|leak)\b.{0,30}\b(system|developer|initial)\b.{0,10}\b(prompt|instruction|message)s?\b", _R),
     "high", "system-prompt extraction"),
    ("pi.role_reassign",
     re.compile(r"\b(you are now|from now on you are|new (system )?role|act as (an? )?(unrestricted|jailbroken|dan|developer mode))\b", _R),
     "high", "role reassignment / jailbreak persona"),
    ("pi.tool_coercion",
     re.compile(r"\b(call|invoke|run|execute|use)\b.{0,25}\b(run_command|gcp_api|gcloud|gitlab_api|stage_privileged_job|vmcp_sudo|shell|bash)\b", _R),
     "critical", "coerces a named privileged tool"),
    ("pi.exfil_secrets",
     re.compile(r"\b(exfiltrate|send|post|upload|leak|curl|wget|fetch|paste|dump|copy)\b.{0,80}(token|secret|api[_-]?key|credential|service[_-]?account|/etc/|control-plane\.env|\.env\b)", _R),
     "critical", "secret exfiltration"),
    ("pi.egress_url",
     re.compile(r"\b(curl|wget|http\.request|fetch\()\b.{0,20}https?://(?!(console|mcp)\.example\.com)", _R),
     "high", "outbound call to a non-fleet URL"),
    ("pi.hidden_markup",
     re.compile(r"<\s*(system|assistant|developer|tool_call)\s*>|\[/?INST\]|<\|im_start\|>|<\|im_end\|>", _R),
     "high", "chat-template / role markup injected into content (indirect injection)"),
    ("pi.data_uri_blob",
     re.compile(r"data:[^;]+;base64,[A-Za-z0-9+/]{200,}", _R),
     "medium", "large inline base64 blob"),
    ("pi.zero_width",
     re.compile(r"[​‌‍⁠﻿]{3,}", _R),
     "medium", "zero-width characters (steganographic injection)"),

    # ---- classic web injection (still real: state is Postgres now) --------------
    ("web.sqli_union",
     re.compile(r"\bunion\b\s+(all\s+)?\bselect\b|\bselect\b.{0,80}\bfrom\b.{0,80}\b(information_schema|pg_catalog|pg_user|pg_shadow)\b", _R),
     "high", "SQL UNION / schema probing"),
    ("web.sqli_tautology",
     re.compile(r"('|\")\s*(or|and)\s+('?\d+'?\s*=\s*'?\d+'?|true)\s*(--|#|/\*)", _R),
     "high", "SQLi tautology with comment terminator"),
    ("web.sqli_stacked",
     re.compile(r";\s*(drop|delete|update|insert|alter|create|truncate|copy)\b", _R),
     "high", "stacked SQL statement"),
    ("web.path_traversal",
     re.compile(r"(\.\./){2,}|%2e%2e(%2f|/){1,}", _R),
     "high", "directory traversal"),
    ("web.cmd_inject",
     re.compile(r"(;|\||&&|`|\$\()\s*(cat|ls|id|whoami|curl|wget|nc|bash|sh|python|rm)\b", _R),
     "high", "shell metacharacters + command"),
    ("web.ssrf_metadata",
     re.compile(r"https?://(169\.254\.169\.254|metadata(\.google)?(\.internal)?)\b", _R),
     "critical", "cloud metadata SSRF"),
]


# Hard input cap. The signature engine must never crash or hang on hostile input: a
# multi-megabyte payload against .{0,80}+alternation regexes is a CPU/ReDoS DoS. We scan a
# bounded prefix -- an injection that matters lands early -- and the caller sees it was capped.
# (Follow-up hardening: move to a linear-time engine (re2) to drop the prefix limit.)
MAX_SCAN = 65536


def scan(text):
    """Return list of {rule, severity, note} for every signature that fires. Input-capped."""
    if not text:
        return []
    if len(text) > MAX_SCAN:
        text = text[:MAX_SCAN]
    return [{"rule": n, "severity": s, "note": note}
            for n, rx, s, note in RULES if rx.search(text)]


def worst(hits):
    order = {"critical": 3, "high": 2, "medium": 1}
    return max((order.get(h["severity"], 0) for h in hits), default=0)
