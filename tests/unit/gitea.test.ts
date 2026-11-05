import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGiteaRunner, giteaFromEnv, giteaHost } from "../../src/adapters/gitea/runner.ts";
import { GhTransport } from "../../src/adapters/github/transport.ts";
import { GitHubClient } from "../../src/adapters/github/client.ts";
import { RequestBudget } from "../../src/adapters/github/budget.ts";
import { discoverWorkflows } from "../../src/core/scan/discover.ts";
import { parseGithubRemote } from "../../src/core/scan/binding.ts";
import { DEFAULT_CONFIG } from "../../src/core/data/default-config.ts";

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url + "|" + JSON.stringify(init?.headers ?? {}));
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (key === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { link: '<x>; rel="next"' } });
  }) as typeof fetch;
}

function client(routes: Record<string, unknown>, seen: string[] = []) {
  const runner = createGiteaRunner({ baseUrl: "https://git.example.com", token: "tok", fetch: fakeFetch(routes, seen) });
  const budget = new RequestBudget(DEFAULT_CONFIG.history.quotas, 100);
  return new GitHubClient(new GhTransport({ budget, runner, retries: 0, cache: false }), "o", "r");
}

test("remote parsing accepts an allowed Gitea host, including ssh ports", () => {
  assert.equal(parseGithubRemote("https://git.example.com/o/r.git"), null);
  const https = parseGithubRemote("https://tok@git.example.com/o/r.git", ["git.example.com"]);
  assert.deepEqual([https?.host, https?.owner, https?.repository], ["git.example.com", "o", "r"]);
  assert.equal(parseGithubRemote("ssh://git@git.example.com:2222/o/r.git", ["git.example.com"])?.fullName, "o/r");
  assert.equal(parseGithubRemote("git@github.com:o/r.git")?.host, "github.com");
});

test("env config and host", () => {
  assert.equal(giteaFromEnv({}), null);
  const cfg = giteaFromEnv({ GITEA_URL: "https://git.example.com/", GITEA_TOKEN: "t" });
  assert.equal(cfg?.token, "t");
  assert.equal(giteaHost("https://Git.Example.com:8443/x"), "git.example.com:8443");
});

test("runs are normalized, rewritten to /api/v1 and filtered by created range", async () => {
  const seen: string[] = [];
  const c = client({
    "/actions/runs": {
      total_count: 2,
      workflow_runs: [
        { id: 1, path: "ci.yml@refs/heads/main", head_sha: "a".repeat(40), head_branch: "main", event: "push", status: "completed", conclusion: "success", started_at: "2026-11-01T10:00:00Z", completed_at: "2026-11-01T10:05:00Z", display_title: "t" },
        { id: 2, path: "ci.yml@refs/heads/main", head_sha: "b".repeat(40), head_branch: "main", event: "push", status: "completed", conclusion: "success", started_at: "2026-01-01T10:00:00Z" },
      ],
    },
  }, seen);
  const page = await c.runs({ page: 1, perPage: 50, createdAfter: "2026-10-01T00:00:00Z" });
  assert.equal(page.items.length, 1);
  const run = page.items[0]!;
  assert.equal(run.path, ".gitea/workflows/ci.yml@refs/heads/main");
  assert.equal(run.created_at, "2026-11-01T10:00:00Z");
  assert.equal(run.run_attempt, 1);
  assert.equal(typeof run.workflow_id, "number");
  assert.equal(page.hasNext, true);
  assert.ok(seen[0]!.startsWith("https://git.example.com/api/v1/repos/o/r/actions/runs?"));
  assert.ok(seen[0]!.includes("limit=50") && !seen[0]!.includes("created") && seen[0]!.includes("token tok"));
});

test("workflow ids become numeric and match run.workflow_id", async () => {
  const c = client({
    "/actions/workflows": { workflows: [{ id: "ci.yml", name: "CI", path: ".gitea/workflows/ci.yml", state: "active" }] },
    "/actions/runs": { workflow_runs: [{ id: 1, path: "ci.yml@refs/heads/main", status: "completed", started_at: "2026-11-01T10:00:00Z" }] },
  });
  const wf = (await c.workflows(1, 10)).items[0]!;
  const run = (await c.runs({ page: 1, perPage: 10 })).items[0]!;
  assert.equal(wf.id, run.workflow_id);
});

test("jobs drop /attempts and default nullable fields", async () => {
  const seen: string[] = [];
  const c = client({ "/actions/runs/7/jobs": { total_count: 1, jobs: [{ id: 9, name: "build", status: "completed", conclusion: "success", started_at: "2026-11-01T10:00:00Z" }] } }, seen);
  const jobs = await c.attemptJobs(7, 1, 1, 100);
  assert.equal(jobs.items[0]!.completed_at, null);
  assert.deepEqual(jobs.items[0]!.labels, []);
  assert.ok(!seen[0]!.includes("attempts"));
});

test("endpoints Gitea lacks answer 404 without a network call", async () => {
  const seen: string[] = [];
  const c = client({}, seen);
  await assert.rejects(() => c.retentionPolicy(), /not found/i);
  await assert.rejects(() => c.branchRules("main"), /not found/i);
  assert.equal(seen.length, 0);
});

test("discovery prefers .gitea over .github", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-gitea-"));
  for (const dir of [".gitea", ".github"]) {
    mkdirSync(join(root, dir, "workflows"), { recursive: true });
    writeFileSync(join(root, dir, "workflows", dir.slice(1) + ".yml"), "name: x\non: push\njobs: {}\n");
  }
  assert.deepEqual(discoverWorkflows(root).workflows.map((w) => w.path), [".gitea/workflows/gitea.yml"]);
  const only = mkdtempSync(join(tmpdir(), "ci-diet-gh-"));
  mkdirSync(join(only, ".github", "workflows"), { recursive: true });
  writeFileSync(join(only, ".github", "workflows", "a.yml"), "name: a\non: push\njobs: {}\n");
  assert.deepEqual(discoverWorkflows(only).workflows.map((w) => w.path), [".github/workflows/a.yml"]);
});
