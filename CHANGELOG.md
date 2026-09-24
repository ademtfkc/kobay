# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-23

### Breaking

- **The machine-facing contract is English.** Every JSON field name, error code
  and `.kobay` file name that an agent or a script reads was renamed. Turkish
  survives only inside prompts and in text the brain writes.

  - **Result envelope:** `hata` → `error`, `kod` → `code`, `mesaj` → `message`.
  - **Error codes** (the `code` value): `KullanimHatasi` → `UsageError`,
    `YetkiHatasi` → `PermissionError`, `HedefYokHatasi` →
    `TargetUnreachableError`, `GecersizKimlik` → `InvalidId`, `DosyaYok` →
    `FileNotFound`, `SemaHatasi` → `SchemaError`, `PaketYarim` →
    `BundleIncomplete`, `GuvensizCikisYolu` → `UnsafeOutputPath`,
    `KimlikIslemiBozuldu` → `CredentialsTxnCorrupt`, `KimlikIslemiYurumede` →
    `CredentialsTxnInProgress`, `KimlikGeriAlinamadi` →
    `CredentialsRollbackFailed`, `McpKaydiOkunamadi` → `McpRegistryUnreadable`,
    `BeyinHatasi` → `BrainError`, `BeyinCalismaHatasi` → `BrainRuntimeError`,
    `KimlikOriginHatasi` → `CredentialOriginError`, `FixtureModuluYok` →
    `FixtureModuleMissing`, `GirdiBittiHatasi` → `InputClosedError`,
    `BilinmeyenHata` → `UnknownError`.
  - **Brain failure reasons:** `zaman_asimi` → `timeout`, `cli_yok` →
    `cli_missing`, `sema` → `schema`, `bos_yanit` → `empty_response`, `ag` →
    `network`, `anahtar_yok` → `key_missing`, `cli_hatasi` → `cli_error`,
    `cagri_tavani` → `call_cap`, `maliyet_tavani` → `cost_cap`,
    `maliyet_bilinmiyor` → `cost_unknown`, `ayar_hatasi` → `config_error`.
  - **Command output fields:** `hedef` → `destination`, `gecersizKilinan` →
    `invalidated`, `oneriler` → `proposals`, `dusurulen` → `dropped` (with
    `sebep` → `reason`), `oncelik` → `priority`, `baslik` → `title`,
    `adimSayisi` → `stepCount`, `durum` → `status`, `ad` → `name`, `eskiAd` →
    `previousName`, `sayfa` → `pageUrl`, `kosu` → `run`, `kok` → `root`,
    `testSayisi` → `testCount`, `haritaVar` → `hasMap`, `oneri` → `hint`,
    `islem` → `action` (values `olusturuldu`/`guncellendi`/`degismedi` →
    `created`/`updated`/`unchanged`), `yol` → `path`, `komut` → `command`,
    `chromiumKurulu` → `chromiumInstalled`, and `kullanici`/`parola` →
    `username`/`password` in `kobay demo`.
  - **Stored files:** the map's `girisYapildi`/`sayfalar`/`kesifTarihi` →
    `loggedIn`/`pages`/`exploredAt`; a page's
    `baslik`/`basliklar`/`linkler`/`formlar`/`dugmeler` →
    `title`/`headings`/`links`/`forms`/`buttons`; `Form.alanlar` → `fields` and
    a field's `ad`/`tip`/`etiket` → `name`/`type`/`label`; the map diff's eight
    fields → `addedHeadings`, `removedHeadings`, `addedButtons`,
    `removedButtons`, `addedFormFields`, `removedFormFields`,
    `pageIdentityMatches`, `changed`; `failure.json`'s `haritaFarki` →
    `mapDiff`; `credentials.json`'s `kullanici`/`parola` →
    `username`/`password`; `config.json`'s `beyin` → `brain` (project config,
    the global `~/.kobay/config.json`, and the MCP `project_update` input);
    `meta.json`'s `yazildi` → `writtenAt`.
  - **File names:** `.kobay/harita.json` → `.kobay/map.json`,
    `.kobay/plan/onerileri.json` → `.kobay/plan/proposals.json`,
    `.kobay/.kimlik-islemi` → `.kobay/.credentials-txn` (with the `.eski-`
    set-aside prefix → `.stale-`).
  - **Prompt response keys:** the code generator now expects
    `{"code", "explanation"}` instead of `{"kod", "aciklama"}`, and the planner's
    root key is `proposals` instead of `oneriler`. Both still accept the old
    keys, so a cached prompt does not break a run. The analysis prompt now
    serialises console entries as `{type, text, stepIndex}`, network entries as
    `{url, method, status, error, stepIndex}` and the screenshot as
    `{exists, path}`; on-disk `console.json`/`network.json` are unchanged.

  Migration is automatic and needs no command: on the first kobay command in a
  project, `.kobay/harita.json` and `.kobay/plan/onerileri.json` are renamed,
  and `config.json`, `credentials.json`, `map.json` and `plan/proposals.json`
  are rewritten with the new field names (`credentials.json` keeps mode 0600).
  Files written by 0.1 are still readable during that first command, and a
  half-finished credentials transaction left behind by 0.1 — old marker name,
  old prefix, old field names — is still recognised and rolled back. While that
  compatibility window lasts, a 0.2 transaction holds both marker names
  (`.kobay/.credentials-txn` in the 0.2 schema and `.kobay/.kimlik-islemi`
  written in the 0.1 schema: `islemId`, `baslatildi`, `eskiConfig.beyin`,
  `yeniKimlikYazilacak`, `kenaraAlinanlar`) and creates, updates and removes
  them together, so a 0.1 process honours the lock instead of discarding it;
  verified with real 0.1 and 0.2 subprocesses. Both names are git-ignored. The
  file renames are no-replace: an existing `map.json` or `plan/proposals.json`
  is never overwritten by a stale 0.1 file. If the
  rename cannot run at all (a read-only or unwritable `.kobay`), kobay prints one
  warning per file and keeps reading the old file name, so the map and proposals
  do not silently disappear. The move is one-way: once a project has been
  migrated, 0.1 stops with a schema error on `config.json` (`beyin` is gone) and
  never reaches the credentials transaction; the shared lock only matters while
  the migration write itself has not happened yet (for example on a read-only
  checkout).

  **Run `kobay agent install` again in each project** so the installed skill
  file teaches the agent the new field names.

