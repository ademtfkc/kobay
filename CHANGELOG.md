# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `prepare` script, so a git install builds `dist/`. A local git install
  (`npm i github:ademtfkc/kobay`) now works; a global one still fails on npm
  11.19, which runs the git build step in global mode and skips the
  devDependencies it needs.

### Security

- CLI file arguments can no longer escape the project root: `--docs`,
  `--docs-path` and `--plan` are rejected (exit 2) when the path resolves outside
  the project, either through `..` or through a symlink inside the root pointing
  out. `kobay test failure get --out` keeps its documented freedom to write
  outside the project on the CLI; over MCP `out` stays root-bound.
- `kobay test failure get` now refuses its fixed output path when `.kobay`,
  `.kobay/failure-out` or the per-test folder is a symlink, or when the resolved
  path escapes `.kobay/failure-out` (exit 2). A cloned repo could previously ship
  such a link and have the in-place refresh delete a directory outside the
  project root.

### Changed

- `test failure get` now always writes to `.kobay/failure-out/<id>/` instead of a
  new `<id>-<n>` folder per call; the bundle is replaced in place (old files are
  removed), so repeated calls no longer pile up directories. The CLI and the MCP
  `failure_get` tool use the same default.
- `explore`, `project create`, `project update`, `test create`, `setup` and
  `test refresh` now print a short human-readable summary in text mode instead of
  the JSON body: the ids, paths and counts they produce plus the next command to
  run. `--output json` returns exactly the same body as before.

- `agent install --target claude` now registers the MCP server itself: it writes
  or merges `.mcp.json` in the project root instead of printing a
  `claude mcp add` command. Other servers and top-level keys in an existing
  `.mcp.json` are preserved; only the `kobay` entry is replaced. The command is
  `kobay mcp` when `kobay` is on `PATH`, `npx -y kobay mcp` otherwise.
  `--output json` reports the file under `mcp`. `--target codex` and
  `--target cursor` still print the registration line and touch nothing. An
  invalid `.mcp.json` is left untouched and reported with exit code 2.
- Plan file JSON Schema (`schemas/plan.schema.json`) rewritten from kobay's own
  validator: draft 2020-12, kobay's `$id` and title, and field descriptions that
  match what kobay actually accepts and does.

### Fixed

- Skill step 5 listed the wrong failure-bundle files: `meta.json` is always
  there, `console.json` and `network.json` only when the analysis cites them.
- `.kobay/son-liste.json` is no longer produced: the generated Playwright config
  had a JSON reporter nothing ever read, leaving a stale file full of absolute
  developer paths. The reporter is gone, an old config that still has it is
  refreshed on the next command, the stale file is deleted on the first command,
  and the entry was dropped from the managed `.gitignore` block. A `playwright.config.ts` that was edited by hand is left
  alone with a warning instead of being overwritten.
- `.kobay/runs/` is pruned by the command layer once a run is fully handled —
  for a failed run, after its failure bundle is written — instead of inside the
  run engine, so failure analysis can no longer lose the evidence (DOM,
  screenshot, console, network, trace) of the run it is analysing. On top of the
  last 5 runs per test and the run the published failure bundle points at, the
  run that just finished and any run that finished in the last 10 minutes are
  kept, so concurrent runs of the same test keep their evidence. A run directory
  without `result.json` is left alone.
