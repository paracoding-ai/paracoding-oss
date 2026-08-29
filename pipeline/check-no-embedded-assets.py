#!/usr/bin/env python3
"""Fail if any file in the tree embeds an image, font or media asset as a base64 data: URI.

THE RULE, FROM THE OPERATOR, VERBATIM: "Do not embed any logos."

WHAT IT IS PROTECTING AGAINST, stated as the defect rather than as a principle.
control-plane/src/dash.html carried 39,292 characters of base64 PNG on a single line --
73% of the file's bytes. Every diff that touched the page was unreadable, the mark could
not be changed without editing markup, and the comment at the bottom of the file still
described the external URL the blob had replaced. It got there the way these always do:
the logo stopped rendering, and pasting the bytes inline fixed it immediately.

A mark belongs behind a route the console already serves. Then a rebrand replaces a FILE.

ZERO TOLERANCE, NOT A SIZE LIMIT. A threshold invites "this one is small enough", and that
argument wins eventually. The tree contains exactly zero embedded assets today, so zero is
a line that can be held. A real exception goes in ALLOWED below, with its reason, where a
reviewer sees it.

Exit 0 when clean, 1 with the file, line, type and decoded size of every offender.
"""

import os
import re
import sys

# Assembled from fragments so this file does not match its own pattern. Excluding this
# path by name would be simpler and would leave an obvious place to hide one.
_SCHEME = 'data' + ':'
_TYPES = r'(?:image|font|audio|video)'
_ENC = ';' + 'base' + '64,'
PATTERN = re.compile(_SCHEME + _TYPES + r'/([a-zA-Z0-9.+-]+)' + _ENC + r'([A-Za-z0-9+/=]+)')

# Paths that may carry an embedded asset, each with the reason it is allowed. Adding a line
# here is a decision someone makes in review, which is the entire point of the list.
ALLOWED = {
    # 'path/from/repo/root': 'why this one cannot be served from a route',
}

SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'dist', 'build'}
# THIS GENERATOR'S OWN OUTPUT IS NOT A SOURCE FILE. oss/release/ is a COPY of the emitted
# tree, rewritten by the next cut, and it lags the source between cuts BY DESIGN -- a
# content change lands on main and the re-cut follows as its own commit. Scanning it here
# double-counts every finding and, worse, reports a violation that is ALREADY FIXED in the
# file that produces it. The emitted tree is checked directly, at the point it is emitted,
# which is where a finding is actionable. Same reasoning gen.py applies with
# PC_REPO_SKIP_TREES, and it is a SKIP rather than an ALLOWED entry because nothing here is
# being permitted -- it is being checked somewhere else.
SKIP_TREES = ('oss/release',)


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def looks_like_text(path):
    """A NUL byte in the first 8KB means binary. Cheaper and more reliable than trusting
    the extension, and an embedded asset only exists inside a text file by definition."""
    try:
        with open(path, 'rb') as fh:
            return b'\0' not in fh.read(8192)
    except OSError:
        return False


def main():
    root = repo_root()
    findings = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        _rd = os.path.relpath(dirpath, root).replace(os.sep, '/')
        _rd = '' if _rd == '.' else _rd
        if any(_rd == s or _rd.startswith(s + '/') for s in SKIP_TREES):
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            if not looks_like_text(path):
                continue
            scanned += 1
            try:
                with open(path, encoding='utf-8', errors='ignore') as fh:
                    text = fh.read()
            except OSError:
                continue
            for m in PATTERN.finditer(text):
                if rel in ALLOWED:
                    continue
                line = text.count('\n', 0, m.start()) + 1
                # 4 base64 chars carry 3 bytes; close enough to name a size in an error.
                decoded = len(m.group(2)) * 3 // 4
                findings.append((rel, line, m.group(1), decoded))

    print('scanned %d text files' % scanned)
    if ALLOWED:
        print('allowed by exception: %s' % ', '.join(sorted(ALLOWED)))

    if findings:
        print('', file=sys.stderr)
        for rel, line, kind, size in findings:
            print('FAIL: %s:%d embeds a %s asset, %d bytes decoded'
                  % (rel, line, kind, size), file=sys.stderr)
        print('', file=sys.stderr)
        print('Do not embed assets. Serve the file from a route instead -- the console'
              ' already has', file=sys.stderr)
        print('handlers for /icon.png, /favicon.ico and /brand/logo.png, and the bytes ride'
              ' in the', file=sys.stderr)
        print('container beside the HTML. Then a rebrand replaces a file rather than'
              ' re-editing markup.', file=sys.stderr)
        print('', file=sys.stderr)
        print('Mind which route: /dash is PUBLIC and /brand/logo.png is session-guarded, so'
              ' a public', file=sys.stderr)
        print('page must use /icon.png or it shows a broken mark to anyone not signed in.',
              file=sys.stderr)
        print('', file=sys.stderr)
        print('If a file genuinely cannot do that, add it to ALLOWED in this script with the'
              ' reason.', file=sys.stderr)
        return 1

    print('')
    print('OK: nothing in the tree embeds an image, font or media asset.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