### Added

- The package publishes to npm as `@ademtfkc/kobay` (npm rejected the
  unscoped name `kobay` as confusingly similar to existing packages); the CLI
  command stays `kobay`.
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
  `kobay mcp` when `kobay` is on `PATH`, `npx -y @ademtfkc/kobay mcp` otherwise.
  `--output json` reports the file under `mcp`. `--target codex` and
  `--target cursor` still print the registration line and touch nothing. An
  invalid `.mcp.json` is left untouched and reported with exit code 2.
- Plan file JSON Schema (`schemas/plan.schema.json`) rewritten from kobay's own
  validator: draft 2020-12, kobay's `$id` and title, and field descriptions that
  match what kobay actually accepts and does.
- All user-facing CLI, doctor, agent install and MCP text (error messages,
  summaries, warnings, tool descriptions) is now English. JSON field names, error
  codes and exit codes are unchanged in this step.
- Engine-layer user-facing text is now English: thrown error messages, `[kobay]`
  stderr warnings, run-report text, failure-analysis rationale and evidence
  summaries, and the generated-code speed-bump messages.
- The bundled demo app is now fully English: pages, labels, form fields and
  messages, with routes `/login`, `/`, `/records` and `/new` (was `/giris`, `/`,
  `/liste`, `/yeni`). The demo account stays `demo / demo123`. The smoke test now
  also checks the demo pages contain no non-ASCII text.
- Brain prompts (planning, plan refresh, code generation, failure analysis) and
  the JSON-only wrapper are now English. Each prompt carries one language rule:
  names, descriptions and rationale are written in the language of the
  application's UI and docs, English when mixed or unclear. Verified with the
  real `claude` brain on the English demo app: English proposal titles,
  `{"code","explanation"}` code answers, `product_bug` classification with the
  renamed `mapDiff` fields.
- The secret-masking marker in text sent to the brain and shown in error messages
  is now `[redacted]` (was `[maskelendi]`).

### Fixed

- Skill step 5 listed the wrong failure-bundle files: `meta.json` is always
  there, `console.json` and `network.json` only when the analysis cites them.
- `.kobay/son-liste.json` is no longer produced: the generated Playwright config
  had a JSON reporter nothing ever read, leaving a stale file full of absolute
  developer paths. The reporter is gone, an old config that still has it is
  refreshed on the next command, the stale file is deleted on the first command,
  and the entry was dropped from the managed `.gitignore` block. A
  `playwright.config.ts` that was edited by hand is left alone with a warning
  instead of being overwritten.
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
  covered by the managed `.gitignore` block (`.stale-*`).
- The identity-swap transaction marker (`.kobay/.credentials-txn`, gitignored) is
  now a real single-owner lock. It is created with `O_EXCL`, so a second
  `project create --force` / `project update` that would change the saved
  credentials is rejected outright (exit 2, "another kobay command is changing
  this project's identity") instead of racing the first one. A marker left by a
  dead process (owner gone, or older than 10 minutes) is taken over through an
  atomic rename: whoever renames it away wins, everyone else is rejected.
  Previously the marker was simply overwritten, so two commands could run at once
  and leave several `.stale-*` copies of the same file, with recovery picking one
  at random and deleting the rest.
- Leftover credential/session copies now carry the transaction id
  (`.stale-<id>-<name>`), and recovery only collects the copies belonging to the
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
  stays in place with a warning. The marker also records which identity files
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
