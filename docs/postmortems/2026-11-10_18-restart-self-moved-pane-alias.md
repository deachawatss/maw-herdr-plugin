# Post-mortem: `restart self` fails after a pane move (#18)

## Summary

After a pane moved to another herdr workspace, `/relaunch` failed, because `maw herdr restart self` could not find the pane. herdr keeps a moved pane's old id as an alias, and `verifyCaller` accepted the alias as the confirmed pane id. The fix makes `verifyCaller` use the pane id that herdr reports. Issue #18, PR #19 (commit `e669d52`), owner Gale.

## Symptom

`/relaunch` in a moved pane (BMW-HUD, env `HERDR_PANE_ID=w1Z:p1`, real pane `wH:p8`):

```
maw herdr: "self" is herdr pane w1Z:p1 in session default, and no running herdr workspace holds it
  see what does: maw herdr ls --agents
```

The Trading pane (env `wV:p2`, real pane `wH:p7`) failed in the same way.

## Root cause

herdr sets `HERDR_PANE_ID` when the pane's process starts and never updates it. `herdr pane move` gives the pane a new id. herdr still answers for the old id: `herdr pane process-info --pane w1Z:p1` returns the process info of the moved pane, with `"pane_id":"wH:p8"`.

`verifyCaller` (`src/cli/mod.verifyCaller.mjs`) first asks `paneProcess(caller.pane)` about the env id. The foreground process group in the answer was ours, so `verifyCaller` returned `{ pane: 'w1Z:p1', confirmed: true }`. `paneProcess` (`src/cli/mod.paneProcess.mjs`) dropped the `pane_id` field, so `verifyCaller` could not see that herdr had answered for a different pane. The scan of the other panes, which finds the real id, did not run.

## Why it produced the symptom

`resolveTarget` (`src/cli/mod.target.mjs`) matches "self" against the panes in the herdr snapshot. The snapshot lists only live ids (`wH:p8`), never aliases. No target held `w1Z:p1`, so `resolveTarget` threw the "no running herdr workspace holds it" error. `relaunch.sh` runs `exec maw herdr restart self`, so the skill failed with that error.

## Fix

`paneProcess` returns `pane: info.pane_id`. When the env id matches our process tree, `verifyCaller` uses the id that herdr reports. If that id differs from the env id, it records the env id as `stale`. The resolve output then says `matched by self — HERDR_PANE_ID w1Z:p1 is stale, this pane moved`.

PR #89 (#88) added `verifyCaller` for moved panes. It handled an old id that herdr no longer knows. It did not handle an old id that herdr still answers for.

## How it was found

- The installed plugin matched the source, so a stale build was rejected as the cause.
- The process tree of the BMW-HUD Claude (pid 87678 → shell 3149998 → herdr) was correct, so a broken ancestry check was rejected.
- A probe ran `verifyCaller` with `ancestry(87678)` and the env id `w1Z:p1`. It returned `confirmed: true` with the stale id. This was the red signal.
- `herdr pane process-info --pane w1Z:p1` returned `"pane_id":"wH:p8"`, and `--pane wV:p2` returned `wH:p7`. This confirmed the alias.
- Live repro: a scratch shell pane moved from workspace `w2R` to `w2S` (`w2R:p1` → `w2S:p2`). In that pane, the installed build gave the user's exact error.

## Why it slipped through

The test fakes did not match real herdr. In `utils/smoke-join-break-layout.mjs`, the `info` fake and the fake `herdr pane process-info` both throw `pane_not_found` for an unknown id. So the #88 checks covered only an old id that herdr forgets. Real herdr answers for the old id, and no check covered that case.

## Validation

- Live, on wind-wsl: in the moved scratch pane, the installed build exited 1 with the symptom error. The fix branch exited 0 with `matched by self — HERDR_PANE_ID w2R:p1 is stale, this pane moved`.
- The installed build after the merge resolves BMW-HUD's `w1Z:p1` to `wH:p8` (probe with `ancestry(87678)`).
- Wind ran `/relaunch` in the moved pane after the install, and it worked.
- `utils/smoke-join-break-layout.mjs` exit 0 (87 checks), `utils/smoke-target-grammar.mjs` exit 0 (247 assertions), `utils/smoke-lifecycle.mjs` exit 0 (241 checks), `just serve bun-check` exit 0.
- Installed on wind-wsl (`just local install`) and on wind-mac (`just remote up wind-mac`, smoke rc=0). The Mac got the smoke only, not a live pane-move test.

## Enforced by

`utils/smoke-join-break-layout.mjs`, check "herdr answers the moved pane's old id as an alias". Its `info` fake returns the process info of `w1:p1` with `pane: 'w1:p1'` when it is asked about `w9:p9`. On the code before `e669d52` the smoke failed with `ERR_ASSERTION` (exit 1). On `e669d52` it passes. The check covers the `verifyCaller` seam. The fake `herdr` binary in the same file still returns `pane_not_found` for an old id, so the integrated `resolve self` path has no alias check.

## Action items

None — the fix is sufficient and no class-of-bug follow-up is warranted.
