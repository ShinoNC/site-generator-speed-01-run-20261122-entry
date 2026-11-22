[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ShinoNC/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ShinoNC/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed

A faster drop-in for makefun-site 1.0.0: `run(input)` returns exactly what
makefun-site's `build` returns, for every input, in less CPU time. About
3.5x faster than the baseline on the practice set (trimmed mean over 9 runs,
3 cases, ~1,070 markdown files).

What makes it faster, with behaviour identical to the reference throughout:

- HTML escaping: one test plus one regex replace (measured 2-14x faster than
  a manual scan with string concatenation).
- Markdown: blocks render straight to HTML (no token objects), the inline
  renderer finds the next special character with one regex and copies plain
  runs in bulk, and plain text skips the inline pass entirely.
- Front matter: the closing `---` is found with `indexOf` and the body sliced
  out — no split of the whole file and no re-join.
- Slugs: memoized; pure-ASCII inputs skip NFKD entirely.
- Templates: the same node-tree dialect, rendered through a scope chain so the
  shared site/tags/recent values are never spread per page; one scope object
  is reused across loop iterations.
- V8's incremental marking is off (`--no-incremental-marking`, set in
  `main.ts` before `solve.js` is imported), which the rules allow.

Correctness: byte-identical output to the reference on the 3 practice cases,
15 generated cases (the kit's own generator, 5 seeds x 3 indices), and 70
hand-written edge cases covering front-matter refusal reasons, slug
collisions, link resolution, template errors, list/fence/heading corners,
and pagination.

Files: `main.ts` (the driver: reads `/input/cases.json`, writes
`/output/answers.json`) and `solve.js` (the generator, one dependency-free
ES module).
