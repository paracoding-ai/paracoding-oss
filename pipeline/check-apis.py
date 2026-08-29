#!/usr/bin/env python3
"""Fail if install.sh and fleet/apis.txt disagree about which Google Cloud APIs this
product needs.

WHAT THIS EXISTS TO CATCH, stated as the defect rather than as a rule. The API set lived
in one `gcloud services enable` line inside install.sh and nothing compared it against
what the product actually calls. An audit of a live project found five APIs that code in
the tree reaches and the installer never enabled -- they worked only because that project
had accumulated them over a long life. The failure would have appeared on a stranger's
fresh install and on no machine any developer owns.

fleet/apis.txt is now the declaration. install.sh keeps an embedded copy because it must
run as one file a stranger downloads and cannot read a sibling. This script is the only
thing that keeps the copy honest, so it checks all three directions drift can go:

  1. install.sh's 1/10 batch == [install-batch], EXACTLY. Catches an API added to the
     installer without a declaration, and a declaration with no installer line.
  2. every [install-later] and [optional] entry is enabled SOMEWHERE in install.sh.
     Catches a declaration for something nothing turns on.
  3. every API in ANY `services enable` in install.sh is declared somewhere in apis.txt.
     This is the direction that would have caught the original defect.

Exit 0 on agreement, 1 on any disagreement, with the specific APIs named. It prints what
it compared even on success, because a check whose output is only "ok" is a check people
stop believing.
"""

import os
import re
import sys

HOST = re.compile(r'[a-z0-9][a-z0-9.-]*\.googleapis\.com')
SECTION = re.compile(r'^\[([a-z-]+)\]\s*$')
BATCH_MARKER = 'could not enable APIs'


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_declaration(path):
    """Parse apis.txt into {section: [api, ...]}. Refuses a malformed declaration rather
    than quietly parsing half of it -- a typo in a declaration is invisible otherwise."""
    sections = {}
    current = None
    seen = {}
    problems = []
    with open(path, encoding='utf-8') as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.split('#', 1)[0].strip()
            if not line:
                continue
            m = SECTION.match(line)
            if m:
                current = m.group(1)
                sections.setdefault(current, [])
                continue
            if current is None:
                problems.append('%s:%d: entry before any [section] header: %r' % (path, n, line))
                continue
            if not HOST.fullmatch(line):
                problems.append('%s:%d: not an api host: %r' % (path, n, line))
                continue
            if line in seen:
                problems.append('%s:%d: %s already declared at line %d'
                                % (path, n, line, seen[line]))
                continue
            seen[line] = n
            sections[current].append(line)
    return sections, problems


def join_continuations(lines):
    """Yield (first_line_number, joined_command) for every logical shell line."""
    buf, start = None, None
    for n, raw in enumerate(lines, 1):
        line = raw.rstrip('\n')
        if buf is None:
            start, buf = n, line
        else:
            buf += ' ' + line.strip()
        if buf.rstrip().endswith('\\'):
            buf = buf.rstrip()[:-1]
            continue
        yield start, buf
        buf, start = None, None
    if buf is not None:
        yield start, buf


def read_installer(path):
    """Return (batch_set, all_enabled_set). A commented-out line is not an enable."""
    with open(path, encoding='utf-8') as fh:
        lines = fh.readlines()
    batch, every = set(), set()
    batch_sites = []
    for n, cmd in join_continuations(lines):
        if 'services enable' not in cmd:
            continue
        if cmd.lstrip().startswith('#'):
            continue
        found = set(HOST.findall(cmd))
        every |= found
        if BATCH_MARKER in cmd:
            batch |= found
            batch_sites.append(n)
    return batch, every, batch_sites


def main():
    root = repo_root()
    decl_path = os.path.join(root, 'fleet', 'apis.txt')
    inst_path = os.path.join(root, 'install.sh')
    for p in (decl_path, inst_path):
        if not os.path.exists(p):
            print('MISSING: %s' % p, file=sys.stderr)
            return 1

    sections, problems = read_declaration(decl_path)
    batch, every, batch_sites = read_installer(inst_path)

    if len(batch_sites) != 1:
        problems.append(
            'expected exactly one `services enable` ending in %r in install.sh, found %d%s'
            % (BATCH_MARKER, len(batch_sites),
               (' at lines ' + ', '.join(str(x) for x in batch_sites)) if batch_sites else ''))

    declared_batch = set(sections.get('install-batch', []))
    declared_later = set(sections.get('install-later', []))
    declared_opt = set(sections.get('optional', []))
    declared_all = declared_batch | declared_later | declared_opt

    # 1. exact agreement on the batch
    for a in sorted(declared_batch - batch):
        problems.append('declared in [install-batch] but NOT enabled by the 1/10 batch: %s' % a)
    for a in sorted(batch - declared_batch):
        problems.append('enabled by the 1/10 batch but NOT declared in [install-batch]: %s' % a)

    # 2. the late and optional ones are really enabled somewhere
    for a in sorted((declared_later | declared_opt) - every):
        problems.append('declared but install.sh never enables it anywhere: %s' % a)

    # 3. nothing the installer enables is undeclared
    for a in sorted(every - declared_all):
        problems.append('install.sh enables it but fleet/apis.txt does not declare it: %s' % a)

    print('fleet/apis.txt   batch=%d later=%d optional=%d'
          % (len(declared_batch), len(declared_later), len(declared_opt)))
    print('install.sh       batch=%d enabled-anywhere=%d (batch at line %s)'
          % (len(batch), len(every),
             batch_sites[0] if len(batch_sites) == 1 else '?'))

    if problems:
        print('')
        for p in problems:
            print('FAIL: %s' % p, file=sys.stderr)
        print('', file=sys.stderr)
        print('The declaration is fleet/apis.txt. install.sh carries a COPY of the batch,'
              ' because it', file=sys.stderr)
        print('must run as one file a stranger downloads. Change the file, then match the'
              ' copy.', file=sys.stderr)
        return 1

    print('')
    print('OK: the installer enables exactly what fleet/apis.txt declares.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
