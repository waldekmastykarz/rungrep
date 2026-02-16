# Copilot Instructions — rungrep

## What This Is

CLI tool (`rungrep`) that searches GitHub Actions workflow runs by partial name. Single-file TypeScript app in `src/index.ts` using Commander.js for arg parsing and the GitHub REST API.

## Architecture

- **Single entry point**: `src/index.ts` — all logic lives here (types, API calls, CLI definition, output formatting)
- **Auth chain**: `GITHUB_TOKEN` env var → `gh auth token` fallback via `execSync`
- **API wrapper**: `ghFetch<T>()` generic typed fetch against `api.github.com` with bearer auth and GitHub API version header
- **Flow**: parse CLI args → validate input → resolve optional workflow ID by name → fetch runs with pagination (with branch/status/workflow/since filters) → case-insensitive partial match on `display_title` → apply `--last`/`--top` limits → print table or JSON → optionally open URL
- **Testability guard**: `program.parse()` only runs when executed directly (`process.argv[1] === fileURLToPath(import.meta.url)`), so tests can import functions without triggering CLI parsing

## Dev Workflow

```bash
npm run dev -- "deploy" -r org/repo    # run via tsx (no build needed)
npm run build                           # tsc → dist/
npm start -- "deploy" -r org/repo       # run compiled output
npm test                                # vitest run (single pass)
```

## Conventions

- **ESM throughout**: `"type": "module"` in package.json, `"module": "Node16"` in tsconfig
- **Output**: use `process.stdout.write()` / `process.stderr.write()` — never `console.log`
- **Exit codes**: `0` success, `1` no results / not found, `2` user input error (bad status, bad repo format, missing auth)
- **Validation**: repo format checked with regex (`org/repo`), status checked against `runStatuses` const array. Validate early (before API calls), errors to stderr
- **Types**: defined inline in `src/index.ts` — `WorkflowRun`, `WorkflowRunsResponse`, `Workflow`, `WorkflowsResponse`, `CliOptions`
- **Status values**: derived from `runStatuses` const tuple, with `RunStatus` type extracted via indexed access
- **Pagination**: `fetchRuns` paginates through all pages (100 per page), stops early when `--since` cutoff is reached
- **Default `--since`**: 7 days when no `--top` is specified; omitted when `--top` is set

## Testing

Tests live in `src/index.test.ts` using **vitest**. Run with `npm test`.

- **Unit-test exported functions** — `ghFetch`, `fetchRuns`, `resolveWorkflowId`, `getToken`, `parseSince`, `formatDate`, `printRuns` are all exported and tested individually
- **Mock `fetch` globally** via `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(...))` — always `vi.unstubAllGlobals()` in `afterEach`
- **`makeRun()` helper** — creates a default `WorkflowRun` object, accepts `overrides` partial for test-specific fields
- **`captureStdout()` helper** — temporarily replaces `process.stdout.write` to capture output, restores after callback
- **No CLI integration tests** — tests target individual functions, not the Commander action handler
- **Filtering logic** tested by reimplementing the same case-insensitive substring match used in the action handler

## Key Patterns

- Commander `requiredOption` for `--repo`, regular `option` for optional filters
- `as const` tuple for run statuses → union type extraction: `type RunStatus = (typeof runStatuses)[number]`
- Table output uses padded columns with `─` separator line; `--json` outputs array of `{name, date, url}`
- TTY-aware spinner on stderr (disabled when not a TTY)
- `--open` uses platform-specific command (`open`/`start`/`xdg-open`) via `execFileSync`
- `--debug` enables diagnostic output to stderr via `debug()` helper

## When Adding Features

- Keep the single-file structure unless complexity warrants splitting
- New CLI options go in the `CliOptions` interface and the Commander chain in the same order
- Export new functions for testability; add tests using the same mocking patterns in `index.test.ts`
- Validate user input early (before API calls), write errors to stderr, exit with code 2
- API types should match the GitHub REST API response shape — only include fields actually used
