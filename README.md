# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JackEasons/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JackEasons/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls to one specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. Node 22 standard library only — nothing is installed.

## Run it

```sh
node main.ts patch.diff
```

Reads the patch from `patch.diff` (or standard input when no file is given), applies it to the tree, and prints what changed. `node main.ts --check patch.diff` previews the same result without writing anything. `--format=unified|search-replace|v4a|json` forces one format; `--strict` matches lines exactly.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gbg9q3ye&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
