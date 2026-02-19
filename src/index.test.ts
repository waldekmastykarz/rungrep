import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDate,
  printRuns,
  fetchRuns,
  resolveWorkflowId,
  getToken,
  ghFetch,
  runStatuses,
  parseSince,
  GitHubApiError,
  formatApiError,
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

  it("throws GitHubApiError on non-ok responses", async () => {
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
    ).rejects.toThrow(GitHubApiError);

    await expect(
      ghFetch("/repos/org/repo/actions/runs", "token")
    ).rejects.toThrow("GitHub API 404: Not Found");
  });
});

// ── formatApiError ───────────────────────────────────────

describe("formatApiError", () => {
  it("formats 404 with repo-not-found message and suggestions", () => {
    const err = new GitHubApiError(404, "Not Found", "/repos/org/repo/actions/runs");
    const msg = formatApiError(err, "org/repo");
    expect(msg).toContain('Repository "org/repo" not found');
    expect(msg).toContain("Check the repository name for typos");
    expect(msg).toContain("Verify that the repository exists");
    expect(msg).toContain("token has access");
  });

  it("formats 401 with authentication failure message", () => {
    const err = new GitHubApiError(401, "Bad credentials", "/repos/org/repo/actions/runs");
    const msg = formatApiError(err, "org/repo");
    expect(msg).toContain('Authentication failed for repository "org/repo"');
    expect(msg).toContain("GITHUB_TOKEN is valid");
  });

  it("formats 403 with access denied message", () => {
    const err = new GitHubApiError(403, "Forbidden", "/repos/org/repo/actions/runs");
    const msg = formatApiError(err, "org/repo");
    expect(msg).toContain('Access denied to repository "org/repo"');
    expect(msg).toContain("'repo' scope");
  });

  it("formats unknown status codes with generic message", () => {
    const err = new GitHubApiError(500, "Internal Server Error", "/repos/org/repo/actions/runs");
    const msg = formatApiError(err, "org/repo");
    expect(msg).toContain("status 500");
    expect(msg).toContain("org/repo");
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

  it("passes created filter to API when since is provided", async () => {
    mockFetch([]);
    const since = new Date("2026-02-01T00:00:00Z");

    await fetchRuns("org/repo", { since }, "token");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("created=%3E%3D2026-02-01T00%3A00%3A00.000Z");
  });

  it("stops paginating when a run is older than since cutoff", async () => {
    const recentRun = makeRun({
      id: 1,
      created_at: "2026-02-15T10:00:00Z",
    });
    const oldRun = makeRun({
      id: 2,
      created_at: "2026-01-01T10:00:00Z",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            total_count: 2,
            workflow_runs: [recentRun, oldRun],
          }),
      })
    );

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await fetchRuns("org/repo", { since }, "token");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("uses workflow-specific endpoint when workflowId is provided", async () => {
    mockFetch([]);

    await fetchRuns("org/repo", { workflowId: 42 }, "token");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("/repos/org/repo/actions/workflows/42/runs");
  });

  it("slides time window when hitting 1000-run API cap", async () => {
    const batch1 = Array.from({ length: 100 }, (_, i) =>
      makeRun({ id: i + 1, created_at: "2026-02-10T10:00:00Z" })
    );
    const batch2 = [makeRun({ id: 1001, created_at: "2026-02-05T10:00:00Z" })];

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        // First 10 pages return 100 runs each (simulates 1000-run cap)
        if (callCount <= 10) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 1100,
                workflow_runs: batch1,
              }),
          });
        }
        // Page 11 returns 0 runs with total_count: 0 (real API behavior at cap)
        if (callCount === 11) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 0,
                workflow_runs: [],
              }),
          });
        }
        // Second batch (after sliding window)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              total_count: 1,
              workflow_runs: batch2,
            }),
        });
      })
    );

    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await fetchRuns("org/repo", {}, "token");
      // 100 unique runs from batch1 + 1 from batch2
      expect(result).toHaveLength(101);
      expect(result[result.length - 1].id).toBe(1001);

      // Second batch should use created<= full ISO timestamp (minus 1 second)
      const lastCallUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[
        (fetch as ReturnType<typeof vi.fn>).mock.calls.length - 1
      ][0];
      expect(lastCallUrl).toMatch(/created=%3C%3D2026-02-10T/);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("uses date range filter when sliding window with since", async () => {
    const batch1 = Array.from({ length: 100 }, (_, i) =>
      makeRun({ id: i + 1, created_at: "2026-02-10T10:00:00Z" })
    );

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 10) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 1100,
                workflow_runs: batch1,
              }),
          });
        }
        if (callCount === 11) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 1100,
                workflow_runs: [],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              total_count: 0,
              workflow_runs: [],
            }),
        });
      })
    );

    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const since = new Date("2026-02-01T00:00:00Z");
      await fetchRuns("org/repo", { since }, "token");

      // After sliding window, should use range filter: since..upperBound (both full ISO timestamps)
      const lastCallUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[
        (fetch as ReturnType<typeof vi.fn>).mock.calls.length - 1
      ][0];
      expect(lastCallUrl).toMatch(/created=2026-02-01T.*\.\.2026-02-10T/);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("deduplicates runs across sliding window batches", async () => {
    const sharedRuns = Array.from({ length: 100 }, (_, i) =>
      makeRun({ id: i + 1, created_at: "2026-02-10T10:00:00Z" })
    );

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 10) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 1100,
                workflow_runs: sharedRuns,
              }),
          });
        }
        if (callCount === 11) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                total_count: 1100,
                workflow_runs: [],
              }),
          });
        }
        // Second batch returns same IDs (overlap on date boundary)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              total_count: 50,
              workflow_runs: sharedRuns.slice(0, 50),
            }),
        });
      })
    );

    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const result = await fetchRuns("org/repo", {}, "token");
      // Should only have 100 unique runs, not 150
      expect(result).toHaveLength(100);
    } finally {
      process.stderr.write = origStderr;
    }
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

// ── parseSince ───────────────────────────────────────────

describe("parseSince", () => {
  it("parses days duration", () => {
    const before = new Date();
    before.setDate(before.getDate() - 7);
    const result = parseSince("7d");
    // Allow 1 second tolerance
    expect(Math.abs(result.getTime() - before.getTime())).toBeLessThan(1000);
  });

  it("parses hours duration", () => {
    const before = new Date();
    before.setHours(before.getHours() - 24);
    const result = parseSince("24h");
    expect(Math.abs(result.getTime() - before.getTime())).toBeLessThan(1000);
  });

  it("parses weeks duration", () => {
    const before = new Date();
    before.setDate(before.getDate() - 14);
    const result = parseSince("2w");
    expect(Math.abs(result.getTime() - before.getTime())).toBeLessThan(1000);
  });

  it("parses absolute date string", () => {
    const result = parseSince("2026-02-01");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // 0-indexed
    expect(result.getDate()).toBe(1);
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
