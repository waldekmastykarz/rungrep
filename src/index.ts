#!/usr/bin/env node

import { program } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ora from "ora";

export const runStatuses = [
  "completed",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "in_progress",
  "queued",
  "requested",
  "waiting",
  "pending",
] as const;

export type RunStatus = (typeof runStatuses)[number];

interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  workflow_id: number;
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

interface Workflow {
  id: number;
  name: string;
}

interface WorkflowsResponse {
  total_count: number;
  workflows: Workflow[];
}

interface CliOptions {
  repo: string;
  branch?: string;
  action?: string;
  status?: RunStatus;
  top?: string;
  since?: string;
  last: boolean;
  json: boolean;
  open: boolean;
  debug: boolean;
}

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly path: string;

  constructor(status: number, body: string, path: string) {
    super(`GitHub API ${status}: ${body}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
  }
}

export function formatApiError(err: GitHubApiError, repo: string): string {
  const lines: string[] = [];

  switch (err.status) {
    case 401:
      lines.push(
        `Error: Authentication failed for repository "${repo}".`,
        "Suggestions:",
        "  - Verify that your GITHUB_TOKEN is valid and not expired",
        "  - Run `gh auth status` to check your GitHub CLI authentication",
        "  - Generate a new token at https://github.com/settings/tokens"
      );
      break;
    case 403:
      lines.push(
        `Error: Access denied to repository "${repo}".`,
        "Suggestions:",
        "  - Check that your token has the 'repo' scope (or 'actions:read' for fine-grained tokens)",
        "  - Verify that you have access to this repository",
        "  - If using a fine-grained token, ensure it is authorized for this repository"
      );
      break;
    case 404:
      lines.push(
        `Error: Repository "${repo}" not found.`,
        "Suggestions:",
        "  - Check the repository name for typos (expected format: owner/repo)",
        "  - Verify that the repository exists on GitHub",
        "  - If the repository is private, ensure your token has access to it"
      );
      break;
    default:
      lines.push(
        `Error: GitHub API responded with status ${err.status} for repository "${repo}".`,
        `Details: ${err.message}`
      );
      break;
  }

  return lines.join("\n") + "\n";
}

let debugEnabled = false;

function debug(msg: string): void {
  if (debugEnabled) {
    process.stderr.write(`[debug] ${msg}\n`);
  }
}

export function parseSince(value: string): Date {
  const match = value.match(/^(\d+)([hdw])$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const now = new Date();
    switch (unit) {
      case "h":
        now.setHours(now.getHours() - amount);
        break;
      case "d":
        now.setDate(now.getDate() - amount);
        break;
      case "w":
        now.setDate(now.getDate() - amount * 7);
        break;
    }
    return now;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    process.stderr.write(
      `Error: Invalid --since value "${value}". Use a duration (7d, 24h, 2w) or date (2026-02-01).\n`
    );
    process.exit(2);
  }
  return date;
}

export function getToken(): string {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    debug("Auth: using GITHUB_TOKEN env var");
    return envToken;
  }

  try {
    debug("Auth: falling back to `gh auth token`");
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    process.stderr.write(
      "Error: No GITHUB_TOKEN env var and `gh auth token` failed.\n" +
        "Set GITHUB_TOKEN or install/authenticate the GitHub CLI.\n"
    );
    process.exit(2);
  }
}

export async function ghFetch<T>(path: string, token: string): Promise<T> {
  const url = `https://api.github.com${path}`;
  debug(`GET ${url}`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  debug(`Response: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text();
    throw new GitHubApiError(res.status, body, path);
  }

  return res.json() as Promise<T>;
}

export async function resolveWorkflowId(
  repo: string,
  workflowName: string,
  token: string
): Promise<number | undefined> {
  const data = await ghFetch<WorkflowsResponse>(
    `/repos/${repo}/actions/workflows`,
    token
  );
  const needle = workflowName.toLowerCase();
  const match = data.workflows.find(
    (w) => w.name.toLowerCase() === needle
  );
  return match?.id;
}

export async function fetchRuns(
  repo: string,
  opts: { branch?: string; status?: RunStatus; workflowId?: number; since?: Date },
  token: string,
  onProgress?: (fetched: number, total: number) => void
): Promise<WorkflowRun[]> {
  const basePath = opts.workflowId
    ? `/repos/${repo}/actions/workflows/${opts.workflowId}/runs`
    : `/repos/${repo}/actions/runs`;

  const allRuns: WorkflowRun[] = [];
  const seenIds = new Set<number>();
  let upperBound: string | undefined;
  let overallTotal = 0;

  while (true) {
    const params = new URLSearchParams();
    if (opts.branch) params.set("branch", opts.branch);
    if (opts.status) params.set("status", opts.status);
    params.set("per_page", "100");

    const sincePart = opts.since?.toISOString();
    if (sincePart && upperBound) {
      params.set("created", `${sincePart}..${upperBound}`);
    } else if (sincePart) {
      params.set("created", `>=${sincePart}`);
    } else if (upperBound) {
      params.set("created", `<=${upperBound}`);
    }

    let batchNewRuns = 0;
    let batchSkipped = 0;
    let maxTotalCount = 0;
    let page = 1;
    let hitSinceCutoff = false;

    while (true) {
      params.set("page", String(page));
      const path = `${basePath}?${params.toString()}`;

      const data = await ghFetch<WorkflowRunsResponse>(path, token);
      if (data.total_count > maxTotalCount) maxTotalCount = data.total_count;
      if (maxTotalCount > overallTotal) overallTotal = maxTotalCount;
      debug(`Page ${page}: fetched ${data.workflow_runs.length} runs (total_count: ${data.total_count})`);
      onProgress?.(allRuns.length, overallTotal);

      for (const run of data.workflow_runs) {
        if (opts.since && new Date(run.created_at).getTime() < opts.since.getTime()) {
          debug(`Stopping pagination: run ${run.id} older than --since cutoff`);
          hitSinceCutoff = true;
          break;
        }
        if (!seenIds.has(run.id)) {
          seenIds.add(run.id);
          allRuns.push(run);
          batchNewRuns++;
        } else {
          batchSkipped++;
        }
      }

      if (hitSinceCutoff) break;
      if (data.workflow_runs.length < 100) break;
      page++;
    }

    debug(`Batch: ${batchNewRuns} new, ${batchSkipped} duplicates skipped`);

    if (maxTotalCount <= 1000 || hitSinceCutoff) break;
    if (batchNewRuns === 0) break;

    let oldestTime = Infinity;
    for (const run of allRuns) {
      const t = new Date(run.created_at).getTime();
      if (t < oldestTime) oldestTime = t;
    }
    const oldestDate = new Date(oldestTime);
    oldestDate.setSeconds(oldestDate.getSeconds() - 1);
    upperBound = oldestDate.toISOString();
    debug(`Sliding window: upper bound set to ${upperBound}`);
  }

  debug(`Total fetched: ${allRuns.length} runs`);
  return allRuns;
}



export function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  execFileSync(cmd, [url], { stdio: "ignore" });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function printRuns(runs: WorkflowRun[], asJson: boolean): void {
  if (asJson) {
    const output = runs.map((r) => ({
      name: r.display_title,
      date: r.created_at,
      url: r.html_url,
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  const maxName = Math.max(...runs.map((r) => r.display_title.length), 4);
  const maxDate = Math.max(
    ...runs.map((r) => formatDate(r.created_at).length),
    4
  );

  const header = `${"NAME".padEnd(maxName)}  ${"DATE".padEnd(maxDate)}  URL`;
  process.stdout.write(header + "\n");
  process.stdout.write("─".repeat(header.length) + "\n");

  for (const r of runs) {
    const line = `${r.display_title.padEnd(maxName)}  ${formatDate(r.created_at).padEnd(maxDate)}  ${r.html_url}`;
    process.stdout.write(line + "\n");
  }
}

program
  .name("rungrep")
  .description("Find GitHub workflow runs by partial name")
  .version("1.0.0")
  .argument("<name>", "Partial run name to match")
  .requiredOption("-r, --repo <org/repo>", "GitHub repository (org/repo)")
  .option("-b, --branch <branch>", "Filter by branch")
  .option("-a, --action <workflow>", "Workflow name to search within")
  .option(
    "-s, --status <status>",
    `Filter by status (${runStatuses.join(", ")})`
  )
  .option("-t, --top <n>", "Return top N matching runs")
  .option("-l, --last", "Return only the latest matching run", false)
  .option(
    "--since <duration|date>",
    "Only search runs newer than duration (7d, 24h, 2w) or date (2026-02-01). Default: 7d"
  )
  .option("--open", "Open the run in browser (requires exactly one match)", false)
  .option("--json", "Output as JSON", false)
  .option("--debug", "Show diagnostic info on stderr", false)
  .addHelpText(
    "after",
    `
Examples:
  rungrep "deploy" -r org/repo                  Search runs matching "deploy" (last 7 days)
  rungrep "deploy" -r org/repo --since 30d      Search runs from last 30 days
  rungrep "deploy" -r org/repo -t 5             Top 5 matching runs
  rungrep "deploy" -r org/repo -l --json        Latest matching run as JSON
  rungrep "deploy" -r org/repo -l --open        Open latest matching run in browser
  rungrep "fix" -r org/repo -s success          Only successful runs matching "fix"

Auth:
  Uses GITHUB_TOKEN env var, or falls back to \`gh auth token\`.

JSON output schema:
  [{ "name": "...", "date": "ISO-8601", "url": "https://..." }]

Exit codes:
  0  Matching runs found
  1  No matches or workflow not found
  2  Invalid input (bad repo format, bad status, missing auth)

Notes:
  Name matching is case-insensitive and partial (substring match).
  Results are ordered newest-first. --last returns the single newest match.
  Primary output goes to stdout; errors and progress to stderr.`
  )
  .action(async (name: string, opts: CliOptions) => {
    debugEnabled = opts.debug;

    if (opts.debug) {
      debug(`name: "${name}"`);
      debug(`repo: ${opts.repo}`);
      if (opts.branch) debug(`branch: ${opts.branch}`);
      if (opts.action) debug(`action: ${opts.action}`);
      if (opts.status) debug(`status: ${opts.status}`);
      if (opts.top) debug(`top: ${opts.top}`);
      debug(`since: ${opts.since ?? "7d (default)"}`);
    }

    if (opts.status && !runStatuses.includes(opts.status)) {
      process.stderr.write(
        `Error: Invalid status "${opts.status}". Valid values: ${runStatuses.join(", ")}\n`
      );
      process.exit(2);
    }

    if (!/^[^/]+\/[^/]+$/.test(opts.repo)) {
      process.stderr.write(
        `Error: Invalid repo format "${opts.repo}". Expected org/repo.\n`
      );
      process.exit(2);
    }

    let top: number | undefined;
    if (opts.top) {
      top = parseInt(opts.top, 10);
      if (isNaN(top) || top < 1) {
        process.stderr.write(
          `Error: Invalid --top value "${opts.top}". Must be a positive integer.\n`
        );
        process.exit(2);
      }
    }

    const sinceValue = opts.since ?? (top ? undefined : "7d");
    const sinceDate = sinceValue ? parseSince(sinceValue) : undefined;
    if (sinceDate) {
      debug(`Since cutoff: ${sinceDate.toISOString()}`);
    }

    const token = getToken();
    let workflowId: number | undefined;

    const spinner = ora({ text: "Searching runs…", stream: process.stderr }).start();

    try {
      if (opts.action) {
        workflowId = await resolveWorkflowId(opts.repo, opts.action, token);
        if (!workflowId) {
          spinner.stop();
          process.stderr.write(
            `Error: Workflow "${opts.action}" not found in ${opts.repo}.\n`
          );
          process.exit(1);
        }
      }

      var runs = await fetchRuns(
        opts.repo,
        { branch: opts.branch, status: opts.status, workflowId, since: sinceDate },
        token,
        (fetched, total) => {
          spinner.text = `Searching runs… ${fetched}/${total}`;
        }
      );
    } catch (err) {
      if (err instanceof GitHubApiError) {
        spinner.fail();
        process.stderr.write(formatApiError(err, opts.repo));
        process.exit(1);
      }
      throw err;
    } finally {
      spinner.stop();
    }

    const needle = name.toLowerCase();
    debug(`Filtering ${runs.length} runs for "${needle}"`);
    let matches = runs.filter((r) =>
      r.display_title.toLowerCase().includes(needle)
    );
    debug(`Found ${matches.length} matching runs`);

    if (matches.length === 0) {
      process.stderr.write("No matching runs found.\n");
      process.exit(1);
    }

    if (opts.last) {
      matches = [matches[0]];
    } else if (top) {
      matches = matches.slice(0, top);
    }

    if (opts.open) {
      if (matches.length === 1) {
        printRuns(matches, opts.json);
        openUrl(matches[0].html_url);
        return;
      }

      process.stderr.write(
        `Error: --open requires exactly one match, but found ${matches.length}.\n`
      );
      printRuns(matches, opts.json);
      process.exit(1);
    }

    printRuns(matches, opts.json);
  });

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  program.parse();
}
