# Copilot Instructions — rungrep

## What This Is

CLI tool (`rungrep`) that searches GitHub Actions workflow runs by partial name. Single-file TypeScript app in `src/index.ts` using Commander.js for arg parsing and the GitHub REST API.

## Architecture

- **Single entry point**: `src/index.ts` — all logic lives here (types, API calls, CLI definition, output formatting)
- **Auth chain**: `GITHUB_TOKEN` env var → `gh auth token` fallback via `execSync`
- **API wrapper**: `ghFetch<T>()` generic typed fetch against `api.github.com` with bearer auth and GitHub API version header
- **Flow**: parse CLI args → resolve optional workflow ID by name → fetch runs (with branch/status/workflow filters) → case-insensitive partial match on `display_title` → print table or JSON

## Dev Workflow

```bash
npm run dev -- "deploy" -r org/repo    # run via tsx (no build needed)
npm run build                           # tsc → dist/
npm start -- "deploy" -r org/repo       # run compiled output
```

## Conventions

- **ESM throughout**: `"type": "module"` in package.json, `"module": "Node16"` in tsconfig
- **Output**: use `process.stdout.write()` / `process.stderr.write()` — never `console.log`
- **Exit codes**: `0` success, `1` no results / not found, `2` user input error (bad status, bad repo format, missing auth)
- **Validation**: repo format checked with regex (`org/repo`), status checked against `runStatuses` const array
- **Types**: defined inline in `src/index.ts` — `WorkflowRun`, `WorkflowRunsResponse`, `Workflow`, `WorkflowsResponse`, `CliOptions`
- **Status values**: derived from `runStatuses` const tuple, with `RunStatus` type extracted via indexed access

## Key Patterns

- Commander `requiredOption` for `--repo`, regular `option` for optional filters
- `as const` tuple for run statuses → union type extraction: `type RunStatus = (typeof runStatuses)[number]`
- GitHub API pagination: currently fetches first 100 runs (`per_page=100`), filtering happens client-side
- Table output uses padded columns with `─` separator line; `--json` outputs array of `{name, date, url}`

## When Adding Features

- Keep the single-file structure unless complexity warrants splitting
- New CLI options go in the `CliOptions` interface and the Commander chain in the same order
- Validate user input early (before API calls), write errors to stderr, exit with code 2
- API types should match the GitHub REST API response shape — only include fields actually used
