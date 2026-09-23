---
name: kobay
description: Verify web app features end to end with kobay (local Playwright test engine). Use after finishing or fixing a user-facing feature in a web app that has a .kobay/ directory, or when the user asks to test, verify or "run kobay". Runs tests, reads the failure bundle, and fixes the product, the test or the environment based on failureKind.
allowed-tools: Bash(kobay *)
license: Apache-2.0
---

# kobay: verify a feature, read the failure, fix the right thing

kobay explores a web app in headless Chromium, generates Playwright tests with an
LLM, runs them locally and classifies each failure. Your job: run the relevant
tests after a feature change, read the result, fix the right side (product, test
or environment), and report.

Use this skill when a user-facing web feature was just built or fixed, or the
user asks you to test or verify with kobay. Do not run it for changes to docs,
config or tests only; wait until product code has changed.

## Tools: MCP first, CLI second

If `mcp__kobay__*` tools are available, use them. Otherwise use the `kobay` CLI
(or `npx kobay` if `kobay` is not on PATH).

| Step | MCP tool | CLI |
| --- | --- | --- |
| Project status | `project_get` | `kobay project get --output json` |
| Create project | `project_create` | `kobay project create --url <URL> --output json` |
| Environment check | `doctor` | `kobay doctor --output json` |
| Explore the app | `explore` | `kobay explore --output json` |
| Propose tests | `plan_generate` | `kobay test plan generate --output json` |
| Accept proposals | `plan_accept` (`ids`) | `kobay test plan accept --ids <P1,P2> --output json` |
| Test from a plan file | `test_create` (`planPath`) | `kobay test create --plan <FILE> --output json` |
| List tests | `test_list` | `kobay test list --output json` |
| Run tests | `test_run` (`ids` or `all: true`) | `kobay test run <ID...> --output json` / `kobay test run --all --output json` |
| Re-run existing code | `test_rerun` | `kobay test rerun <ID> --output json` |
| Adapt to a changed UI | `test_refresh` | `kobay test refresh <ID> --output json` |
| Last result | `test_result` | `kobay test result <ID> --output json` |
| Failure bundle | `failure_get` (`id`, `out`) | `kobay test failure get <ID> --out <DIR> --output json` |
| Generated code | `code_get` | `kobay test code get <ID> --output json` |
| Delete a test | `test_delete` | `kobay test delete <ID> --output json` |

Rules for reading results:

- CLI: always pass `--output json`. The output is one envelope:
  `{"ok": bool, "exitCode": n, "data": ...}` or, on errors,
  `{"ok": false, "exitCode": n, "error": {"code": ..., "message": ...}}`.
  Decide from `ok` and `exitCode` in the JSON. Do not pipe kobay into another
  command and read `$?`; that is the last command's exit code, not kobay's.
- MCP: the tool result text is the `data` part as JSON; `isError: true` means a
  non-zero exit (a failed test counts).
- Exit codes: `0` passed, `1` a test failed, `2` usage error, `3` target app
  unreachable, `4` brain or engine error, `5` login or permission problem.
- `test run` returns one row per test: `id`, `name`, `verdict`, `runId`, and
  `failureKind` when it failed or `error` when it could not run.
- MCP tools accept `projectDir`. It must be inside the directory the server was
  started in (or a root listed in `KOBAY_MCP_ROOTS`). Omit it when the server runs
  in the project.

## Workflow

1. **Check the project.** `project_get`. If there is no `.kobay` project, ask the
   user for the app's local URL, then `project_create`. If the app needs a login,
   the password must come from the environment; never ask for it in chat and
   never put it in a command line. For the CLI that is `KOBAY_LOGIN_USER` and
   `KOBAY_LOGIN_PASS` (without them and without a terminal, `--login` exits
   `2`). For MCP, pass `loginUser`; the user must start the agent with both
   `KOBAY_LOGIN_PASS` and `KOBAY_LOGIN_ORIGIN` (for example
   `http://localhost:3000`) exported, and the project URL must be on that
   origin, or the call fails. The login URL must be on the same origin as the
   base URL (exit code `2` otherwise). If exploring stops because the login page
   or form points to another origin, or `explore`/`test_refresh` exits `5`
   because the saved login belongs to another origin, report it to the user and
   ask them to run `kobay project create --url <URL> --login --force` in a
   terminal; do not work around it.

