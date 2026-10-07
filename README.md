# kobay

[Türkçe](README.tr.md) · [CHANGELOG](CHANGELOG.md) · Apache-2.0

**kobay is a local end-to-end test engine for coding agents.** Point it at a web
app running on your machine. It explores the app in a headless Chromium, asks an
LLM to propose user flows, turns the ones you accept into Playwright tests, runs
them, and — when one fails — hands back an evidence bundle your agent can act
on: a root-cause hypothesis, a `failureKind` classification, a recommended fix
target, the failing step's screenshot and DOM, and a Playwright trace.

The last part is the point. A test that only says "failed" makes an agent guess;
a bundle that says `product_changed` instead of `product_bug` stops the agent
from "fixing" an app that was never broken.

No kobay account, no cloud service, no tunnel — the browser, the app and the test
runs stay on your machine. The LLM (kobay calls it the **brain**) is your own
`claude` CLI by default, so kobay holds no API key of its own. Some data does
leave your machine to reach it; see [Cost and data](#cost-and-data).

**Only point kobay at a local or test environment you trust.** Generated tests
click buttons, submit forms and create records.

[Status](#status) · [Requirements](#requirements) · [Install](#install) ·
[Quick start](#quick-start) · [From your coding agent](#use-it-from-your-coding-agent) · [CI](#ci-github-actions) ·
[How it works](#how-it-works) · [Commands](#commands) · [Output and failures](#output-and-failures) ·
[Cost and data](#cost-and-data) · [`.kobay/`](#the-kobay-directory) · [Security](#security-model) ·
[Limitations](#known-limitations) · [Roadmap](#roadmap) · [Development](#development)

## Status

**0.2.1.** Usable, not yet smooth. What has and has not been
exercised, so you can decide before installing:

| | |
| --- | --- |
| **Who it's for** | Developers running Claude Code (or Codex / Cursor) who want the agent to verify a local web app instead of claiming it works. |
| **Verified end to end** | The `claude` CLI brain, driven by a Claude Code agent over MCP: the agent found a product bug, traced the root cause, fixed it and re-ran the test green. On 0.2 the same loop was re-run against the bundled demo app with the real brain — 14 proposals, 3 of 3 accepted tests passing, a deliberate product break classified `product_bug`, $0.28 for the round. |
| **Tried once with the real CLI** | The `codex` brain. On 28 September 2026 one round against the bundled demo app with a real `codex exec` (Codex CLI 0.154.0, ChatGPT plan) produced a plan, generated test code and analysed a failure; every brain call matched the schema on the first try. One round, not long use. |
| **Untested in practice** | The `openrouter` brain. The adapter has unit tests but has never been run against the real API. Treat it as unverified. |
| **Platform** | Developed on macOS. Since 0.2.1, CI verifies the full suite on ubuntu-latest, macos-latest and windows-latest with Node 22 and 24; the Windows matrix has 415 passing tests. The packaging smoke test runs on macOS and Linux. |
| **Language** | Everything a machine reads is English: CLI and MCP messages, JSON field names, error codes, file names, prompts. The brain writes test names and descriptions in the language of the app it explored, so a non-English app gets non-English test titles — by design. |
| **Scope** | Browser tests only. No API tests, no backend tests, no dashboard. |

**0.2.0 was a breaking release.** Every JSON field name, error code and `.kobay`
file name changed from Turkish to English; the full rename table is in
[CHANGELOG.md](CHANGELOG.md). A 0.1 project migrates itself on the first 0.2
command, but the installed agent skill does not: **run `kobay agent install`
again in each project** so your agent learns the new names. 0.1 cannot read a
0.2 project afterwards.

If you want a hosted product with a dashboard and a support contract, kobay is
not it — look at [TestSprite](https://www.testsprite.com/), which runs a similar
explore → plan → generate → run → analyse loop as a service. kobay is the local,
narrower, bring-your-own-LLM version of that idea.

## Requirements

- **Node.js 22.12 or newer**; macOS, Linux or Windows (since 0.2.1).
- **Chromium**, installed with `kobay install-browser`.
- **A brain:** the `claude` CLI, logged in (default, and the only tested path);
  or the `codex` CLI; or an `OPENROUTER_API_KEY` environment variable.
- **The app you want to test**, running at a URL kobay can reach.

## Install

```sh
npm install -g @ademtfkc/kobay
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

For a one-off command without installing, `npx @ademtfkc/kobay <command>` works
too — `npx @ademtfkc/kobay doctor`, say — but it re-fetches the package each
time, so a global install is worth it if you'll run kobay more than once.

If you installed the old unscoped `kobay` package globally, run `npm uninstall -g kobay` first; otherwise the install fails with `EEXIST`.

**From source**, for development or to run an unreleased change:

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay
npm install && npm run build
npm link                     # puts `kobay` on your PATH
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

Installing straight from git (`npm i -g github:ademtfkc/kobay`) needs a build
step it doesn't get and fails on npm 11.19 (`tsc: command not found`) — use the
published package or a local clone instead.

`install-browser` downloads the Chromium build matching kobay's own Playwright
version — use it rather than `npx playwright install`, which may fetch a
different revision. On Linux, `--with-deps` also installs Chromium's system
libraries through your package manager and may ask for `sudo`.

### Windows (since 0.2.1)

Native Windows is supported. In either PowerShell or `cmd.exe`, install kobay
and its matching Chromium the same way:

```powershell
npm install -g @ademtfkc/kobay
kobay install-browser
kobay doctor
```

CI verifies this path on `windows-latest` with Node 22 and 24 (415 passing
tests). It covers PATH/PATHEXT command resolution, `.cmd` shims, relative
Playwright specs and process-tree termination. We have not yet verified on a
physical Windows machine: orphan-process cleanup, rename-on-open-file `EPERM`,
8.3 and UNC paths, and the `claude` CLI's Git Bash requirement still need that
coverage. Please report Windows issues. Besides the test matrix, the CI also
runs a smoke job on `windows-latest` (pack, install, `install-browser`, demo
`explore`).

`doctor` checks Node, the brain CLIs, Chromium, the current project and whether
the target answers. It always exits `0`, so read the rows. Before a project
exists the last two fail, as expected:

```
✓ Node 26.8.1
✓ claude CLI
✓ codex CLI
✓ Chromium
✗ .kobay — create a project with `kobay project create --url <URL>`
✗ target — no project; run `kobay project create --url <URL>` first
```

To change the default brain (written to `~/.kobay/config.json`):

```sh
kobay setup --brain claude
#> Default brain set: claude
#> Config file: ~/.kobay/config.json
#> Chromium: installed
#> Next: kobay project create --url <URL>
```

`--brain codex` and `--brain openrouter` are accepted too. The Codex brain runs
`codex exec --ignore-user-config --ephemeral` in a read-only sandbox, so your
`~/.codex/config.toml` is ignored. If you give no model, the Codex CLI runs its
own built-in default; to choose one, set model and effort with `--model` /
`--effort` or in the `brain` block (`model`, `effort`) of the project or global
kobay config. Codex login still comes from `CODEX_HOME`.

## Quick start

kobay ships a small demo app — login page, dashboard, record list, new-record
form — so you can watch the whole loop before pointing it at your own project.
The samples below are copied from a real run against it.

**1. Start the demo** in its own terminal and leave it running:

```sh
kobay demo --port 3999
#> Kobay demo: http://127.0.0.1:3999
#> Login: demo / demo123
#> Press Ctrl+C to stop
```

**2. Create a project** in an empty directory. `--login` reads
`KOBAY_LOGIN_USER` and `KOBAY_LOGIN_PASS`; without them it prompts (the password
is not echoed), and with no terminal and no variables it exits `2` — piping
answers into stdin is not supported. The login URL must share `--url`'s origin.

```sh
mkdir kobay-demo && cd kobay-demo
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/login
#> Project created: ~/kobay-demo/.kobay
#> Target: http://127.0.0.1:3999
#> Brain: claude
#> Login page: http://127.0.0.1:3999/login
#> Credentials: saved
#> Next: kobay explore
```

**3. Explore** — no LLM call. kobay logs in and follows same-origin `<a href>`
links up to 40 pages, skipping links whose text looks like logout or delete, and
never submitting forms. The result is the *map*, `.kobay/map.json`.

```sh
kobay explore
#> 4 pages explored (logged in)
#> Map: ~/kobay-demo/.kobay/map.json
#> Pages: /login, /, /records, /new
#> Next: kobay test plan generate
```

**4. Generate a plan** — **LLM call.** The brain reads the map (plus a product
document if you passed `--docs`) and proposes 8–25 flows; proposals pointing at
URLs outside the map are dropped. When a login is configured, proposals with a step
that enters the real credentials (password, secret, PIN) are dropped too, listed
under `dropped` with the step; steps that enter invalid or empty values are fine.
Each proposal also states `requiresRealCredentials`; `true` drops it, and the
step filter still drops real-credential steps when the flag says `false`.
Generated code may not silently `test.skip`, and a step that would need the real
credentials throws instead of being rewritten. The text output is the
summary line plus the same JSON body `--output json` returns:

```sh
kobay test plan generate
#> 10 proposals generated
#> {
#>   "proposals": [
#>     { "id": "p_xtj1ab", "priority": "p1", "title": "Login with invalid credentials shows an error", "stepCount": 3 },
#>     { "id": "p_q3w8wt", "priority": "p0", "title": "Record list shows saved records", "stepCount": 2 },
#>     { "id": "p_gonrog", "priority": "p1", "title": "New record form saves a record",  "stepCount": 2 },
#>     … six more …
#>   ],
#>   "dropped": []
#> }
```

Accept a few — not everything, since each test costs LLM calls the first time it
runs.

```sh
kobay test plan accept --ids p_q3w8wt,p_gonrog
#> 2 proposals accepted
#> t_6a12wnx1  Record list shows saved records  frontend  plan  draft  2 steps  p0  /records  0  …
#> t_v1h8tqsy  New record form saves a record   frontend  plan  draft  2 steps  p1  /new      0  …

kobay test list
#> t_6a12wnx1	draft	p0	Record list shows saved records
#> t_v1h8tqsy	draft	p1	New record form saves a record
```

**5. Add a test of your own** (optional). `test create --plan` takes a
hand-written plan file (the format is under [Commands](#commands)), so you can
ask for a flow the brain did not propose — here, a monthly total that the demo
app does not have:

```sh
kobay test create --plan monthly-total.plan.json
#> Test created: t_sknz9qok
#> Name: Record list shows a monthly total
#> Steps: 2, priority: p0, status: draft
#> Next: kobay test run t_sknz9qok
```

**6. Run.** A test with no code gets Playwright code generated first (LLM call),
then runs; a failing test is then analysed (another LLM call). 120 s per test.

```sh
kobay test run --all
#> passed t_6a12wnx1
#> failed t_sknz9qok — product_bug
#>   failure bundle: kobay test failure get t_sknz9qok
#> passed t_v1h8tqsy
```

Exit code `1`: one test failed. `test list` now shows the verdicts:

```sh
kobay test list
#> t_6a12wnx1	passed	p0	Record list shows saved records
#> t_sknz9qok	failed	p0	Record list shows a monthly total
#> t_v1h8tqsy	passed	p1	New record form saves a record
```

**7. Read the failure.** Without `--out` the bundle lands in
`.kobay/failure-out/<id>/`, refreshed in place on every call so nothing survives
from the previous one. A folder you name yourself must not exist yet.

```sh
kobay test failure get t_sknz9qok
#> Failure bundle copied: ~/kobay-demo/.kobay/failure-out/t_sknz9qok

ls ~/kobay-demo/.kobay/failure-out/t_sknz9qok
#> code.ts  failure.json  meta.json  step-1.html  step-1.png  steps.json  trace.zip
```

`failure.json` carries the analysis, the full run result, the step list and the
generated code. The part an agent acts on is `failure`:

```json
"failure": {
  "failureKind": "product_bug",
  "rootCauseHypothesis": "The record list renders only the record rows; the table has no footer summing the Amount column, so the 'Monthly total' row the test waits for is never rendered.",
  "recommendedFixTarget": {
    "kind": "code",
    "reference": "/records table",
    "rationale": "The records table ends after the last record row; no total is computed or rendered. To find the source file, search the product code for the \"Received\" value or text from the error message."
  },
  "evidence": [
    { "kind": "snapshot",   "stepIndex": 1, "summary": "The table body ends after the last record row; there is no tfoot and no cell containing 'Monthly total'.", "path": "step-1.html" },
    { "kind": "screenshot", "stepIndex": 1, "summary": "The record list is visible with three rows and no total line.", "path": "step-1.png" }
  ]
}
```

Each evidence entry points at a file in the same folder (`step-<step>.png` for
the screenshot, `step-<step>.html` for the DOM). `console.json` and
`network.json` join the bundle only when the analysis cites them. Open the trace
with `npx playwright show-trace trace.zip`.

**8. Fix the app, then `kobay test rerun t_sknz9qok`** — runs the existing code
again without regenerating it. Stop the demo with Ctrl+C when you are done.

## Use it from your coding agent

Two pieces, both installed into your app's project root: an **MCP server** that
gives the agent kobay's tools, and a **skill file** that tells it when and how to
use them.

```sh
kobay agent install --target claude
#> Skill created: ~/my-app/.claude/skills/kobay/SKILL.md
#> MCP registered in .mcp.json (kobay → `kobay mcp`): ~/my-app/.mcp.json
```

`.mcp.json` is a project-scoped MCP config, so the first `claude` session in
that directory shows the server as **pending approval** and asks you once to
approve it. For other agents kobay writes the skill and you register the server
yourself:

```sh
kobay agent install --target codex
#> Skill created: ~/my-app/AGENTS.md
#> MCP registration: `codex mcp add kobay -- kobay mcp`

kobay agent install --target cursor
#> Skill created: ~/my-app/.cursor/rules/kobay.mdc
#> MCP registration: add `{ "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }` to `.cursor/mcp.json`
```

The Codex target replaces only the block between `<!-- kobay:BEGIN -->` and
`<!-- kobay:END -->` and keeps the rest of `AGENTS.md`. All three write into the
current project, never your home directory. To register the Claude Code server
by hand: `claude mcp add -s project kobay -- kobay mcp`.

### Paste this into your coding agent

```text
Use kobay to verify this local web app end to end. First ensure kobay is
available (install it if needed), run `kobay install-browser`, and start or
identify the app's local URL. Create or inspect the Kobay project, then run the
app health check. For the feature I changed, find existing tests or explore the
app, generate a small focused plan, accept only the relevant proposals, and run
the tests. If a test fails, fetch and read its failure bundle. For
`product_bug`, fix the product code; for `product_changed`, refresh the test;
for `test_bug`, inspect the generated code before fixing the test. Re-run the
same test after each fix. Prefer the Kobay MCP tools when available; otherwise
use the CLI with `--output json`. In CLI JSON, decide from `ok` and `exitCode`,
not the shell exit status of a piped command. Do not expose credentials, cookies
or traces. Stop after two unsuccessful fix attempts and report the tests run,
their verdicts, changes made, and anything still unverified.
```

### MCP-first call sequence

Source: [`src/mcp/index.ts`](src/mcp/index.ts) and
[`beceri/SKILL.md`](beceri/SKILL.md). All tools below accept optional
`projectDir`; omit it when the server starts in the project.

1. Call `project_get` → project configuration and status. If there is no
   project, call `project_create` with required `url` and optional `docs`,
   `loginUser`, `loginUrl`, and `force` → creates `.kobay/`.
2. Call `doctor` → installation, target, and environment checks. Continue only
   when the target row is `ok: true`; `doctor` itself can exit successfully when
   a row fails.
3. Call `test_list` → saved test records. For a new feature, call `explore` →
   refreshed page map; then `plan_generate` with optional `hint` → proposals;
   then `plan_accept` with `ids: string[]` (or `all: true`) → draft tests.
4. Call `test_run` with `ids: string[]` or `all: true` (optional `rerun`) → one
   result per test, including `verdict`, `runId`, and `failureKind` when it
   fails.
5. For a failed test, call `failure_get` with `id` (optional `out`) → the
   evidence bundle. Read its `failureKind`: after a product fix call
   `test_rerun` with `id`; for `product_changed` call `test_refresh` with `id`
   (optional `run`); for a test problem call `code_get` with `id` before editing
   the generated code.
6. When the loop is done, call `prune` (optional `confirm`, `dryRun`, `maxMb`,
   `olderThanDays`) → previews old runs, brain logs and leftovers by default;
   review the result, then pass `confirm: true` to delete. `dryRun: true` always
   forces a preview.

**CLI when MCP is unavailable.** Use the matching commands with `--output json`:
`kobay project get`, `kobay doctor`, `kobay test list`, `kobay explore`,
`kobay test plan generate`, `kobay test plan accept --ids <P1,P2>`,
`kobay test run <ID...>`, `kobay test failure get <ID>`, and
`kobay test rerun <ID>`; clean up with `kobay prune --dry-run` and then
`kobay prune`. Every CLI response is one JSON envelope. Decide from
its `ok` and `exitCode` fields; do not pipe kobay into another command and read
`$?`, which is the last command's status rather than kobay's.

**The MCP server** (`kobay mcp`, stdio) exposes these tools:

```
project_create  project_update  project_get  explore       plan_generate
plan_accept     test_create     test_list    test_get      code_get
test_delete     test_run        test_rerun   test_refresh  test_result
failure_get     doctor          prune
```

Every tool takes an optional `projectDir`, which must be inside the directory
the server was started in. To allow more, list them in the server process's
`KOBAY_MCP_ROOTS`, separated by the platform path separator (`:` on macOS and
Linux); every listed path must exist or the server refuses to start, and tool
arguments cannot widen this.

**Login over MCP.** `project_create` takes the login user as `loginUser`; the
password and the origin it may be sent to come only from the server's
environment, never from tool arguments. Export `KOBAY_LOGIN_ORIGIN` (e.g.
`http://localhost:3000`) and `KOBAY_LOGIN_PASS` in the shell that starts the
agent — the call fails if either is missing or the project `url` is not on that
origin. A login saved for another origin cannot be moved over MCP; run
`kobay project create --url <URL> --login --force` in a terminal. Keep these
variables out of `.mcp.json`, which is usually committed.

## CI (GitHub Actions)

kobay can run the tests you generated locally and committed in `.kobay/` on
every pull request. CI has no brain: tests run with
`kobay test run --no-analysis`, which never calls an LLM, so no API key or brain
CLI is needed. The action then posts the result in three places:

- the **job summary** of the workflow run,
- one **pull request comment** with a counts table, one row per test and a
  copy-ready **Fix with your coding agent** prompt for each failed, blocked or
  inconclusive test (masked text only, no screenshots), updated in place on every
  push,
- the **`kobay-report` artifact**: the HTML report from `.kobay/report`.

Generate and run the tests locally first (`kobay test run` with a brain), then
commit `.kobay/` (the managed `.gitignore` keeps credentials, runs, failure
bundles and the report out of git). Start your app in an earlier step; the
action waits for it.

```yaml
name: kobay
on: pull_request

permissions:
  contents: read
  pull-requests: write   # only for the pull request comment

jobs:
  kobay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Start the app in the background
        run: npm run dev > app.log 2>&1 &
      - uses: ademtfkc/kobay@v0.3.0
        with:
          wait-for-url: http://localhost:3000
```

| Input | Default | Meaning |
| --- | --- | --- |
| `version` | `latest` | `@ademtfkc/kobay` version to install; a path to a local `.tgz` also works. |
| `node-version` | `22` | Node.js for `actions/setup-node`. |
| `working-directory` | `.` | The project root that holds `.kobay/`; passed as `--cwd`. |
| `tests` | empty | Space-separated test IDs; empty runs `--all`. |
| `wait-for-url` | empty | Polled until the app answers with any HTTP status; empty uses the project's `baseUrl`. |
| `wait-timeout` | `120` | Seconds to wait; then the step fails with exit code `3` ("target not reachable"). |
| `install-browser-deps` | `true` | `kobay install-browser --with-deps` (Linux system libraries). |
| `comment` | `true` | On `pull_request` events, create or update one sticky comment. |
| `upload-report` | `true` | Upload `.kobay/report` as the `kobay-report` artifact. |
| `max-prompts` | `5` | Fix prompts in the comment; the rest are counted in one line. |
| `github-token` | `${{ github.token }}` | Used only to read and write the comment. |

Outputs: `exit-code` (of `test run`), `report-dir`, `summary-path`.

**Pass or fail.** The last step of the action exits with the exit code of
`kobay test run`: `0` all passed, `1` a test failed, `3` a test was blocked (the
app was not reachable, or a test has no generated code yet), `4` engine error.
The report and comment are written first, so a red check still has its summary.
With `--no-analysis` a failed test gets failure kind `unknown` and its evidence
bundle is still written; run the test locally with a brain for the root-cause
analysis. A test without generated code, or a draft whose plan changed after its
code was generated, is `blocked` with the hint to run `kobay test run <ID>`
locally and commit `.kobay/`; this blocked run is recorded, so the report counts
it and its prompt says what to do. The action checks its inputs first
(`wait-timeout` 1–3600 seconds, `wait-for-url` and the project's base URL must
be `http(s)://`, test IDs only) and stops with exit code `2` otherwise.

**The summary file.** The comment is the output of
`kobay test report --summary <path> [--max-prompts <n>]`: GitHub-flavored
Markdown that starts with `<!-- kobay-report -->` (the key used to find and
update the comment), stays under 60,000 characters (the fix-all prompt is
dropped first, then single prompts from the end; the table is kept), and holds
text only: each value is secret-masked on its own, credentials in addresses
become `[redacted]`, local paths become `[project]`, `[kobay]` and `~`, other
absolute file paths (under `/opt`, `/usr`, `/tmp`, `C:\` …) become
`[path]/<file name>` (app routes such as `/records/new` stay; app routes that start with a system root name, such as `/opt/x`, are also masked), table cells are escaped, and prompts sit in a
fenced block longer than any backtick run inside them. `--summary` takes the
same path rules as `--out`, and in addition it cannot point into `.kobay/` or
into the report folder; a refused path exits `2`. The HTML report is still
written.

**Apps that need a login.** The action takes no username or password input, and
`.kobay/credentials.json` and the session file are never committed. Without
them, tests run signed out. To sign in, add a step before the action that saves
the login from two repository secrets and explores once (this writes the
session file in the CI checkout only):

```yaml
      - name: Sign kobay in
        run: |
          npx --yes @ademtfkc/kobay project create --force --url http://localhost:3000 --login --login-url http://localhost:3000/login
          npx --yes @ademtfkc/kobay install-browser --with-deps
          npx --yes @ademtfkc/kobay explore
        env:
          KOBAY_LOGIN_USER: ${{ secrets.KOBAY_LOGIN_USER }}
          KOBAY_LOGIN_PASS: ${{ secrets.KOBAY_LOGIN_PASS }}
```

`project create --force` rewrites only the config (the brain settings are kept)
and does not touch tests or runs; `explore` refreshes `map.json` in the
checkout. Verified with the demo app: signed out the test failed, after these
three commands it passed.

**Forks and tokens.** Pull requests from forks get a read-only token: the action
skips the comment with a warning and the job summary still has the report. Do
not switch to `pull_request_target` to get around this: it runs the fork's code
with your repository's secrets. The sticky comment is the one written by
`github-actions[bot]` that starts with the marker; with your own
`github-token` the comment is posted under that account and a new one is added
on every run.

**Artifact warning.** The HTML report contains unmasked screenshots; in a
public repository workflow artifacts are visible to anyone who is signed in to
GitHub. Set `upload-report: false` if that matters.

## How it works

```
explore ──> map (.kobay/map.json)
              │
plan generate ─┴─> proposals ──accept──> draft tests
                                            │
test run ──> generate Playwright code ──> run ──> passed
                                            │
                                          failed ──> analyse ──> failure bundle
                                                                    │
                   product_bug: fix the app ──> test rerun <────────┤
                   product_changed: test refresh ───────────────────┤
                   test_bug: fix the test code ─────────────────────┘
```

**explore** uses no LLM; it records each page's title, headings, links, forms,
buttons and menus. **plan generate** and **test run** call the brain, and
generated code is checked before it is saved — `page.goto` may only target URLs
in the map, and every `test.step` title must match its plan step exactly.
**test refresh** re-explores just that test's page, updates the map in place,
adapts the plan steps, regenerates the code and runs it under the same test ID;
`--no-run` stops after the plan update.

## Commands

Verified against `kobay --help` and every subcommand's `--help` in 0.2.1;
`test report`, `test run --no-analysis` and `test report --summary` are new and
not in a release yet.

| Command | What it does |
| --- | --- |
| `setup [--brain <b>] [--model <m>] [--effort <e>]` | Writes the default brain to `~/.kobay/config.json` (`claude`, `codex`, `openrouter`). |
| `install-browser [--with-deps]` | Installs the matching Chromium; `--with-deps` adds Linux system libraries. |
| `demo [--port <port>]` | Starts the bundled demo app. Default port 3000; `0` picks a free one. |
| `doctor` | Checks Node, brain CLIs, Chromium, project and target. Always exits `0`. |
| `project create --url <url> [--docs <path>] [--login] [--login-url <url>] [--force] [--brain <b>] [--model <m>] [--effort <e>]` | Creates `.kobay/` here. `--force` rewrites only an existing project's config, keeping its brain and limits unless you pass new ones. |
| `project update [--base-url <url>] [--login-url <url>] [--docs-path <path>] [--brain <b>] [--model <m>] [--effort <e>]` | Changes only the fields you pass. |
| `project get` | Settings, test count, whether a map exists. |
| `explore` | Explores the app and rewrites `.kobay/map.json`. |
| `test plan generate [--hint <text>]` | Proposes tests from the map and docs. `--hint` is free text, e.g. "invoice flow only". |
| `test plan accept [--all] [--ids <id,id>]` | Turns proposals into draft tests. |
| `test create --plan <path>` | Creates a test from a hand-written plan file (below). |
| `test list` | Tests with status and priority. |
| `test get <id>` | One test's record and plan steps. |
| `test code get <id>` | Prints the generated Playwright code. |
| `test delete <id>` | Deletes a test record and its generated code. |
| `test run [ids...] [--all] [--rerun] [--no-analysis]` | Generates missing code, then runs. `--rerun` skips generation. `--no-analysis` (for CI) never calls the brain: it runs existing code only, a test without code (or a draft) is `blocked` (exit `3`), and a failure gets a bundle with failure kind `unknown`. |
| `test rerun <id>` | Runs existing code without regenerating it. |
| `test refresh <id> [--no-run]` | For `product_changed`: re-explore, adapt the plan, regenerate and run. |
| `test result <id> [--history]` | Last run result, or every run still on disk. |
| `test failure get <id> [--out <dir>]` | Copies the failure bundle. Default `.kobay/failure-out/<id>/`, refreshed in place. |
| `test report [ids...] [--all] [--out <dir>] [--summary <path>] [--max-prompts <n>]` | Writes a static HTML report of each selected test's latest run (steps, screenshots, error, failure analysis, generated code). Reads only what is on disk; runs nothing. Default `.kobay/report/`, replaced as a whole each time. Exits `0` even when tests failed. `--summary` also writes a Markdown summary for a pull request comment (text only, at most `--max-prompts` fix prompts, default 5). |
| `prune [--dry-run] [--max-mb <mb>] [--older-than-days <days>]` | Removes old runs, brain logs, stale failure bundles and known leftovers from older versions. Unknown `failure-out/` files are skipped. Never removes the last failed run or a current failure bundle. The CLI deletes by default; `--dry-run` only previews. `--max-mb` caps `runs/` (default 500), and `--older-than-days` sets the age threshold (default 7). |
| `agent install --target <claude\|codex\|cursor>` | Installs the agent skill here; for `claude` also registers the MCP server in `.mcp.json`. |
| `mcp` | Starts the stdio MCP server. |

**HTML report.** `kobay test report --all` writes `.kobay/report/index.html`
from the latest run of every test; open it in a browser. It opens with a summary
(run bar, pass rate, total run time), puts failed, blocked and inconclusive tests
first with their steps, screenshots and failure analysis, and folds passed tests
away. Every test that needs attention carries a **Fix with your coding agent**
prompt to paste into Claude Code, Codex or Cursor: it states the failure kind,
quotes the error and analysis as untrusted data, and lists the kobay commands to
get the evidence, fix and verify (`test failure get`, `test rerun`, or
`test refresh` for `product_changed`). With two or more such tests the report
also has one prompt that covers them all. Each quoted value is secret-masked on
its own before it goes into the prompt, and error output longer than 2,000
characters is cut, with a pointer to the full bundle. Click a prompt to select
it, then copy.
`--output json` returns the same prompts as `fixPrompts` and `fixAllPrompt`. The folder is
self-contained (screenshots are copied in), so you can move it or upload it as a
CI artifact. The page has no scripts and no external resources, and every text
in it is secret-masked and HTML-escaped; the project root, kobay's own
installation (stack frames) and your home directory are shown as `[project]`,
`[kobay]` and `~`. **Screenshots are not redacted:**
they show whatever your app displayed, so review them before sharing the report.
With `--out <dir>` the report goes elsewhere (outside the project is allowed,
dot-prefixed paths are not). A non-empty folder is replaced only if it is
entirely a kobay report: a valid `kobay-report.json`, `index.html`, and nothing
else but `assets/<runId>/step-<n>.png`. A single other entry (`notes.txt`,
`.DS_Store`) makes the command exit `2` and name that entry, touching nothing.
The old report is removed file by file, never with a recursive delete; anything
unexpected is left in place and its path is printed. The report reads
`.kobay/tests`, `runs`, `failure` and `config.json` without following symlinks
or hard links: linked data is left out. A test whose run record cannot be read shows as `inconclusive` with a
note; a test whose run folder is gone shows as `not run`.

`prune --dry-run` prints a summary (example from a real run on a demo project):

```sh
kobay prune --dry-run
#> Prune preview: would remove 7 items and would reclaim 0.05 MB.
#> Run storage after prune: 0.92 MB / 500.00 MB.
```

With `--output json` the same run returns `dryRun`, `estimate`, `policy`,
`deleted`, `wouldDelete` (each with `path`, `kind`, `bytes`, `reason`), `skipped`
(each with `path` and `reason`), `reclaimedBytes` and `wouldReclaimBytes`.
Dry-run figures have `estimate: true`; deletion remeasures run storage. Over MCP
the `prune` tool takes `projectDir`, `confirm`, `dryRun`, `maxMb` and
`olderThanDays`: it previews by default, deletes only with `confirm: true`, and
`dryRun: true` always forces a preview.

Global options: `--cwd <dir>`, `--output json`, `-V/--version`, `-h/--help`.

A hand-written plan file for `test create --plan`
([`schemas/plan.schema.json`](schemas/plan.schema.json)) needs `type` (must be
`frontend`) and `name`, takes an optional `url` (the test's page: a path such as
`/records` or an address on the project's `baseUrl` origin), `description`,
`priority` (`p0`–`p3`, default `p1`) and `projectId` (a free label, not stored),
and 1–200 `planSteps`, each `action` or `assertion` with a `description`:

```json
{ "type": "frontend", "name": "Record list shows a monthly total",
  "url": "/records", "priority": "p0",
  "planSteps": [
    { "type": "action", "description": "Open the record list at /records" },
    { "type": "assertion", "description": "A 'Monthly total' row shows the sum of the record amounts" } ] }
```

A `url` on another origin is rejected with exit `2`. The `url` is resolved
against `baseUrl` and stored in that normalised form. In a project with stored
credentials, a plan whose steps enter the real password or another secret is
rejected with exit `2`; kobay's own login step already signs the test in. Without `url`, failure
analysis skips the map comparison and prints a warning saying so
(`Test has no URL (<id>); map comparison skipped.`).

## Output and failures

**Text output** (the default) is a short human summary — ids, paths, counts and
the next command to run. Do not parse it. Every command also accepts
`--output json` and then prints one envelope:

```
{"ok":true,"exitCode":0,"data":[{"id":"t_6a12wnx1","name":"Record list shows saved records","verdict":"passed","runId":"r_20260923144622_dju9"}]}
{"ok":false,"exitCode":2,"error":{"code":"InvalidId","message":"Invalid testId: t_yok"}}
```

Read `ok` and `exitCode` from the JSON rather than `$?` after a pipe —
`kobay ... | jq` reports `jq`'s exit code, not kobay's.

**Exit codes:** `0` passed · `1` a test failed · `2` usage error · `3` target
unreachable · `4` brain or engine error · `5` login or permission problem. With
several tests, `test run` exits with the highest code. Exit `5` also covers a
login that kobay refused because the page tried to send the credentials to
another origin.

**Error codes** (`error.code`): `UsageError`, `PermissionError`,
`TargetUnreachableError`, `InvalidId`, `FileNotFound`, `SchemaError`,
`BundleIncomplete`, `UnsafeOutputPath`, `CredentialsTxnCorrupt`,
`CredentialsTxnInProgress`, `CredentialsRollbackFailed`, `McpRegistryUnreadable`,
`BrainError`, `BrainRuntimeError`, `CredentialOriginError`,
`FixtureModuleMissing`, `InputClosedError`, `UnknownError`. A `BrainError`
carries the reason in its message: `timeout`, `cli_missing`, `schema`,
`empty_response`, `network`, `key_missing`, `cli_error`, `call_cap`, `cost_cap`,
`cost_unknown`, `config_error`.

**Verdicts:** `passed` · `failed` (a step did not find what it expected; a bundle
exists) · `blocked` (the app was unreachable) · `inconclusive` (no code yet, or a
brain or engine error). If Playwright cannot run the test at all — a report
error, or zero tests executed — the result is `inconclusive` with
`failureKind: env` and exit code `4`. Never `passed`.

**Failure kinds**, on a failed test's bundle:

| `failureKind` | Meaning | What to do |
| --- | --- | --- |
| `product_bug` | The app is broken. | Fix the app, then `kobay test rerun <id>`. |
| `product_changed` | The app changed on purpose; the map is stale. | Leave the app alone: `kobay test refresh <id>`. |
| `test_bug` | The test code or a selector is wrong. | `kobay test code get <id>`, fix the test. |
| `env` | Target, dependency or access is down. | Bring the environment up, then rerun. |
| `flaky` | Changes from run to run. | Read the evidence; look for waits and races. |
| `unknown` | kobay could not classify it. | Read the evidence yourself. |

A `kobay:` error thrown by generated code marks an unsupported plan step (for
example one that needs the real credentials); it is reported as `test_bug`
without asking the brain.

`failure.recommendedFixTarget.kind` is one of `code`, `selector`, `data`, `env`,
`unknown`, with a `reference` and a `rationale`.

## Cost and data

Every brain call costs money or subscription quota. kobay caps it per process:

| Limit | Default | Environment variable | `.kobay/config.json` (under `brain`) |
| --- | --- | --- | --- |
| Per `claude` call (sent as `--max-budget-usd`) | $1 | `KOBAY_MAX_BUDGET_USD` | `maxBudgetUsd` |
| Brain calls per process | 100 | `KOBAY_MAX_BRAIN_CALLS` | `maxCalls` |
| Total cost per process | $5 | `KOBAY_MAX_TOTAL_COST_USD` | `maxTotalCostUsd` |
| OpenRouter response tokens | 4096 | `KOBAY_OPENROUTER_MAX_TOKENS` | `maxTokens` |

Environment variables override the config file. Each process has one spending
counter; if it sees different limits (two projects in one MCP server, say) the
strictest value of each applies and the counter is not reset. Raising a limit
only takes effect in a new process — restart kobay or the MCP server. When a
limit is hit, kobay tells the agent to ask you for approval rather than change
the setting itself.

A call that starts and then times out or errors is **not** refunded, because the
provider may already have billed it; the reported real cost is counted if there
is one, otherwise the whole reserved amount. The cap can only count cost the
provider reports — `claude` does, `codex` does not, so for Codex only the call
limit applies. OpenRouter defaults to `google/gemini-3.8-flash`: kobay fetches
the model's price, reserves the worst case and sends `provider.max_price`, and
makes no call if the price cannot be determined. If `ANTHROPIC_API_KEY` is set,
`claude -p` may bill your API account instead of your subscription; kobay warns
once. If `OPENAI_API_KEY` or `CODEX_API_KEY` is set, `codex exec` may bill your
API account instead of your ChatGPT plan; kobay warns once. And `test run --all` generates code for every test that has none and
analyses every failure — accept a few proposals first.

**What leaves your machine.** The browser, the app and the test runs stay local.
These go to the brain you chose (Anthropic via `claude`, OpenAI via `codex`, or
OpenRouter and whatever it routes to):

| Step | Sent to the LLM |
| --- | --- |
| `test plan generate` | The map: page URLs, titles, headings, link/button/menu labels, form field names and labels. Your `--docs` file, first 20,000 characters. Your `--hint`. |
| `test run` (code generation) | The test's plan steps and the map. |
| `test run` (failure analysis) | The error message, the failing step's cleaned DOM, up to 20 console errors, up to 20 failed network requests, the test code and plan steps. Screenshots are not sent. |
| `test refresh` | The old and new summary of the test's page, the map diff and the plan steps. |

Before failure analysis, and before anything is written to `.kobay/logs/`, kobay
masks the values of secret environment variables (`*_API_KEY`, `*_TOKEN`,
`*_SECRET`, `KOBAY_LOGIN_PASS`), provider token shapes such as `sk-…` and `ghp_…`,
and values that look like secrets — password and token JSON fields,
`Bearer`/`Basic` headers, secret-looking URL parameters, `key=value` pairs — as
`[redacted]`. Beyond the environment variables this is pattern matching, so it
will miss some. **The map and docs sent during planning
are not masked.** Do not point kobay at pages showing real customer data.

kobay never puts the stored password into a prompt; Playwright types it into the
login form locally. Every call's full prompt and raw response are logged to
`.kobay/logs/` (git-ignored), with the same masking applied.

## The `.kobay/` directory

All project state lives in `.kobay/` at your app's root:

| Path | Contents |
| --- | --- |
| `config.json` | Base URL, login URL, docs path, brain settings and limits (under `brain`). |
| `credentials.json` | Login `username` and `password`, mode 0600, git-ignored. |
| `storageState.json` | Playwright session state, mode 0600, git-ignored. |
| `map.json` | The map: `pages` with `title`, `headings`, `links`, `forms`, `buttons`, `menu`. |
| `plan/proposals.json` | Proposals from the brain. |
| `tests/` | Test records (`t_*.json`), generated code (`t_*.spec.ts`), `_fixture.ts`. |
| `runs/r_*/` | One folder per run: `result.json`, step `.png`/`.html`, `console.json`, `network.json`, `trace.zip`. |
| `failure/<testId>/` | Latest failure bundle per test, written atomically. |
| `failure-out/<testId>/` | Default destination of `test failure get`, refreshed in place (git-ignored). |
| `report/` | Latest HTML report from `test report`: `index.html`, `kobay-report.json` and `assets/<runId>/step-<n>.png` (git-ignored). |
| `logs/` | Brain call logs. |
| `playwright.config.ts` | Generated runner config. Edit it by hand and kobay leaves it alone, with a warning. |
| `.credentials-txn` | Marker of a running credential change; `.stale-*` holds the set-aside copies. Both git-ignored. |

`.kobay/tests/_fixture.ts` is rewritten before every run to point at the active
kobay installation; do not edit it by hand.

**Upgrading a 0.1 project.** The first 0.2 command renames `harita.json` to
`map.json` and `plan/onerileri.json` to `plan/proposals.json`, and rewrites
`config.json`, `credentials.json`, `map.json` and `plan/proposals.json` with the
English field names (`credentials.json` keeps mode 0600). No command to run, no
flag. An existing `map.json` is never overwritten by a stale 0.1 file, and if
`.kobay` cannot be written at all, kobay prints one warning per file and keeps
reading the old names. A half-finished 0.1 credential transaction is still
recognised and rolled back, and while that compatibility window lasts a 0.2
transaction holds both marker names (`.credentials-txn` and the 0.1
`.kimlik-islemi`) so an old command blocks instead of racing. The move is
one-way: 0.1 cannot read a 0.2 project. **Run `kobay agent install` again** so
the installed skill teaches your agent the new field names.

**Run pruning.** `.kobay/runs/` is pruned once a run is fully handled — for a
failed run, after its bundle is written — so analysis never loses the evidence it
is analysing. Per test, kobay keeps the last 5 runs, the run the published bundle
points at, the run that just finished, and anything that finished in the last 10
minutes. A run directory with no `result.json` is left alone, so
`test result --history` lists at most what is still on disk.

**Git.** kobay maintains `.kobay/.gitignore` between `# >>> kobay managed >>>`
and `# <<< kobay managed <<<`; lines you add outside that block are kept. The
managed block is:

```
credentials.json
runs/
storageState.json
.stale-*
.eski-*
.credentials-txn*
.kimlik-islemi*
*.log
failure/
failure-out/
logs/
tests/_fixture.ts
test-results/
playwright-report/
blob-report/
report/
.kobay-report-*
```

`.kobay-report-*` is the temporary folder `test report` writes next to the
report before swapping it in. `.eski-*` and `.kimlik-islemi*` are the 0.1 spellings, still listed so a
leftover from an older version stays out of git. Commit the rest — config, map,
tests — to share them with your team. The block is
re-synced on every kobay command, so older projects pick up new rules
automatically, and on a read-only filesystem kobay warns instead of failing.
Because those folders are ignored, a fresh clone or CI checkout arrives without
`runs/`, `failure/`, `failure-out/` and `logs/`; kobay re-creates them on every
command.

## Security model

Read this before pointing kobay at anything that matters.

- **Generated code runs as your user**, in a local Node/Playwright process with
  your file permissions. The LLM's input includes text from the app under test,
  so a page can try to steer what code gets written (prompt injection).
- **The code check is a speed bump, not a sandbox.** Before saving, kobay rejects
  code using `process`, `globalThis`, `eval`, `Function`, `arguments[...]`,
  constructor chains, Node built-ins, `require` (including under another name),
  any `import`/`export` beyond the allowed first line, and Unicode escapes or an
  ambiguous `/` outside strings and comments. (Names like `module` or `fs` are
  fine as the test's own variables.) It is a hand-written lexical scanner, not a
  JavaScript parser: **hard escapes remain open** — a constructor chain built from
  concatenated strings, say — and generated code can read files on disk,
  including those under `.kobay/`. There is no sandbox.
- **The browser is not fenced.** Code in the page (`page.evaluate` with `fetch`)
  or `page.request` can send data anywhere; kobay does not block it. Point kobay
  only at apps and models you trust.
- **Test processes get a filtered environment.** They do not inherit your shell.
  An allowlist passes `PATH`, `HOME`, user/shell/temp/terminal variables, locale
  and time zone (`LANG`, `LC_*`, `TZ`), `CI`, `DEBUG`, Linux display and font
  variables, `PLAYWRIGHT_*`, `PW_*`, and proxy and certificate settings
  (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_*`). Prefix-allowed names that look like secrets
  (`PLAYWRIGHT_SERVICE_ACCESS_TOKEN` and friends) are dropped by a second filter,
  as are proxy URLs carrying a user and password; `NODE_OPTIONS` is not on the
  list. The session travels as a storage-state file, so the password never
  reaches the test process.
- **Local or test environments only.** Generated tests click, submit, and create
  or delete records. Never aim kobay at production or real data.
- **Credentials are origin-locked.** `.kobay/credentials.json` stores the login
  user and password in plain text (mode 0600) for one origin;
  `.kobay/storageState.json` holds the session cookies (0600). Both are
  git-ignored. Moving the project to another origin with
  `project update --base-url` or `project create --force` deletes both and lists
  them under `invalidated`. If the saved origin does not match, `explore` and
  `test refresh` exit `5` before opening a browser; fix with
  `kobay project create --url <URL> --login --force`.
- **Credentials stay on the app's site.** The login URL must share the base
  URL's origin, and kobay stops without typing the password if the login page
  redirects to another origin or the form's `action` points to another site (the
  same-site rule below applies, so a form on `app.example.com` may post to
  `api.example.com`). *During login*
  (from typing the password until the page has moved on and the network is
  quiet, at most 2 s), requests may carry credentials only to the `baseUrl`
  origin or its own site: a request (`fetch`, XHR, `sendBeacon`, image request)
  that carries the password to another site is blocked and the login is
  rejected, cross-site writes (POST, PUT and the like) are blocked, and
  cross-site WebSockets are closed before they connect; messages sent on a
  cross-site WebSocket that was already open are dropped silently during this
  window (up to about 7 s). *After login*, until
  the `explore` or `test refresh` browser closes, only cross-site requests and
  WebSocket messages that visibly carry the password are blocked, and
  exploration is rejected; the app's own cross-site API calls and WebSockets go
  through. Same-site subdomains are allowed (`app.example.com` and
  `api.example.com`, same scheme); a separate auth site (SSO) is not. On
  `localhost`, IP addresses and single-label hosts the port may differ but the
  host name must match: `localhost:5173` may call `localhost:8080`, while
  `localhost` and `127.0.0.1` are different sites. kobay approximates the
  registrable domain (last two labels, three after known suffixes such as
  `co.uk` or `github.io`) instead of reading the Public Suffix List: tenants of
  common hosting platforms (`github.io`, `vercel.app`, `a.run.app`,
  `up.railway.app` and others) are separate sites, and anything under
  `amazonaws.com` or `cloudfront.net` needs the exact origin. If your hosting
  platform is missing from the list, report it so it can be added. When
  credentials are configured, service workers are disabled. Limits: on a
  307/308 redirect kobay detects and rejects the login, it cannot block the
  redirected request itself, so the password may already have reached the
  other server; a WebSocket opened from a Web Worker is not intercepted; a
  password encoded in a way kobay does not recognise can still leave in a
  cross-site GET, and after login in any cross-site request. When login is
  refused for any of these reasons, `explore` and `test refresh` exit `5`.
- **Traces contain session cookies.** `trace.zip` in `runs/`, `failure/` and any
  `failure-out/` copy includes the browser session. Treat a bundle like a
  password — do not attach it to public issues. `.kobay/failure-out/<id>/` is
  git-ignored; if you copy one elsewhere with `--out`, git-ignore that folder.
  Text evidence (`console.json`, `network.json`, `step-*.html`) is secret-masked
  when copied into the bundle, but screenshots and `trace.zip` cannot be: they
  may contain secrets visible on screen or in network traces, so treat the whole
  bundle as sensitive (`.kobay/failure-out/` is git-ignored).
- **HTML report screenshots are not redacted.** `test report` masks and escapes
  every text it writes, but copies step screenshots as they are. Do not publish
  a report before looking at them. `.kobay/report/` is git-ignored; if you write
  the report elsewhere with `--out`, git-ignore that folder too.
- **Path limits.** File arguments (`--docs`, `--docs-path`, `--plan`; `docs`,
  `docsPath`, `planPath`, `out` over MCP) must stay inside the project; `..` and
  symlink escapes are rejected, as are paths under `.kobay/` or with any
  dot-prefixed component (`.env`, `.git`, `.claude`) — exit `2`. The saved docs
  path is re-checked on every plan generation. Two exceptions: the bundle may be
  written under the already-ignored `.kobay/failure-out/`; and on the **CLI**,
  `test failure get --out` may point outside the project, still subject to the
  dot-path rule. Over MCP, `out` must stay inside the project root, so an agent
  cannot move a cookie-bearing bundle off the project tree.

## Known limitations

- **Only the `claude` brain has seen long use.** `codex` has passed one live
  round (plan, code generation, failure analysis); `openrouter` is unit-tested
  but has never run against the real API.
- **Windows has CI coverage, not physical-machine coverage.** The unverified
  cases are orphan-process cleanup, rename-on-open-file `EPERM`, 8.3 and UNC
  paths, and the `claude` CLI's Git Bash requirement. Please report issues.
- **No sandbox for generated tests.** See [Security model](#security-model).
- **HTML report race window.** `test report` checks a folder and then renames or
  deletes it; a local process that swaps that folder at the same moment can
  still win the race. On Windows, junctions and other reparse points are only
  partly covered by the symlink checks.
- **Browser tests only.** No API or backend tests.
- **Always headless.** No visible browser window; use `trace.zip` instead.
- **Simple login only.** A username/password HTML form. SSO (a login on a
  separate auth site), OAuth redirects, CAPTCHA and 2FA are not handled;
  subdomains of the app's own site may receive the credentials. A
  JavaScript-driven login is covered only by the network guard, not by the
  form-origin check.
- **Exploration is shallow by design:** `<a href>` links only, no form submits or
  button clicks, stopping at 40 pages.
- **Some commands still print raw JSON in text mode:** `project get`,
  `test get`, `test result`, and the body of `test plan generate`.
- **The automatic pruning after a run only touches the test that just ran.**
  Runs of tests you never re-run stay on disk until you run `kobay prune`, which
  sweeps the whole `.kobay` storage (all tests' runs, brain logs and leftovers
  from older versions).
- **Killing kobay with SIGKILL leaves the process tree behind.** On
  SIGTERM/SIGINT kobay terminates the Playwright worker and Chromium; SIGKILL
  cannot be caught.
- **`test delete` leaves evidence behind.** It removes the test record and its
  generated code, but `failure/<id>/`, `failure-out/<id>/` and old run folders
  stay on disk.

## Roadmap

1. **Live test of the OpenRouter brain** against a real app, and longer use of Codex.
2. **Cleanup on `test delete`.**
3. **JavaScript logins**, beyond the plain HTML form.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay && npm install && npm run build

npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm test                  # vitest
KOBAY_01_DIST=skip npm run test:strict # strict run: real Chromium, cross-version suite skipped
npm run duman             # smoke test: npm pack, install into a clean dir, real explore
npm run kobay -- doctor   # run the CLI from source via tsx
```

`test:strict` requires `KOBAY_01_DIST`: `skip` skips the cross-version suite
(what CI does); point it at a real 0.1 install instead to run that suite for real.

CI (`.github/workflows/ci.yml`) runs build, `test:strict` and `duman` on
ubuntu-latest and macos-latest with Node 22 and 24.

**Contributing.** Issues and pull requests welcome at
[github.com/ademtfkc/kobay](https://github.com/ademtfkc/kobay). Run
`npm run typecheck`, `npm run lint` and `KOBAY_01_DIST=skip npm run test:strict`
before opening a PR, and say what you actually ran. Everything a machine reads
is English; the source identifiers and code comments are Turkish, and stay
that way.

## License

Apache-2.0. See [LICENSE](LICENSE).
