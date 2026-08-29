#!/usr/bin/env python3
"""Fail if any Python file in the tree uses a name that is bound nowhere in that file.

THE DEFECT THIS EXISTS FOR, and it shipped. Both fleet runners lost their
`app = Flask(__name__)` line: it stood immediately below a PC_FIRESTORE_DB refusal block,
and the edit that replaced that block took the following line with it. Both files still
compiled. python -m py_compile PARSES a decorator; it does not EVALUATE one. So the tree
was green, the release cut said RELEASABLE, and the process died at import on

    @app.route('/', methods=['GET','POST'])     NameError: name 'app' is not defined

which is the whole service, not a path through it. A second instance of the same class was
already present in the same commit: work_item_runner.py called re.search five times with no
`import re`, and every work item that reached the deliverable classifier died there.

The common shape is not "bad logic". It is A NAME THAT IS USED AND BOUND NOWHERE -- the
residue of an edit that removed one line too many, or added a call without its import. It is
invisible to the parser and it is the first thing that happens at runtime, so it costs a
deploy to find. That is worth one check.

WHAT THIS CHECKS, STATED AS ITS LIMIT RATHER THAN AS A CLAIM. It collects every name BOUND
ANYWHERE in a file -- imports, assignments, augmented and annotated assignments, walrus,
def, async def, class, lambda and function arguments, for/with/except targets, comprehension
variables, match captures, global and nonlocal declarations -- into ONE FLAT SET per file,
then flags every name LOADED in that file that is in neither the set nor builtins.

It is deliberately SCOPE-INSENSITIVE, and that is a real weakness with a real reason. A
scope-correct analysis would also catch use-before-definition and a name bound only inside
some other function -- and it would need to model closures, conditional imports, star
imports, class bodies and `global` correctly, or it would produce false alarms. A check that
cries wolf is turned off, and then it protects nothing. This one answers a narrower question
that has almost no false-positive surface: IS THIS NAME BOUND ANYWHERE AT ALL? Both defects
above answer no. If a scope-correct tool is ever added, it belongs beside this, not instead
of it.

`from x import *` makes a file's bindings unknowable, so a file containing one is reported as
SKIPPED, by name, rather than passed quietly.

ALLOWED carries a name per file for the case a name genuinely arrives from outside the file
-- injected into globals(), exec'd in, or supplied by a template engine. Each entry states
why, where a reviewer sees it.

Exit 0 when clean, 1 with the file, line and name of every offender.
"""

import ast
import builtins
import os
import sys

# Names that are legitimately unbound in the file that uses them, one entry per name per
# file, each with the reason. Adding a line here is a decision made in review.
ALLOWED = {
    # ('path/from/repo/root', 'name'): 'why this name is not bound in this file',
}

SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'dist', 'build', '.venv', 'venv'}

# oss/release/ is this generator's OWN OUTPUT: a copy of the emitted tree, rewritten by the
# next cut, which lags the source between cuts BY DESIGN. Scanning it double-counts every
# finding and reports violations already fixed in the file that produces them. The emitted
# tree is checked directly at the point it is emitted, which is where a finding is
# actionable. Same reasoning as check-no-embedded-assets.py and gen.py's PC_REPO_SKIP_TREES.
SKIP_TREES = ('oss/release',)

# Always available at module scope, supplied by the interpreter rather than by the source.
DUNDERS = {'__name__', '__file__', '__doc__', '__package__', '__spec__', '__loader__',
           '__builtins__', '__debug__', '__path__', '__all__', '__dict__', '__class__',
           '__module__', '__qualname__', '__annotations__'}

BUILTIN_NAMES = set(dir(builtins)) | DUNDERS


