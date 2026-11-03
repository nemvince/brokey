import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { windowStart } from "../src/server/proxy/limits.ts";
import type { StatsResponse } from "../src/shared/types.ts";
import {
  adminJson,
  insertUsageLog,
  seedClientKey,
  seedModel,
  seedProvider,
  startTestApp,
  type TestApp,
} from "./helpers.ts";

describe("public statistics", () => {
  let app: TestApp;
  let alphaProviderId: number;
  let betaProviderId: number;
  let clientKeyId: number;
  let clientKeyLabel = "ck";
  let clientKeyToken: string;

  const stats = async (range: string): Promise<StatsResponse> => {
    const response = await fetch(`${app.baseUrl}/api/stats?range=${range}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as StatsResponse;
  };

  beforeAll(async () => {
    app = startTestApp();
    const alpha = await seedProvider(app, {
      name: "alpha",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    alphaProviderId = alpha.providerId;
    const beta = await seedProvider(app, {
      name: "beta",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    betaProviderId = beta.providerId;
    const alphaModel = await seedModel(app, alphaProviderId, {
      upstreamId: "a-1",
      publicId: "alpha-1",
    });
    const betaModel = await seedModel(app, betaProviderId, {
      upstreamId: "b-1",
      publicId: "beta-1",
    });
    const clientKey = await seedClientKey(app, { name: "ck" });
    clientKeyId = clientKey.id;
    clientKeyToken = clientKey.token;

    const now = Date.now();
    const todayMid = windowStart("day", now) as number;

    insertUsageLog(app, {
      clientKeyId,
      clientKeyLabel: "ck",
      providerId: alphaProviderId,
      providerName: "alpha",
      modelId: alphaModel.id,
      modelPublicId: "alpha-1",
      promptTokens: 6,
      completionTokens: 4,
      totalTokens: 10,
      status: 200,
      createdAt: todayMid + 1,
    });
    insertUsageLog(app, {
      clientKeyId,
      clientKeyLabel: "ck",
      providerId: alphaProviderId,
      providerName: "alpha",
      modelId: alphaModel.id,
      modelPublicId: "alpha-1",
      promptTokens: 6,
      completionTokens: 4,
      totalTokens: 10,
      status: 200,
      createdAt: now - 60_000,
      streamed: true,
    });
    insertUsageLog(app, {
      clientKeyId,
      clientKeyLabel: "ck",
      providerId: betaProviderId,
      providerName: "beta",
      modelId: betaModel.id,
      modelPublicId: "beta-1",
      promptTokens: 40,
      completionTokens: 10,
      totalTokens: 50,
      status: 500,
      estimated: true,
      createdAt: now - 120_000,
    });
    insertUsageLog(app, {
      clientKeyId,
      clientKeyLabel: "ck",
      providerId: alphaProviderId,
      providerName: "alpha",
      modelId: alphaModel.id,
      modelPublicId: "alpha-1",
      promptTokens: 5,
      completionTokens: 0,
      totalTokens: 5,
      status: 200,
      createdAt: todayMid - 60_000,
    });
  });

  afterAll(() => {
    app.stop();
  });

  test("totals cover prompts, completions, errors and estimates", async () => {
    const body = await stats("all");
    expect(body.range).toBe("all");
    expect(body.totals).toEqual({
      requests: 4,
      promptTokens: 57,
      completionTokens: 18,
      totalTokens: 75,
      estimatedRequests: 1,
      errors: 1,
      averageCompletionTokens: 5,
    });
    expect(body.today.requests).toBeGreaterThanOrEqual(1);
    expect(body.today.totalTokens).toBeGreaterThanOrEqual(10);
  });

  test("the 24h range buckets hourly and the 7d range buckets daily", async () => {
    const hourly = await stats("24h");
    expect(hourly.series.length).toBeGreaterThanOrEqual(1);
    for (const bucket of hourly.series) {
      expect(bucket.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
    }
    expect(hourly.series.reduce((sum, row) => sum + row.requests, 0)).toBe(
      hourly.totals.requests,
    );
    expect(hourly.totals.requests).toBe(4);

    const daily = await stats("7d");
    expect(daily.series.length).toBeGreaterThanOrEqual(1);
    for (const bucket of daily.series) {
      expect(bucket.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(daily.series.reduce((sum, row) => sum + row.requests, 0)).toBe(4);
    expect(daily.series.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(
      75,
    );
  });

  test("breakdowns expose models, never identities", async () => {
    const body = await stats("all");
    expect(body.byModel.map((row) => [row.label, row.totalTokens])).toEqual([
      ["beta-1", 50],
      ["alpha-1", 25],
    ]);
    expect(body.byModel.map((row) => row.requests)).toEqual([1, 3]);
  });

  test("the public payload omits providers, client keys and per-request rows", async () => {
    const response = await fetch(`${app.baseUrl}/api/stats`);
    expect(response.status).toBe(200);
    const text = await response.text();
    // Nothing that identifies a client key, its prefix, or a provider may appear.
    expect(text).not.toContain(clientKeyToken);
    expect(text).not.toContain("key_hash");
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain(`:${clientKeyLabel}`);
    expect(text).not.toContain(`"${clientKeyLabel}"`);
    // The payload may only carry model IDs as names — no identifier columns.
    const flat = JSON.stringify(JSON.parse(text));
    for (const forbidden of [
      "recent",
      "byProvider",
      "byClientKey",
      "prefix",
      "clientKeyLabel",
      "providerName",
      "requestId",
      "latencyMs",
      "endpoint",
    ]) {
      expect(flat).not.toContain(`"${forbidden}"`);
    }
    const body = JSON.parse(text) as StatsResponse;
    expect(Object.keys(body).sort()).toEqual([
      "byModel",
      "generatedAt",
      "range",
      "series",
      "today",
      "totals",
    ]);
    expect(body.range).toBe("30d");
    expect(body.byModel.map((row) => row.label)).toEqual(["beta-1", "alpha-1"]);
  });

  test("logs keep snapshot labels after the provider and client key are deleted", async () => {
    await adminJson(app, `/api/admin/providers/${betaProviderId}`, {
      method: "DELETE",
    });
    await adminJson(app, `/api/admin/client-keys/${clientKeyId}`, {
      method: "DELETE",
    });

    const body = await stats("all");
    expect(body.totals.requests).toBe(4);
    expect(body.byModel.map((row) => row.label)).toEqual(["beta-1", "alpha-1"]);
    expect(
      await adminJson<{ providers: unknown[] }>(app, "/api/admin/providers"),
    ).toEqual({
      providers: [expect.objectContaining({ name: "alpha" })],
    });
  });
});
