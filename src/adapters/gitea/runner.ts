import type { GhRunner, GhResult } from "../github/transport.ts";

/**
 * Gitea / Forgejo backend for the read-only history transport.
 *
 * `GhTransport` speaks `gh api` argv and parses an `--include` style reply, so
 * this runner implements the same `GhRunner` seam: it rewrites each allowlisted
 * GitHub path to the Gitea `/api/v1` equivalent, calls it with a token, and
 * reshapes the JSON to what `GitHubClient` expects. Endpoints Gitea lacks are
 * answered with a synthetic 404, which the sync already records as a missing
 * scope instead of fabricating evidence.
 */
export interface GiteaRunnerOptions {
  /** Instance root, for example `https://git.example.com` (an `/api/v1` suffix is accepted). */
  readonly baseUrl: string;
  readonly token: string | null;
  readonly fetch?: typeof fetch;
  /** Maps a bare workflow file name (`ci.yml`) to its repository path. */
  readonly workflowPath?: (file: string) => string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function giteaFromEnv(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; token: string | null } | null {
  const baseUrl = env.GITEA_URL ?? env.GITEA_BASE_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") return null;
  const token = env.GITEA_TOKEN ?? env.GITEA_ACCESS_TOKEN ?? null;
  return { baseUrl: baseUrl.trim(), token: token === null || token === "" ? null : token };
}

export function giteaHost(baseUrl: string): string {
  return new URL(baseUrl).host.toLowerCase();
}

function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
}