class Bindings(ast.NodeVisitor):
    """Every name this file binds, anywhere, at any depth. Flat on purpose -- see the
    module docstring for why scope insensitivity is the deliberate trade here."""

    def __init__(self):
        self.bound = set()
        self.star_import = False

    # --- imports ---
    def visit_Import(self, node):
        for a in node.names:
            # `import a.b.c` binds `a`; `import a.b as ab` binds `ab`.
            self.bound.add(a.asname or a.name.split('.')[0])
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        for a in node.names:
            if a.name == '*':
                self.star_import = True
                continue
            self.bound.add(a.asname or a.name)
        self.generic_visit(node)

    # --- definitions ---
    def _func(self, node):
        self.bound.add(node.name)
        self._args(node.args)
        self.generic_visit(node)

    visit_FunctionDef = _func
    visit_AsyncFunctionDef = _func

    def visit_ClassDef(self, node):
        self.bound.add(node.name)
        self.generic_visit(node)

    def visit_Lambda(self, node):
        self._args(node.args)
        self.generic_visit(node)

    def _args(self, args):
        for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
            self.bound.add(a.arg)
        if args.vararg:
            self.bound.add(args.vararg.arg)
        if args.kwarg:
            self.bound.add(args.kwarg.arg)

    # --- declarations ---
    def visit_Global(self, node):
        self.bound.update(node.names)
        self.generic_visit(node)

    def visit_Nonlocal(self, node):
        self.bound.update(node.names)
        self.generic_visit(node)

    # --- targets ---
    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bound.add(node.id)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        if node.name:
            self.bound.add(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name:
            self.bound.add(node.name)
        self.generic_visit(node)

    def visit_MatchStar(self, node):
        if node.name:
            self.bound.add(node.name)
        self.generic_visit(node)

    def visit_MatchMapping(self, node):
        if node.rest:
            self.bound.add(node.rest)
        self.generic_visit(node)


class Loads(ast.NodeVisitor):
    """Every name this file reads, with the line it reads it on. Attribute access is not a
    name load of the attribute -- `os.path` loads `os`, and ast gives exactly that."""

    def __init__(self):
        self.loads = []

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.loads.append((node.id, node.lineno))
        self.generic_visit(node)


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_source(rel, src):
    """Returns (findings, skipped_reason). findings is a list of (rel, line, name)."""
    try:
        tree = ast.parse(src, filename=rel)
    except SyntaxError as e:
        return [(rel, e.lineno or 0, 'SYNTAX: %s' % e.msg)], None

    b = Bindings()
    b.visit(tree)
    if b.star_import:
        return [], 'contains `from ... import *`, so its bindings are not knowable here'

    known = b.bound | BUILTIN_NAMES
    ld = Loads()
    ld.visit(tree)

    seen = set()
    findings = []
    for name, line in ld.loads:
        if name in known:
            continue
        if (rel, name) in ALLOWED:
            continue
        if (name, line) in seen:
            continue
        seen.add((name, line))
        findings.append((rel, line, name))
    return findings, None


def main():
    root = repo_root()
    findings = []
    skipped = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rd = os.path.relpath(dirpath, root).replace(os.sep, '/')
        rd = '' if rd == '.' else rd
        if any(rd == s or rd.startswith(s + '/') for s in SKIP_TREES):
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            if not name.endswith('.py'):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            try:
                with open(path, encoding='utf-8', errors='replace') as fh:
                    src = fh.read()
            except OSError:
                continue
            scanned += 1
            f, skip = check_source(rel, src)
            if skip:
                skipped.append((rel, skip))
            findings.extend(f)

    print('scanned %d Python files' % scanned)
    for rel, why in skipped:
        print('SKIPPED %s -- %s' % (rel, why))
    if ALLOWED:
        print('allowed by exception: %s'
              % ', '.join('%s:%s' % k for k in sorted(ALLOWED)))

    if findings:
        print('', file=sys.stderr)
        for rel, line, name in sorted(findings):
            print('FAIL: %s:%d uses `%s`, which is bound nowhere in that file'
                  % (rel, line, name), file=sys.stderr)
        print('', file=sys.stderr)
        print('This is almost always one of two things, and neither is caught by'
              ' py_compile:', file=sys.stderr)
        print('  a missing import  -- the call was added, the import was not', file=sys.stderr)
        print('  a deleted line    -- an edit removed one line more than it meant to,'
              ' and the', file=sys.stderr)
        print('                       name it bound is still used further down',
              file=sys.stderr)
        print('', file=sys.stderr)
        print('py_compile PARSES a decorator and a function body; it does not EVALUATE'
              ' them. A', file=sys.stderr)
        print('file missing `app = Flask(__name__)` compiles clean and dies at import on'
              ' the first', file=sys.stderr)
        print('@app.route. That is what this check is here to catch before it is deployed.',
              file=sys.stderr)
        print('', file=sys.stderr)
        print('If a name genuinely arrives from outside the file -- injected into globals(),'
              ' exec\'d', file=sys.stderr)
        print('in, supplied by a template -- add (path, name) to ALLOWED with the reason.',
              file=sys.stderr)
        return 1

    print('')
    print('OK: every name used in every Python file is bound somewhere in that file.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