2. **Make sure the app is up.** Run `doctor` and check the row with
   `"name": "target"`: it must have `"ok": true`. `doctor` itself exits `0`
   even when a check fails, so read the rows. `hint` only appears on rows with
   `ok: false`. If the target is down, start the dev server (or ask the user
   how) and wait until the base URL answers.

3. **Get tests for the feature.**
   - Existing tests: `test_list`; pick the ones that cover the changed pages.
   - New feature with no tests: `explore`, then `plan_generate` (use `hint` to
     name the feature), then `plan_accept` with only the few proposal IDs that
     cover the change. Every accepted test costs LLM calls when it first runs;
     do not accept everything by default.

4. **Run.** `test_run` with those IDs, or `all: true` for the whole suite. Use
   `kobay test run --all` rather than a shell loop over IDs.

5. **On a failure**, fetch the bundle. Leave `out` / `--out` off and it lands in
   `.kobay/failure-out/<ID>/`; the next call refreshes that same folder in place,
   so read it right after fetching. That folder is git-ignored, and bundles
   contain session cookies. A folder you name yourself must not exist yet, and
   both MCP `failure_get` and the CLI reject paths under `.kobay/` (other than
   `failure-out/`) or with a dot component; over MCP `out` must also stay inside
   the project root. If you copy a bundle outside `.kobay/`, tell the user to
   git-ignore it. Read
   `failure.json`: `failure.failureKind`, `failure.rootCauseHypothesis`,
   `failure.recommendedFixTarget` (`kind`, `reference`, `rationale`) and
   `failure.evidence`. The same folder always has `code.ts`, `steps.json` and
   `meta.json`, plus the failing step's `.png` and `.html` when the run captured
   them; `console.json` and `network.json` are there only when the analysis
   cited them as evidence.

6. **Act on `failureKind`:**

   | `failureKind` | Action |
   | --- | --- |
   | `product_bug` | Fix the app code. If `recommendedFixTarget.kind` is `code`, search the source for the `reference` / the received value. Then `test_rerun`. |
   | `product_changed` | The UI changed on purpose and the map is stale. Do not touch product code. Run `test_refresh` (same test ID; re-explores that page, adapts the plan steps, regenerates code and runs). The new plan should keep the same number of steps; if it does not, read the evidence before trusting it. |
   | `test_bug` | The test code or selector is wrong. Read it with `code_get`, fix `.kobay/tests/<ID>.spec.ts`, then `test_rerun`. Do not weaken or delete assertions. |
   | `env` | Target, dependency or access is down. Bring the environment up (or tell the user), then `test_rerun`. |
   | `flaky`, `unknown` | Read the evidence and find the cause before changing anything. Say what you checked. |

   A run where Playwright produced no report or executed zero tests is
   `verdict: inconclusive` with `failureKind: env`, never `passed`.

   `verdict: blocked` means the app was unreachable: go back to step 2.
   `verdict: inconclusive` with exit code `4` is a brain or engine error: read
   `error`, do not guess a product fix.

7. **Before blaming the product, check your own changes.** If the failure comes
   from an uncommitted change in the working tree (`git status`, `git diff`) that
   may be intentional, for example a renamed button, ask the user whether it was
   deliberate. Deliberate → `test_refresh`. Accidental → fix the product.

8. **Re-run after a product fix only when the app is serving the new code.**
   After editing product code, wait for the dev server to rebuild or restart and
   answer at the base URL, then `test_rerun`. A run against a half-reloaded
   server gives a false `env` or `product_bug`.

9. **Stop at a cost limit.** If kobay reports that a budget, call or cost
   limit was hit, stop and ask the user. Do not change `KOBAY_MAX_*` variables or
   the `brain` limits in `.kobay/config.json` yourself. A raised limit only takes
   effect after kobay (or the MCP server) restarts.

10. **Stop and report.** If the same test still fails after two fix attempts,
   stop and report to the user with the failure bundle path. Always end with: which
   tests ran, their verdicts, what you changed, and what is still unverified.

## Never

- Read, print or copy `.kobay/credentials.json`, `.kobay/storageState.json` or
  `trace.zip` contents into chat, logs or commits. They contain the password and
  session cookies. Do not attach failure bundles to issues or PRs.
- Edit files under `.kobay/` other than `.kobay/tests/<ID>.spec.ts` for a
  `test_bug`.
- Make a test pass by deleting or loosening assertions, skipping steps or adding
  blind waits.
- Change product code or selectors without reading the failure evidence first.
- Point kobay at a production URL or real customer data. Generated tests submit
  forms and create or delete records.
- Put secrets in commands, prompts, hints or reports.
