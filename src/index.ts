#!/usr/bin/env node

import { program } from "commander";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  last: boolean;
  json: boolean;
  open: boolean;
}

export function getToken(): string {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
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
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
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
  opts: { branch?: string; status?: RunStatus; workflowId?: number },
  token: string
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams();
  if (opts.branch) params.set("branch", opts.branch);
  if (opts.status) params.set("status", opts.status);
  params.set("per_page", "100");

  const basePath = opts.workflowId
    ? `/repos/${repo}/actions/workflows/${opts.workflowId}/runs`
    : `/repos/${repo}/actions/runs`;

  const qs = params.toString();
  const path = qs ? `${basePath}?${qs}` : basePath;

  const data = await ghFetch<WorkflowRunsResponse>(path, token);
  return data.workflow_runs;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createSpinner(message: string) {
  if (!process.stderr.isTTY) {
    return { stop() {} };
  }

  let i = 0;
  const id = setInterval(() => {
    process.stderr.write(`\r${spinnerFrames[i++ % spinnerFrames.length]} ${message}`);
  }, 80);

  return {
    stop() {
      clearInterval(id);
      process.stderr.write("\r\x1b[K");
    },
  };
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
  .option("-l, --last", "Return only the latest matching run", false)
  .option("--open", "Open the run in browser (requires exactly one match)", false)
  .option("--json", "Output as JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  rungrep "deploy" -r org/repo                  Search runs matching "deploy"
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

    const token = getToken();
    let workflowId: number | undefined;

    const spinner = createSpinner("Searching runs…");

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
        { branch: opts.branch, status: opts.status, workflowId },
        token
      );
    } finally {
      spinner.stop();
    }

    const needle = name.toLowerCase();
    let matches = runs.filter((r) =>
      r.display_title.toLowerCase().includes(needle)
    );

    if (matches.length === 0) {
      process.stderr.write("No matching runs found.\n");
      process.exit(1);
    }

    if (opts.last) {
      matches = [matches[0]];
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  program.parse();
}
