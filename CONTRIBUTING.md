# Contributing to kobay

Issues and pull requests are welcome at
[github.com/ademtfkc/kobay](https://github.com/ademtfkc/kobay). For a security
problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

You need Node.js 22.12 or newer.

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay
npm install && npm run build
node dist/cli/index.js install-browser   # Linux: add --with-deps
```

## Commands

```sh
npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm test                  # vitest
KOBAY_01_DIST=skip npm run test:strict # strict run: real Chromium, cross-version suite skipped
npm run duman             # smoke test: npm pack, install into a clean dir, real explore
npm run kobay -- doctor   # run the CLI from source via tsx
```

`test:strict` requires `KOBAY_01_DIST`: `skip` skips the cross-version suite
(what CI does); point it at a real 0.1 install instead to run that suite for
real.

## Before you open a pull request

1. Run `npm run typecheck`, `npm run lint` and
   `KOBAY_01_DIST=skip npm run test:strict`.
2. **Say what you actually ran** in the pull request, with the last lines of
   the output. "Should work" is not a test result. If you could not run
   something (no Windows machine, no brain CLI), say that too.
3. If you changed behaviour, update `README.md` and add a line under
   `[Unreleased]` in `CHANGELOG.md`. The README states only behaviour that
   has been run; keep it that way.

CI runs the strict suite on Ubuntu for every push. The macOS and Windows jobs
only run in the public repository, so a pull request is where they first run.

## Conventions

- **Everything a machine reads is English**: CLI and MCP messages, JSON field
  names, error codes, file names, prompts, docs.
- **Source identifiers and code comments are Turkish, and stay that way.**
  Please do not rename them in a pull request; new code follows the same
  style as the file around it.
- Keep changes small and focused; one concern per pull request.
- Do not add a dependency without explaining why in the pull request.
