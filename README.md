# kobay

[Türkçe](README.tr.md) · [CHANGELOG](CHANGELOG.md) · Apache-2.0

**kobay is a local end-to-end test engine for coding agents.** Point it at a web
app running on your machine. It explores the app in a headless Chromium, asks an
LLM to propose user flows, turns the ones you accept into Playwright tests, runs
them, and — when one fails — hands back an evidence bundle your agent can act on:
a root-cause hypothesis, a `failureKind` classification, a recommended fix
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
[Quick start](#quick-start) · [From your coding agent](#use-it-from-your-coding-agent) ·
[How it works](#how-it-works) · [Commands](#commands) · [Output and failures](#output-and-failures) ·
[Cost and data](#cost-and-data) · [`.kobay/`](#the-kobay-directory) · [Security](#security-model) ·
[Limitations](#known-limitations) · [Roadmap](#roadmap) · [Development](#development)

## Status

**0.1.0, early release.** Usable, not yet smooth. What has and has not been
exercised, so you can decide before installing:

| | |
| --- | --- |
| **Who it's for** | Developers running Claude Code (or Codex / Cursor) who want the agent to verify a local web app instead of claiming it works. |
| **Verified end to end** | The `claude` CLI brain, driven by a Claude Code agent over MCP. Two real runs against a real app: the agent found a product bug, traced the root cause, fixed it and re-ran the test green. |
| **Untested in practice** | The `codex` and `openrouter` brains. Both adapters exist and have unit tests, but neither has been run against a real CLI or API. Treat them as unverified. |
| **Platform** | Developed and run on macOS. CI runs the full suite plus a packaging smoke test on ubuntu-latest and macos-latest, Node 22 and 24. **Windows is untested.** |
| **Language** | `--help`, flags, the agent skill and this README are English. Runtime messages — errors, `doctor`, `test list`, generated proposals — are still **Turkish** in 0.1. |
| **Scope** | Browser tests only. No API tests, no backend tests, no dashboard. |

If you want a hosted product with a dashboard and a support contract, kobay is
not it — look at [TestSprite](https://www.testsprite.com/), which runs a similar
explore → plan → generate → run → analyse loop as a service. kobay is the local,
narrower, bring-your-own-LLM version of that idea.

## Requirements

- **Node.js 22.12 or newer**; macOS or Linux.
- **Chromium**, installed with `kobay install-browser`.
- **A brain:** the `claude` CLI, logged in (default, and the only tested path);
  or the `codex` CLI; or an `OPENROUTER_API_KEY` environment variable.
- **The app you want to test**, running at a URL kobay can reach.

## Install

kobay is **not on npm yet**. Today, build it from source:

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay
npm install && npm run build
npm link                     # puts `kobay` on your PATH
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

`dist/` is not committed, so a git install has to build. The package has a
`prepare` script for that, and a **local** git install —
`npm i github:ademtfkc/kobay` inside a project — does build `dist/` and work.
A **global** one, `npm i -g github:ademtfkc/kobay`, still fails on npm 11.19:
npm runs the git build step with its own global flag still set, so that step
skips the devDependencies it needs and the build stops at `tsc: command not
found`. Clone and build instead. Once kobay is published this becomes
`npm i -g kobay`.

`install-browser` downloads the Chromium build matching kobay's own Playwright
version — use it rather than `npx playwright install`, which may fetch a
different revision. On Linux, `--with-deps` also installs Chromium's system
libraries through your package manager and may ask for `sudo`.

`doctor` checks Node, the brain CLIs, Chromium, the current project and whether
the target answers. It always exits `0`, so read the rows. Before a project
exists the last two fail, as expected:

```
✓ Node 26.8.1
✓ claude CLI
✓ codex CLI
✓ Chromium
✗ .kobay — `kobay project create --url <URL>` ile proje açın
✗ hedef — proje yok; önce `kobay project create --url <URL>` çalıştırın
```

To change the default brain (written to `~/.kobay/config.json`):
`kobay setup --brain codex` (or `openrouter`). The Codex brain runs
`codex exec --ignore-user-config --ephemeral` in a read-only sandbox, so your
`~/.codex/config.toml` is ignored; set model and effort with `--model` /
`--effort`, and Codex login still comes from `CODEX_HOME`.

## Quick start

kobay ships a small demo app — login page, list, form — so you can watch the
whole loop before pointing it at your own project. Its UI text is Turkish
(`Giriş` = login, `Kontrol Paneli` = dashboard), and so is kobay's own output in
0.1 — the samples below are verbatim from a real run. kobay itself works with
apps in any language.

**1. Start the demo** in its own terminal and leave it running:
`kobay demo --port 3999` → `Kobay demo: http://127.0.0.1:3999`, login
`demo / demo123`.

**2. Create a project** in an empty directory. `--login` reads
`KOBAY_LOGIN_USER` and `KOBAY_LOGIN_PASS`; without them it prompts (the password
is not echoed), and with no terminal and no variables it exits `2` — piping
answers into stdin is not supported. The login URL must share `--url`'s origin.

```sh
mkdir kobay-demo && cd kobay-demo
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/giris
#> Proje oluşturuldu: ~/kobay-demo/.kobay
#> Giriş bilgisi: kaydedildi
#> Sonraki: kobay explore
```

**3. Explore** — no LLM call. kobay logs in and follows same-origin `<a href>`
links up to 40 pages, skipping links whose text looks like logout or delete, and
never submitting forms. The result is the *map*, `.kobay/harita.json`.

```sh
kobay explore
#> 4 sayfa keşfedildi (giriş yapıldı)
#> Sayfalar: /giris, /, /liste, /yeni
#> Sonraki: kobay test plan generate
```

**4. Generate a plan** — **LLM call.** The brain reads the map (plus a product
document if you passed `--docs`) and proposes 8–25 flows; proposals pointing at
URLs outside the map are dropped. Then accept a few — not everything, since each
test costs LLM calls the first time it runs.

```sh
kobay test plan generate
#> 2 öneri üretildi
#> {"oneriler":[{"id":"p_d8kun8","oncelik":"p0","baslik":"Kayıt listesi açılır","adimSayisi":2},
#>              {"id":"p_dyrsax","oncelik":"p1","baslik":"Yeni kayıt formu kaydeder","adimSayisi":2}],
#>  "dusurulen":[]}

kobay test plan accept --ids p_d8kun8,p_dyrsax
kobay test list
#> t_bjkhfh2l	draft	p1	Yeni kayıt formu kaydeder
#> t_ffcik12p	draft	p0	Kayıt listesi açılır
```

**5. Run.** A test with no code gets Playwright code generated first (LLM call),
then runs; a failing test is then analysed (another LLM call). 120 s per test.

```sh
kobay test run --all
#> failed t_kvwmtb23 — product_bug
#>   hata paketi: kobay test failure get t_kvwmtb23
```

**6. Read the failure.** Without `--out` the bundle lands in
`.kobay/failure-out/<id>/`, refreshed in place on every call so nothing survives
from the previous one. A folder you name yourself must not exist yet.

```sh
kobay test failure get t_kvwmtb23
#> Hata paketi kopyalandı: ~/kobay-demo/.kobay/failure-out/t_kvwmtb23
#> failure.json code.ts steps.json meta.json adim-1.png adim-1.html trace.zip
```

`failure.json` carries `failure.failureKind`, `failure.rootCauseHypothesis`,
`failure.recommendedFixTarget` and the evidence list, alongside the full run
result and the generated code. `console.json` and `network.json` join the bundle
only when the analysis cites them as evidence. Open the trace with
`npx playwright show-trace trace.zip`.

**7. Fix the app, then `kobay test rerun t_kvwmtb23`** — runs the existing code
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

`.mcp.json` is a project-scoped MCP config, so Claude Code asks you once to
approve the server the first time you start it in that directory. For other
agents kobay writes the skill and you register the server yourself:

```sh
kobay agent install --target codex     # AGENTS.md, between <!-- kobay:BEGIN --> and <!-- kobay:END -->
codex mcp add kobay -- kobay mcp

kobay agent install --target cursor    # .cursor/rules/kobay.mdc
# .cursor/mcp.json: { "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }
```

The Codex target replaces only the marked block and keeps the rest of
`AGENTS.md`. All three write into the current project, never your home
directory. To register the Claude Code server by hand:
`claude mcp add -s project kobay -- kobay mcp`.

**The agent's loop** (source: [`beceri/SKILL.md`](beceri/SKILL.md)): check the
project and that the app is up → pick or generate tests for the changed feature →
run them → on a failure fetch the bundle and act on `failureKind` → re-run and
report what passed, what it changed and what is still unverified. The skill also
tells it to stop after two failed fix attempts, never to weaken an assertion to
get green, and never to print credentials or a trace into chat.

**The MCP server** (`kobay mcp`, stdio) exposes 17 tools:

```
project_create  project_update  project_get  explore       plan_generate
plan_accept     test_create     test_list    test_get      code_get
test_delete     test_run        test_rerun   test_refresh  test_result
failure_get     doctor
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

## How it works

```
explore ──> map (.kobay/harita.json)
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
in the map. **test refresh** re-explores just that test's page, updates the map
in place, adapts the plan steps, regenerates the code and runs it under the same
test ID; `--no-run` stops after the plan update.

## Commands

Verified against `kobay --help` and every subcommand's `--help` in 0.1.0.

| Command | What it does |
| --- | --- |
| `setup [--brain <b>] [--model <m>] [--effort <e>]` | Writes the default brain to `~/.kobay/config.json` (`claude`, `codex`, `openrouter`). |
| `install-browser [--with-deps]` | Installs the matching Chromium; `--with-deps` adds Linux system libraries. |
| `demo [--port <port>]` | Starts the bundled demo app. Default port 3000; `0` picks a free one. |
| `doctor` | Checks Node, brain CLIs, Chromium, project and target. Always exits `0`. |
| `project create --url <url> [--docs <path>] [--login] [--login-url <url>] [--force] [--brain <b>] [--model <m>] [--effort <e>]` | Creates `.kobay/` here. `--force` rewrites only an existing project's config, keeping its brain and limits unless you pass new ones. |
| `project update [--base-url <url>] [--login-url <url>] [--docs-path <path>] [--brain <b>] [--model <m>] [--effort <e>]` | Changes only the fields you pass. |
| `project get` | Settings, test count, whether a map exists. |
| `explore` | Explores the app and rewrites `.kobay/harita.json`. |
| `test plan generate [--hint <text>]` | Proposes tests from the map and docs. `--hint` is free text, e.g. "invoice flow only". |
| `test plan accept [--all] [--ids <id,id>]` | Turns proposals into draft tests. |
| `test create --plan <path>` | Creates a test from a hand-written plan file (below). |
| `test list` | Tests with status and priority. |
| `test get <id>` | One test's record and plan steps. |
| `test code get <id>` | Prints the generated Playwright code. |
| `test delete <id>` | Deletes a test record and its generated code. |
| `test run [ids...] [--all] [--rerun]` | Generates missing code, then runs. `--rerun` skips generation. |
| `test rerun <id>` | Runs existing code without regenerating it. |
| `test refresh <id> [--no-run]` | For `product_changed`: re-explore, adapt the plan, regenerate and run. |
| `test result <id> [--history]` | Last run result, or every run still on disk. |
| `test failure get <id> [--out <dir>]` | Copies the failure bundle. Default `.kobay/failure-out/<id>/`, refreshed in place. |
| `agent install --target <claude\|codex\|cursor>` | Installs the agent skill here; for `claude` also registers the MCP server in `.mcp.json`. |
| `mcp` | Starts the stdio MCP server. |

Global options: `--cwd <dir>`, `--output json`, `-V/--version`, `-h/--help`.

A hand-written plan file for `test create --plan`
([`schemas/plan.schema.json`](schemas/plan.schema.json)) needs `projectId`,
`type` (must be `frontend`) and `name`, takes an optional `description` and
`priority` (`p0`–`p3`, default `p1`), and 1–200 `planSteps`, each `action` or
`assertion` with a `description`:

```json
{ "projectId": "demo", "type": "frontend", "name": "Log in with valid credentials",
  "priority": "p0",
  "planSteps": [
    { "type": "action", "description": "Open /giris and log in as demo / demo123" },
    { "type": "assertion", "description": "The 'Kontrol Paneli' heading is visible" } ] }
```

There is no `url` field, so a hand-written test skips the map comparison during
failure analysis and prints a note saying so.

## Output and failures

**Text output** (the default) is a short human summary — ids, paths, counts and
the next command to run. Do not parse it. Every command also accepts
`--output json` and then prints one envelope:

```
{"ok":true,"exitCode":0,"data":[{"id":"t_ffcik12p","durum":"passed","oncelik":"p0","ad":"Kayıt listesi açılır"}]}
{"ok":false,"exitCode":2,"hata":{"kod":"GecersizKimlik","mesaj":"Geçersiz testId: t_yok"}}
```

Read `ok` and `exitCode` from the JSON rather than `$?` after a pipe —
`kobay ... | jq` reports `jq`'s exit code, not kobay's.

**Exit codes:** `0` passed · `1` a test failed · `2` usage error · `3` target
unreachable · `4` brain or engine error · `5` login or permission problem. With
several tests, `test run` exits with the highest code.

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

`failure.recommendedFixTarget.kind` is one of `code`, `selector`, `data`, `env`,
`unknown`, with a `reference` and a `rationale`.

## Cost and data

Every brain call costs money or subscription quota. kobay caps it per process:

| Limit | Default | Environment variable | `.kobay/config.json` (under `beyin`) |
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
once. And `test run --all` generates code for every test that has none and
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

Before failure analysis kobay masks values that look like secrets — password and
token JSON fields, `Bearer`/`Basic` headers, secret-looking URL parameters,
`key=value` pairs — as `[maskelendi]`. That is pattern matching, not a list of
your real secrets, so it will miss some. **The map and docs sent during planning
are not masked.** Do not point kobay at pages showing real customer data.

kobay never puts the stored password into a prompt; Playwright types it into the
login form locally. Every call's full prompt and raw response are logged to
`.kobay/logs/` (git-ignored).

## The `.kobay/` directory

All project state lives in `.kobay/` at your app's root:

| Path | Contents |
| --- | --- |
| `config.json` | Base URL, login URL, docs path, brain settings and limits. |
| `credentials.json` | Login credentials, mode 0600, git-ignored. |
| `storageState.json` | Playwright session state, mode 0600, git-ignored. |
| `harita.json` | The map: pages, titles, headings, links, forms, menus. |
| `plan/onerileri.json` | Proposals from the brain. |
| `tests/` | Test records (`t_*.json`), generated code (`t_*.spec.ts`), `_fixture.ts`. |
| `runs/r_*/` | One folder per run: `result.json`, step `.png`/`.html`, `console.json`, `network.json`, `trace.zip`. |
| `failure/<testId>/` | Latest failure bundle per test, written atomically. |
| `failure-out/<testId>/` | Default destination of `test failure get`, refreshed in place (git-ignored). |
| `logs/` | Brain call logs. |
| `playwright.config.ts` | Generated runner config. |

`.kobay/tests/_fixture.ts` is rewritten before every run to point at the active
kobay installation; do not edit it by hand.

**Run pruning.** `.kobay/runs/` is pruned once a run is fully handled — for a
failed run, after its bundle is written — so analysis never loses the evidence it
is analysing. Per test, kobay keeps the last 5 runs, the run the published bundle
points at, the run that just finished, and anything that finished in the last 10
minutes. A run directory with no `result.json` is left alone, so
`test result --history` lists at most what is still on disk.

**Git.** kobay maintains `.kobay/.gitignore` between `# >>> kobay managed >>>`
and `# <<< kobay managed <<<`; lines you add outside that block are kept. The
managed block ignores `credentials.json`, `runs/`, `storageState.json`,
`.eski-*`, `.kimlik-islemi*`, `*.log`, `failure/`, `failure-out/`, `logs/`,
`tests/_fixture.ts`, `test-results/`, `playwright-report/` and `blob-report/`;
commit the rest — config, map, tests — to share them with your team. The block is
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
  them under `gecersizKilinan`. If the saved origin does not match, `explore` and
  `test refresh` exit `5` before opening a browser; fix with
  `kobay project create --url <URL> --login --force`.
- **Credentials stay on the target's origin — for HTML forms only.** The login
  URL must share the base URL's origin, and kobay stops without typing the
  password if the login page redirects elsewhere or the form's `action` points
  off-origin. **This covers normal form posts only: if the page's JavaScript
  submits the credentials itself (`fetch`/XHR), kobay cannot see where they go.**
- **Traces contain session cookies.** `trace.zip` in `runs/`, `failure/` and any
  `failure-out/` copy includes the browser session. Treat a bundle like a
  password — do not attach it to public issues. `.kobay/failure-out/<id>/` is
  git-ignored; if you copy one elsewhere with `--out`, git-ignore that folder.
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

- **Runtime messages are Turkish.** In 0.1.0, error and status messages,
  `doctor` rows, `test list` output and some JSON field names (`ad` = name,
  `hata` = error, `mesaj` = message, `oneri` = suggestion, `durum` = status) are
  Turkish, and generated proposals usually come back in Turkish too. `--help`,
  flags, the agent skill and this README are English.
- **Only the `claude` brain is proven.** `codex` and `openrouter` are
  unit-tested but have never run against a real CLI or API.
- **Windows is untested**; macOS and Linux only.
- **No sandbox for generated tests.** See [Security model](#security-model).
- **Browser tests only.** No API or backend tests.
- **Always headless.** No visible browser window; use `trace.zip` instead.
- **Simple login only.** A username/password HTML form. SSO, OAuth redirects,
  CAPTCHA and 2FA are not handled, and a JavaScript-driven login is invisible to
  the origin check.
- **Exploration is shallow by design:** `<a href>` links only, no form submits or
  button clicks, stopping at 40 pages.
- **Some commands still print raw JSON in text mode:** `project get`,
  `test get`, `test result`, and the tail of `test plan generate`.
- **Pruning only touches the test that just ran.** Runs belonging to tests you
  never re-run are kept indefinitely.
- **`test delete` leaves evidence behind.** It removes the test record and its
  generated code, but `failure/<id>/`, `failure-out/<id>/` and old run folders
  stay on disk.

## Roadmap

1. **0.2 — English runtime messages:** errors, `doctor`, `test list`, JSON field
   names and the planning prompt.
2. **Live test of the Codex brain**, then OpenRouter, against a real app.
3. **Better housekeeping:** global pruning, cleanup on `test delete`.
4. **Windows support**, once someone has actually run it there.
5. **npm publish**, so install is one line.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay && npm install && npm run build

npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm test                  # vitest
npm run test:kati         # strict run: real Chromium, no skipped suites
npm run duman             # smoke test: npm pack, install into a clean dir, real explore
npm run kobay -- doctor   # run the CLI from source via tsx
```

CI (`.github/workflows/ci.yml`) runs build, `test:kati` and `duman` on
ubuntu-latest and macos-latest with Node 22 and 24.

**Contributing.** Issues and pull requests welcome at
[github.com/ademtfkc/kobay](https://github.com/ademtfkc/kobay). Run
`npm run typecheck`, `npm run lint` and `npm run test:kati` before opening a PR,
and say what you actually ran. The source is Turkish — identifiers, comments and
runtime strings — while the public surface (CLI help, skill, docs) is English;
keep that split until 0.2 moves the runtime strings over.

## License

Apache-2.0. See [LICENSE](LICENSE).