- Usage errors were printed twice (`error: …` once by Commander and again by
  kobay's own error path). They are printed once now; exit codes are unchanged.
- `kobay test failure get --help` claimed the default bundle folder was
  `.kobay/failure-out/<id>-<n>`; it states the actual default now.
- `project create --force` and `project update` now invalidate the saved
  credentials and session transactionally: the files are moved aside, restored if
  the config (or new credential) write fails, and deleted only after the write
  succeeds — a failed write no longer loses the stored login. Leftovers from an
  interrupted run are handled by the next command's recovery (see below) and are
  covered by the managed `.gitignore` block (`.eski-*`).
- The identity-swap transaction marker (`.kobay/.kimlik-islemi`, gitignored) is
  now a real single-owner lock. It is created with `O_EXCL`, so a second
  `project create --force` / `project update` that would change the saved
  credentials is rejected outright (exit 2, "another kobay command is changing
  this project's identity") instead of racing the first one. A marker left by a
  dead process (owner gone, or older than 10 minutes) is taken over through an
  atomic rename: whoever renames it away wins, everyone else is rejected.
  Previously the marker was simply overwritten, so two commands could run at once
  and leave several `.eski-*` copies of the same file, with recovery picking one
  at random and deleting the rest.
- Leftover credential/session copies now carry the transaction id
  (`.eski-<id>-<name>`), and recovery only collects the copies belonging to the
  stale marker it cleaned up; any other copy is treated as unowned and is never
  restored or deleted, only reported.
- An identity swap now has a single commit point: when every set-aside backup is
  verified in place, the marker file is atomically rewritten with
  `committed: true`. Recovery reads that flag, so a committed leftover is deleted
  even when the real file is missing and an old session is never revived under a
  new target. Deleting the backups afterwards is best effort: a failed delete
  warns, naming the file and the reason, and leaves the copy for the next
  command's recovery instead of failing or rolling back.
- The marker also carries a snapshot of the pre-swap config, and rollback is one
  durable routine used by both the command and crash recovery, in one order:
  config snapshot, then the set-aside copies, then any credential written by
  `--login`. No step is swallowed — a failure stops the command with an explicit
  rollback error (exit 4), leaves the copies untouched and keeps the marker so
  the next kobay command retries the same sequence, and a stale marker that could
  not be rolled back is not taken over by a new identity-changing command. A
  leftover with no marker (older version, or left by hand) is never restored: it
  stays in place with a warning. It also records which identity files
  were set aside, so a retried recovery can no longer delete a
  `credentials.json` that an earlier attempt had already restored.
- The Claude brain's timeout/budget test is deterministic: the fixture recorded a
  call only after stdin closed, so a call killed by the timeout could go
  uncounted under load.

## [0.1.0] - 2026-09-21

### Added

- Local-first exploration and AI-assisted Playwright test generation.
- Test execution with structured results and evidence-backed failure packages.
- Claude, Codex, OpenRouter, and MCP integrations.
- Packaged demo application and version-matched Chromium installer commands.

### Fixed

- Failure bundle output now defaults to `.kobay/failure-out/<id>-<n>`, and both
  MCP `failure_get` and CLI `--out` apply the same hidden-path rule with that
  single exception.
- Zero-test / report-error runs are `inconclusive`, never `passed`.
- `_fixture.ts` re-targeted to the active installation before each run.
- `.kobay/.gitignore` managed block synced on every command.
- `agent install` human output is plain text.
- `doctor --output json` omits `oneri` on healthy rows.
- In a cloned or CI checkout `.kobay/failure/`, `runs/` and `logs/` are absent
  (git-ignored), so a failing test showed as `inconclusive` and no failure bundle
  was written. kobay now recreates its own working folders on every command, and
  bundle writing creates its parent folder itself.
- MCP `test_run` / `test_rerun` returned `isError: true` for a failing test. A
  failed test (exit 1) is a valid result; `isError` is now reserved for real tool
  errors (usage 2, target down 3, engine 4, permission 5).
- `kobay test failure get`, `test delete` and `install-browser` printed the
  message to stderr and the JSON body to stdout in text mode; they now print one
  plain line to stdout. `--output json` is unchanged.
- `kobay test run` text output shows `failureKind` and the
  `kobay test failure get <id>` hint on a failed test, and the first line of the
  engine error on an inconclusive run. JSON output is unchanged.

[Unreleased]: https://github.com/ademtfkc/kobay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ademtfkc/kobay/releases/tag/v0.1.0
