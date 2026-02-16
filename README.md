# rungrep

> `grep` for GitHub Actions runs. Find workflow runs by partial name from your terminal.

Ever scrolled through pages of workflow runs looking for that one build? `rungrep` lets you search by partial name, filter by branch/status/workflow, and get a direct link to open in your browser.

```bash
$ rungrep "deploy api" -r myorg/backend -l
NAME                          DATE                   URL
──────────────────────────────────────────────────────────
deploy api to production v3   2/15/2026, 8:22:45 PM  https://github.com/myorg/backend/actions/runs/22041593851
```

## Install

```bash
npm install -g rungrep
```

## Quick start

```bash
# Find runs matching "deploy" in a repo
rungrep "deploy" -r org/repo

# Get the latest matching run on main
rungrep "deploy" -r org/repo -b main -l

# Filter by workflow and status
rungrep "deploy" -r org/repo -a "CI" -s success

# Top 5 matching runs
rungrep "deploy" -r org/repo -t 5

# Search runs from last 30 days (default: 7d)
rungrep "deploy" -r org/repo --since 30d

# Open latest matching run in browser
rungrep "deploy" -r org/repo -l --open

# JSON output — pipe to jq, use in scripts
rungrep "deploy" -r org/repo -l --json
```

## Auth

Uses `GITHUB_TOKEN` env var. Falls back to the [GitHub CLI](https://cli.github.com/) (`gh auth token`) if installed.

## Options

```
rungrep <name> --repo <org/repo> [options]
```

| Option | Description |
|---|---|
| `<name>` | Partial run name to match (required) |
| `-r, --repo <org/repo>` | GitHub repository (required) |
| `-b, --branch <branch>` | Filter by branch |
| `-a, --action <workflow>` | Filter by workflow name |
| `-s, --status <status>` | Filter by run status (see below) |
| `-t, --top <n>` | Return top N matching runs |
| `-l, --last` | Return only the latest match |
| `--since <duration\|date>` | Only search runs newer than duration (`7d`, `24h`, `2w`) or date (`2026-02-01`). Default: `7d` |
| `--open` | Open the run in browser (requires exactly one match, or combine with `-l`) |
| `--json` | Output as JSON |
| `--debug` | Show diagnostic info on stderr |

<details>
<summary>Valid statuses</summary>

`completed` `action_required` `cancelled` `failure` `neutral` `skipped` `stale` `success` `timed_out` `in_progress` `queued` `requested` `waiting` `pending`

</details>

## License

[MIT](LICENSE)
