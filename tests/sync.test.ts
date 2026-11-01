import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { models, usageLogs } from "../src/server/schema.ts";
import type {
  ModelDTO,
  ProviderDetailDTO,
  SyncPreview,
} from "../src/shared/types.ts";
import {
  adminJson,
  adminRequest,
  insertUsageLog,
  readJson,
  seedProvider,
  startMockUpstream,
  startTestApp,
  type MockUpstream,
  type TestApp,
} from "./helpers.ts";

function modelRow(app: TestApp, publicId: string) {
  return app.db
    .select()
    .from(models)
    .where(eq(models.publicId, publicId))
    .get();
}

describe("model sync", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream({
      models: [
        {
          id: "m-one",
          name: "Model One",
          context_length: 8000,
          owned_by: "vendor",
        },
        { id: "m-two", name: "Model Two" },
      ],
    });
    const provider = await seedProvider(app, {
      name: "sync",
      baseUrl: mock.baseUrl,
    });
    providerId = provider.providerId;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("preview lists additions and apply only stores the selected rows", async () => {
    const preview = await adminJson<SyncPreview>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      {
        method: "POST",
      },
    );
    expect(preview.providerId).toBe(providerId);
    expect(preview.added.map((row) => row.upstreamId)).toEqual([
      "m-one",
      "m-two",
    ]);
    expect(preview.added[0]?.suggestedPublicId).toBe("m-one");
    expect(preview.added[0]?.upstream).toEqual({
      displayName: "Model One",
      contextWindow: 8000,
    });
    expect(preview.matched).toEqual([]);
    expect(preview.missing).toEqual([]);

    const detail = await adminJson<ProviderDetailDTO>(
      app,
      `/api/admin/providers/${providerId}/models/apply`,
      { body: { added: [{ upstreamId: "m-one", publicId: "one" }] } },
    );
    expect(detail.models.map((row) => row.publicId)).toEqual(["one"]);
    expect(detail.lastSyncedAt).toBeGreaterThan(0);

    const row = modelRow(app, "one");
    expect(row?.displayName).toBe("Model One");
    expect(row?.contextWindow).toBe(8000);
    expect(row?.syncedDisplayName).toBe("Model One");
    expect(row?.syncedContextWindow).toBe(8000);
    expect(row?.syncedMaxOutputTokens).toBeNull();
    expect(row?.enabled).toBe(true);
    expect(row?.upstreamAvailable).toBe(true);
  });

  test("manual edits conflict with upstream changes and can be resolved both ways", async () => {
    await adminJson(app, `/api/admin/models/${modelRow(app, "one")?.id}`, {
      method: "PATCH",
      body: { displayName: "My Name" },
    });
    expect(modelRow(app, "one")?.syncedDisplayName).toBe("Model One");

    mock.models = [
      {
        id: "m-one",
        name: "Renamed",
        context_length: 8000,
        owned_by: "vendor",
      },
      { id: "m-two", name: "Model Two" },
    ];
    const preview = await adminJson<SyncPreview>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      { method: "POST" },
    );
    const conflict = preview.conflicts.find(
      (row) => row.field === "displayName" && row.publicId === "one",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.local).toBe("My Name");
    expect(conflict?.upstream).toBe("Renamed");
    expect(conflict?.synced).toBe("Model One");
    expect(
      preview.matched.find((row) => row.publicId === "one")?.changedFields,
    ).toContain("displayName");

    const modelId = modelRow(app, "one")?.id as number;
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {
        resolutions: [{ modelId, field: "displayName", choice: "local" }],
      },
    });
    expect(modelRow(app, "one")?.displayName).toBe("My Name");
    expect(modelRow(app, "one")?.syncedDisplayName).toBe("Renamed");

    mock.models = [
      {
        id: "m-one",
        name: "Third Name",
        context_length: 8000,
        owned_by: "vendor",
      },
      { id: "m-two", name: "Model Two" },
    ];
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {
        resolutions: [{ modelId, field: "displayName", choice: "upstream" }],
      },
    });
    expect(modelRow(app, "one")?.displayName).toBe("Third Name");
    expect(modelRow(app, "one")?.syncedDisplayName).toBe("Third Name");
  });

  test("upstream metadata changes are adopted when the local value is untouched", async () => {
    mock.models = [
      {
        id: "m-one",
        name: "Third Name",
        context_length: 16000,
        owned_by: "vendor",
      },
      { id: "m-two", name: "Model Two" },
    ];
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {},
    });
    expect(modelRow(app, "one")?.contextWindow).toBe(16000);
    expect(modelRow(app, "one")?.syncedContextWindow).toBe(16000);
  });

  test("missing models can be kept, disabled or deleted and logs keep their snapshot", async () => {
    const detail = await adminJson<ProviderDetailDTO>(
      app,
      `/api/admin/providers/${providerId}/models/apply`,
      { body: { added: [{ upstreamId: "m-two", publicId: "two" }] } },
    );
    const two = detail.models.find((row) => row.publicId === "two") as ModelDTO;
    const three = await adminJson<ModelDTO>(app, "/api/admin/models", {
      body: { providerId, upstreamId: "m-three", publicId: "three" },
    });

    insertUsageLog(app, {
      providerId,
      providerName: "sync",
      modelId: three.id,
      modelPublicId: "three",
      totalTokens: 42,
    });

    mock.models = [{ id: "m-one", name: "Third Name", context_length: 16000 }];
    const preview = await adminJson<SyncPreview>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      { method: "POST" },
    );
    expect(preview.missing.map((row) => row.publicId).sort()).toEqual([
      "three",
      "two",
    ]);

    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {
        missing: [
          { modelId: two.id, action: "disable" },
          { modelId: three.id, action: "delete" },
        ],
      },
    });

    const disabled = modelRow(app, "two");
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.upstreamAvailable).toBe(false);
    expect(modelRow(app, "three")).toBeUndefined();
    expect(modelRow(app, "one")?.upstreamAvailable).toBe(true);

    const logRows = app.db.select().from(usageLogs).all();
    const snapshot = logRows.find((row) => row.totalTokens === 42);
    expect(snapshot?.modelPublicId).toBe("three");
    expect(snapshot?.modelId).toBeNull();
  });

  test("aliases across providers are de-duplicated and duplicate public IDs are rejected", async () => {
    mock.models = [{ id: "gpt-x", name: "GPT X", context_length: 32000 }];
    const other = await seedProvider(app, {
      name: "other",
      baseUrl: mock.baseUrl,
    });

    const first = await adminJson<SyncPreview>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      { method: "POST" },
    );
    const firstAddition = first.added.find((row) => row.upstreamId === "gpt-x");
    expect(firstAddition?.suggestedPublicId).toBe("gpt-x");
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: { added: [{ upstreamId: "gpt-x", publicId: "gpt-x" }] },
    });

    const second = await adminJson<SyncPreview>(
      app,
      `/api/admin/providers/${other.providerId}/models/fetch`,
      { method: "POST" },
    );
    const secondAddition = second.added.find(
      (row) => row.upstreamId === "gpt-x",
    );
    expect(secondAddition?.suggestedPublicId).toBe("gpt-x-2");
    expect(secondAddition?.aliasConflict).toBe(true);

    const before = app.db.select().from(models).all().length;
    const conflict = await adminRequest(
      app,
      `/api/admin/providers/${other.providerId}/models/apply`,
      { body: { added: [{ upstreamId: "gpt-x", publicId: "gpt-x" }] } },
    );
    expect(conflict.status).toBe(409);
    const body = await readJson<{ error: { message: string } }>(conflict);
    expect(body.error.message).toContain("already in use");
    expect(app.db.select().from(models).all().length).toBe(before);
  });

  test("applying an addition that vanished upstream fails without writing", async () => {
    mock.models = [{ id: "gpt-x", name: "GPT X", context_length: 32000 }];
    const before = app.db.select().from(models).all().length;
    const response = await adminRequest(
      app,
      `/api/admin/providers/${providerId}/models/apply`,
      { body: { added: [{ upstreamId: "ghost-model", publicId: "ghost" }] } },
    );
    expect(response.status).toBe(409);
    expect(app.db.select().from(models).all().length).toBe(before);
  });
});

describe("model sync without keys", () => {
  let app: TestApp;
  let mock: MockUpstream;

  beforeAll(() => {
    app = startTestApp();
    mock = startMockUpstream();
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("fetching models without a provider key returns a clear error", async () => {
    const provider = await seedProvider(app, {
      name: "keyless",
      baseUrl: mock.baseUrl,
      secrets: [],
    });
    const response = await adminRequest(
      app,
      `/api/admin/providers/${provider.providerId}/models/fetch`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(body.error.message).toBe(
      'Provider "keyless" has no enabled API keys.',
    );
    expect(mock.calls.length).toBe(0);
  });
});
