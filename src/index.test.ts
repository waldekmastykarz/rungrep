import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDate,
  printRuns,
  fetchRuns,
  resolveWorkflowId,
  getToken,
  ghFetch,
  runStatuses,
} from "./index.js";
import type { RunStatus } from "./index.js";

// ── helpers ──────────────────────────────────────────────

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "CI",
    display_title: "fix: update deps",
    html_url: "https://github.com/org/repo/actions/runs/1",
    created_at: "2026-01-15T10:30:00Z",
    updated_at: "2026-01-15T10:35:00Z",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    workflow_id: 42,
    ...overrides,
  };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

// ── formatDate ───────────────────────────────────────────

describe("formatDate", () => {
  it("returns a locale-formatted string for a valid ISO date", () => {
    const result = formatDate("2026-01-15T10:30:00Z");
    // Should contain the year at minimum
    expect(result).toContain("2026");
  });
});

// ── runStatuses ──────────────────────────────────────────

describe("runStatuses", () => {
  it("includes common workflow run statuses", () => {
    expect(runStatuses).toContain("completed");
    expect(runStatuses).toContain("in_progress");
    expect(runStatuses).toContain("success");
    expect(runStatuses).toContain("failure");
    expect(runStatuses).toContain("queued");
  });
});

// ── printRuns ────────────────────────────────────────────

describe("printRuns", () => {
  it("outputs JSON when asJson is true", () => {
    const runs = [makeRun()];
    const out = captureStdout(() => printRuns(runs, true));
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([
      {
        name: "fix: update deps",
        date: "2026-01-15T10:30:00Z",
        url: "https://github.com/org/repo/actions/runs/1",
      },
    ]);
  });

  it("outputs a table with header and separator when asJson is false", () => {
    const runs = [makeRun()];
    const out = captureStdout(() => printRuns(runs, false));
    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBe(3); // header, separator, data row
    expect(lines[0]).toMatch(/^NAME\s+DATE\s+URL$/);
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toContain("fix: update deps");
    expect(lines[2]).toContain("https://github.com/org/repo/actions/runs/1");
  });

  it("handles multiple runs", () => {
    const runs = [
      makeRun({ display_title: "first run" }),
      makeRun({ display_title: "second run", id: 2 }),
    ];
    const out = captureStdout(() => printRuns(runs, false));
    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 data rows
  });
});

// ── ghFetch ──────────────────────────────────────────────

describe("ghFetch", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: "ok" }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the correct URL with auth headers", async () => {
    await ghFetch("/repos/org/repo/actions/runs", "test-token");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/org/repo/actions/runs",
      {
        headers: {
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
  });

  it("throws on non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      })
    );

    await expect(
      ghFetch("/repos/org/repo/actions/runs", "token")
    ).rejects.toThrow("GitHub API 404: Not Found");
  });
});

// ── fetchRuns ────────────────────────────────────────────

describe("fetchRuns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(runs: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            total_count: runs.length,
            workflow_runs: runs,
          }),
      })
    );
  }

  it("fetches runs for a repo", async () => {
    const run = makeRun();
    mockFetch([run]);

    const result = await fetchRuns("org/repo", {}, "token");
    expect(result).toEqual([run]);

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("/repos/org/repo/actions/runs");
    expect(calledUrl).toContain("per_page=100");
    expect(calledUrl).toContain("page=1");
  });

  it("paginates until a page returns fewer than 100 runs", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeRun({ id: i + 1 })
    );
    const lastPage = [makeRun({ id: 101 }), makeRun({ id: 102 })];

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              total_count: 102,
              workflow_runs: fullPage,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              total_count: 102,
              workflow_runs: lastPage,
            }),
        })
    );

    const result = await fetchRuns("org/repo", {}, "token");
    expect(result).toHaveLength(102);
    expect(fetch).toHaveBeenCalledTimes(2);

    const firstUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstUrl).toContain("page=1");
    const secondUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondUrl).toContain("page=2");
  });

  it("includes branch filter in query params", async () => {
    mockFetch([]);

    await fetchRuns("org/repo", { branch: "main" }, "token");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("branch=main");
  });

  it("includes status filter in query params", async () => {
    mockFetch([]);

    await fetchRuns("org/repo", { status: "success" }, "token");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("status=success");
  });

  it("uses workflow-specific endpoint when workflowId is provided", async () => {
    mockFetch([]);

    await fetchRuns("org/repo", { workflowId: 42 }, "token");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("/repos/org/repo/actions/workflows/42/runs");
  });
});

// ── resolveWorkflowId ────────────────────────────────────

describe("resolveWorkflowId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockWorkflows(workflows: { id: number; name: string }[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            total_count: workflows.length,
            workflows,
          }),
      })
    );
  }

  it("returns the workflow id for an exact case-insensitive match", async () => {
    mockWorkflows([
      { id: 1, name: "CI" },
      { id: 2, name: "Deploy" },
    ]);

    const id = await resolveWorkflowId("org/repo", "ci", "token");
    expect(id).toBe(1);
  });

  it("returns undefined when no workflow matches", async () => {
    mockWorkflows([{ id: 1, name: "CI" }]);

    const id = await resolveWorkflowId("org/repo", "deploy", "token");
    expect(id).toBeUndefined();
  });
});

// ── getToken ─────────────────────────────────────────────

describe("getToken", () => {
  const originalEnv = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_TOKEN = originalEnv;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("returns GITHUB_TOKEN from env when set", () => {
    process.env.GITHUB_TOKEN = "env-token-123";
    expect(getToken()).toBe("env-token-123");
  });
});

// ── input validation patterns ────────────────────────────

describe("input validation", () => {
  const repoRegex = /^[^/]+\/[^/]+$/;

  it("accepts valid repo formats", () => {
    expect(repoRegex.test("org/repo")).toBe(true);
    expect(repoRegex.test("my-org/my-repo")).toBe(true);
  });

  it("rejects invalid repo formats", () => {
    expect(repoRegex.test("justrepo")).toBe(false);
    expect(repoRegex.test("org/repo/extra")).toBe(false);
    expect(repoRegex.test("/repo")).toBe(false);
    expect(repoRegex.test("org/")).toBe(false);
  });

  it("validates status against known values", () => {
    expect(runStatuses.includes("success" as RunStatus)).toBe(true);
    expect(
      runStatuses.includes("bogus" as unknown as RunStatus)
    ).toBe(false);
  });
});

// ── run filtering logic ──────────────────────────────────

describe("run filtering", () => {
  const runs = [
    makeRun({ display_title: "fix: update deps" }),
    makeRun({ display_title: "feat: add new feature", id: 2 }),
    makeRun({ display_title: "Fix: Update Deps (retry)", id: 3 }),
  ];

  function filterRuns(needle: string) {
    const lower = needle.toLowerCase();
    return runs.filter((r) => r.display_title.toLowerCase().includes(lower));
  }

  it("matches case-insensitively", () => {
    expect(filterRuns("FIX")).toHaveLength(2);
    expect(filterRuns("fix")).toHaveLength(2);
  });

  it("matches partial titles", () => {
    expect(filterRuns("new feat")).toHaveLength(1);
  });

  it("returns empty when nothing matches", () => {
    expect(filterRuns("zzz-no-match")).toHaveLength(0);
  });
});