/** Stable positive integer for Gitea's string workflow ids (the file name). */
function workflowId(file: string): number {
  let hash = 2166136261;
  for (let index = 0; index < file.length; index += 1) {
    hash = Math.imul(hash ^ file.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function respond(status: number, body: string, headers: Record<string, string> = {}): GhResult {
  const lines = ["HTTP/1.1 " + String(status), ...Object.entries(headers).map(([key, value]) => key + ": " + value)];
  return { exitCode: 0, stdout: lines.join("\n") + "\n\n" + body, stderr: "" };
}

const notFound = (): GhResult => respond(404, JSON.stringify({ message: "not available on Gitea" }));

type Json = Record<string, unknown>;

function normalizeRun(run: Json, resolve: (file: string) => string): Json {
  const rawPath = typeof run.path === "string" ? run.path : "";
  const at = rawPath.indexOf("@");
  const file = at === -1 ? rawPath : rawPath.slice(0, at);
  const ref = at === -1 ? "" : rawPath.slice(at);
  const path = file.includes("/") || file === "" ? rawPath : resolve(file) + ref;
  const started = typeof run.started_at === "string" ? run.started_at : null;
  const completed = typeof run.completed_at === "string" ? run.completed_at : null;
  const created = typeof run.created_at === "string" ? run.created_at : started;
  return {
    ...run,
    name: typeof run.name === "string" ? run.name : typeof run.display_title === "string" ? run.display_title : null,
    path,
    ...(file === "" ? {} : { workflow_id: workflowId(file.split("/").at(-1) ?? file) }),
    head_branch: typeof run.head_branch === "string" ? run.head_branch : null,
    status: typeof run.status === "string" ? run.status : null,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    created_at: created ?? "",
    updated_at: typeof run.updated_at === "string" ? run.updated_at : completed ?? created ?? "",
    run_attempt: typeof run.run_attempt === "number" && run.run_attempt > 0 ? run.run_attempt : 1,
  };
}

function inCreatedRange(createdAt: unknown, filter: string | null): boolean {
  if (filter === null || typeof createdAt !== "string" || createdAt === "") return true;
  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) return true;
  const parse = (value: string) => Date.parse(value);
  if (filter.includes("..")) {
    const [from, to] = filter.split("..") as [string, string];
    return time >= parse(from) && time <= parse(to);
  }
  if (filter.startsWith(">=")) return time >= parse(filter.slice(2));
  if (filter.startsWith("<=")) return time <= parse(filter.slice(2));
  return true;
}

export function createGiteaRunner(options: GiteaRunnerOptions): GhRunner {
  const root = apiRoot(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const resolve = options.workflowPath ?? ((file: string) => ".gitea/workflows/" + file);

  return async (args, timeoutMs = DEFAULT_TIMEOUT_MS, signal) => {
    if (args.includes("--version")) {
      try {
        const response = await doFetch(root + "/version", { signal: AbortSignal.timeout(timeoutMs) });
        const body = (await response.json()) as { version?: string };
        return { exitCode: 0, stdout: "gh version gitea-" + (body.version ?? "unknown") + "\n", stderr: "" };
      } catch {
        return { exitCode: 0, stdout: "gh version gitea-unknown\n", stderr: "" };
      }
    }

    const target = args[args.length - 1] ?? "";
    const url = new URL(target, "http://gitea.invalid");
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) return notFound();
    const [, owner, repo, rest = ""] = match;
    const query = new URLSearchParams(url.search);
    if (query.has("per_page")) {
      query.set("limit", query.get("per_page")!);
      query.delete("per_page");
    }

    let path = rest;
    let createdFilter: string | null = null;
    let kind: "runs" | "run" | "jobs" | "workflows" | "plain" = "plain";
    if (/^\/actions\/runs$/.test(rest)) {
      kind = "runs";
      createdFilter = query.get("created");
      query.delete("created"); // Gitea has no created filter; applied below.
    } else if (/^\/actions\/runs\/\d+$/.test(rest)) {
      kind = "run";
    } else if (/^\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(rest)) {
      kind = "jobs";
      path = rest.replace(/\/attempts\/\d+/, "");
      query.delete("filter");
    } else if (rest === "/actions/workflows") {
      kind = "workflows";
    } else if (rest.startsWith("/actions/permissions/") || rest.startsWith("/rules/branches/")) {
      return notFound(); // No Gitea equivalent.
    } else if (rest.startsWith("/branches/") && rest.endsWith("/protection")) {
      path = "/branch_protections/" + rest.slice("/branches/".length, -"/protection".length);
    }

    const qs = query.toString();
    const endpoint = root + "/repos/" + owner + "/" + repo + path + (qs === "" ? "" : "?" + qs);
    const timeout = AbortSignal.timeout(timeoutMs);
    const controller = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token !== null) headers.Authorization = "token " + options.token;

    let response: Response;
    try {
      response = await doFetch(endpoint, { headers, signal: controller });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      const timedOut = timeout.aborted;
      return { exitCode: 1, stdout: "", stderr: "gitea request failed: " + String(error), ...(timedOut ? { timedOut: true } : {}) };
    }

    const text = await response.text();
    const outHeaders: Record<string, string> = {};
    for (const name of ["link", "etag", "retry-after", "x-total-count"]) {
      const value = response.headers.get(name);
      if (value !== null) outHeaders[name] = value;
    }
    if (!response.ok || text.trim() === "") return respond(response.status, text, outHeaders);

    let body: unknown;
    try { body = JSON.parse(text); } catch { return respond(response.status, text, outHeaders); }

    if (kind === "runs" && body !== null && typeof body === "object") {
      const list = (body as { workflow_runs?: unknown }).workflow_runs;
      if (Array.isArray(list)) {
        const runs = (list as Json[]).map((run) => normalizeRun(run, resolve))
          .filter((run) => inCreatedRange(run.created_at, createdFilter));
        body = { ...(body as Json), workflow_runs: runs };
      }
    } else if (kind === "run" && body !== null && typeof body === "object") {
      body = normalizeRun(body as Json, resolve);
    } else if (kind === "workflows" && body !== null && typeof body === "object") {
      const list = (body as { workflows?: unknown }).workflows;
      if (Array.isArray(list)) {
        body = {
          ...(body as Json),
          workflows: (list as Json[]).map((item) => {
            const file = typeof item.id === "string" ? item.id : String(item.path ?? "").split("/").at(-1) ?? "";
            return { ...item, id: workflowId(file), path: typeof item.path === "string" ? item.path : resolve(file) };
          }),
        };
      }
    } else if (kind === "jobs" && body !== null && typeof body === "object") {
      const list = (body as { jobs?: unknown }).jobs;
      if (Array.isArray(list)) {
        body = {
          ...(body as Json),
          jobs: (list as Json[]).map((job) => ({
            ...job,
            started_at: typeof job.started_at === "string" ? job.started_at : null,
            completed_at: typeof job.completed_at === "string" ? job.completed_at : null,
            labels: Array.isArray(job.labels) ? job.labels : [],
          })),
        };
      }
    }
    return respond(response.status, JSON.stringify(body), outHeaders);
  };
}
