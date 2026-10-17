/**
 * Cloudflare Worker entry point. Static assets (the Vite build in
 * `dist/`) are served directly by the Workers assets layer and never
 * reach this script — `run_worker_first` in wrangler.jsonc routes only
 * `/api/*` here. Everything else (routing engine, datasets, map) stays
 * client-side.
 */

export interface Env {
  ASSETS: Fetcher;
  /** "staging" | "production" — set per wrangler environment. */
  ENVIRONMENT: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...init?.headers },
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return json({
      ok: true,
      environment: env.ENVIRONMENT,
      version: env.CF_VERSION_METADATA?.id ?? null,
    });
  }

  // Unknown API routes get a JSON 404 rather than the SPA's index.html.
  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    // Only reachable if run_worker_first is widened; hand back to assets.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
