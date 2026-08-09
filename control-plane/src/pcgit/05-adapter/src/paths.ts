/**
 * Path normalisation.
 *
 * 02-fs-interface.md §2.1 / §5.4: isomorphic-git builds paths by naive string
 * concatenation -- `${dir}/${entry._fullpath}` (GitWalkerFs.js:78) -- and the
 * workdir walker's root `_fullpath` is the literal string `'.'`. So this
 * adapter WILL receive `/repo/.`, and will receive `//` out of `join()` edge
 * cases. An adapter that did not collapse these crashed `git.statusMatrix`
 * with `ENOENT ... lstat '.'` in the prior agent's experiment.
 *
 * Every public method normalises on entry. This module is the only place that
 * knows how.
 */

/**
 * Reduce `.`, `..` and repeated slashes; always return an absolute POSIX path
 * with no trailing slash (except the root, which is exactly `/`).
 *
 * JUDGEMENT CALL (not covered by the spec): a *relative* input is resolved
 * against the root rather than rejected. §2.1 states paths are absolute, yet
 * the observed failure was on the bare string `'.'`, so relative inputs
 * demonstrably occur. Rooting them keeps `lstat('.')` answering "the root
 * directory" instead of throwing, which is the benign reading.
 */
export function normalizePath(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(
      `path must be a string, received ${Object.prototype.toString.call(input)}`,
    );
  }
  const out: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop(); // `..` above the root clamps at the root, as POSIX does
      continue;
    }
    out.push(segment);
  }
  return '/' + out.join('/');
}

/** Parent of an already-normalised path. `dirname('/') === '/'`. */
export function dirname(normalized: string): string {
  const i = normalized.lastIndexOf('/');
  if (i <= 0) return '/';
  return normalized.slice(0, i);
}

/** Final segment of an already-normalised path. `basename('/') === ''`. */
export function basename(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function isRoot(normalized: string): boolean {
  return normalized === '/';
}
