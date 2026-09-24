/**
 * Subsequence match shared by every fuzzy filter in the app (quick-open's
 * file picker, the command palette): every character of `query` must occur
 * in `candidate` in order, not necessarily contiguously. Lower is a better
 * match; `null` means no match at all.
 */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query === '') {
    return 0;
  }
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at === -1) {
      return null;
    }
    // Adjacent characters, and matches right after a path separator or word
    // boundary, are what the user was actually aiming at.
    if (at === previous + 1) {
      score -= 2;
    }
    if (at === 0 || haystack[at - 1] === '/' || haystack[at - 1] === '.' || haystack[at - 1] === ' ') {
      score -= 3;
    }
    score += at - from;
    previous = at;
    from = at + 1;
  }
  return score;
}
