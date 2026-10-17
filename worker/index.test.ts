import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

function makeEnv(): Env {
  return {
    ENVIRONMENT: "staging",
    CF_VERSION_METADATA: { id: "v-123", tag: "", timestamp: "" },
    ASSETS: {
      fetch: async () => new Response("asset"),
    } as unknown as Fetcher,
  };
}

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://example.test${path}`, init), makeEnv());

describe("worker", () => {
  it("reports environment and version on /api/health", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, environment: "staging", version: "v-123" });
  });

  it("rejects non-GET on /api/health", async () => {
    const res = await call("/api/health", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("falls through to static assets outside /api", async () => {
    const res = await call("/apiary");
    expect(await res.text()).toBe("asset");
  });
});
