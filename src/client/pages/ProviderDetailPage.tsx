import { useEffect, useState } from "react";
import type {
  ModelDTO,
  ProviderDetailDTO,
  ProviderKeyDTO,
  SyncPreview,
} from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import { navigate } from "../router.tsx";
import {
  Badge,
  Banner,
  Button,
  Field,
  formatAgo,
  Modal,
  showToast,
  Table,
} from "../components/ui.tsx";
import { ModelDialog } from "../components/ModelDialog.tsx";
import { SyncPreviewDialog } from "../components/SyncPreviewDialog.tsx";

function StatusBadge(props: { providerKey: ProviderKeyDTO; now: number }) {
  if (props.providerKey.status === "disabled")
    return <Badge tone="muted">disabled</Badge>;
  if (props.providerKey.status === "cooling") {
    const seconds = Math.max(
      0,
      Math.ceil(
        ((props.providerKey.cooldownUntil ?? props.now) - props.now) / 1000,
      ),
    );
    return (
      <Badge tone="warn">
        cooling {Math.floor(seconds / 60)}m {seconds % 60}s
      </Badge>
    );
  }
  return <Badge tone="ok">active</Badge>;
}

function SettingsForm(props: {
  detail: ProviderDetailDTO;
  onSaved: () => void;
}) {
  const [name, setName] = useState(props.detail.name);
  const [baseUrl, setBaseUrl] = useState(props.detail.baseUrl);
  const [extraHeaders, setExtraHeaders] = useState(
    props.detail.extraHeaders
      ? JSON.stringify(props.detail.extraHeaders, null, 2)
      : "",
  );
  const [enabled, setEnabled] = useState(props.detail.enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(props.detail.name);
    setBaseUrl(props.detail.baseUrl);
    setExtraHeaders(
      props.detail.extraHeaders
        ? JSON.stringify(props.detail.extraHeaders, null, 2)
        : "",
    );
    setEnabled(props.detail.enabled);
  }, [props.detail]);

  const save = () => {
    setBusy(true);
    setError(null);
    let headers: Record<string, string> | null = null;
    const raw = extraHeaders.trim();
    if (raw !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(
            "Extra headers must be a JSON object of string values.",
          );
        }
        headers = parsed as Record<string, string>;
      } catch (cause) {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : "Invalid JSON.");
        return;
      }
    }
    adminFetch(`/api/admin/providers/${props.detail.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, baseUrl, extraHeaders: headers, enabled }),
    })
      .then(() => {
        setBusy(false);
        showToast("Provider saved.");
        props.onSaved();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Settings</h2>
        <span className="spacer" />
        <span className="small muted">
          Last synced {formatAgo(props.detail.lastSyncedAt)}
        </span>
      </div>
      <div className="form-grid">
        <Field label="Name">
          <input
            className="input mono"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Base URL"
          hint="Include the API version prefix, e.g. https://api.openai.com/v1"
        >
          <input
            className="input mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        <Field label="Extra headers (JSON)" full>
          <textarea
            className="input mono"
            value={extraHeaders}
            onChange={(event) => setExtraHeaders(event.target.value)}
            placeholder="{}"
          />
        </Field>
        <label className="checkbox full">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>
      {error ? <Banner>{error}</Banner> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button variant="primary" onClick={save} disabled={busy}>
          Save changes
        </Button>
      </div>
    </section>
  );
}

export function ProviderDetailPage(props: { providerId: number }) {
  const [detail, setDetail] = useState<ProviderDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [addingKey, setAddingKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [editingModel, setEditingModel] = useState<ModelDTO | null>(null);
  const [creatingModel, setCreatingModel] = useState(false);

  const fetchPreview = (): Promise<SyncPreview> =>
    adminFetch<SyncPreview>(
      `/api/admin/providers/${props.providerId}/models/fetch`,
      {
        method: "POST",
      },
    );

  const load = () => {
    adminFetch<ProviderDetailDTO>(`/api/admin/providers/${props.providerId}`)
      .then((body) => {
        setDetail(body);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(load, [props.providerId]);

  const cooling = detail?.keys.some((key) => key.status === "cooling") ?? false;
  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling]);

  if (error && !detail) {
    return (
      <>
        <Banner>{error}</Banner>
        <div>
          <Button onClick={() => navigate("/admin")}>Back to providers</Button>
        </div>
      </>
    );
  }

  if (!detail) return <p className="muted small">Loading provider…</p>;

  const addKey = () => {
    setKeyError(null);
    adminFetch(`/api/admin/providers/${detail.id}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: keyLabel, secret: keySecret }),
    })
      .then(() => {
        setAddingKey(false);
        setKeyLabel("");
        setKeySecret("");
        showToast("API key added.");
        load();
      })
      .catch((cause: unknown) =>
        setKeyError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  const patchKey = (
    key: ProviderKeyDTO,
    body: Record<string, unknown>,
    message: string,
  ) => {
    adminFetch(`/api/admin/provider-keys/${key.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
      .then(() => {
        showToast(message);
        load();
      })
      .catch((cause: unknown) =>
        showToast(
          String(cause instanceof Error ? cause.message : cause),
          "error",
        ),
      );
  };

  const resetKey = (key: ProviderKeyDTO) => {
    adminFetch(`/api/admin/provider-keys/${key.id}/reset`, { method: "POST" })
      .then(() => {
        showToast("Cooldown cleared.");
        load();
      })
      .catch((cause: unknown) =>
        showToast(
          String(cause instanceof Error ? cause.message : cause),
          "error",
        ),
      );
  };

  const deleteKey = (key: ProviderKeyDTO) => {
    adminFetch(`/api/admin/provider-keys/${key.id}`, { method: "DELETE" })
      .then(() => {
        showToast("API key deleted.");
        load();
      })
      .catch((cause: unknown) =>
        showToast(
          String(cause instanceof Error ? cause.message : cause),
          "error",
        ),
      );
  };

  const fetchModels = () => {
    setFetching(true);
    fetchPreview()
      .then((body) => {
        setFetching(false);
        setPreview(body);
      })
      .catch((cause: unknown) => {
        setFetching(false);
        showToast(
          cause instanceof Error ? cause.message : String(cause),
          "error",
        );
      });
  };

  const deleteModel = (model: ModelDTO) => {
    adminFetch(`/api/admin/models/${model.id}`, { method: "DELETE" })
      .then(() => {
        showToast("Model deleted.");
        load();
      })
      .catch((cause: unknown) =>
        showToast(
          String(cause instanceof Error ? cause.message : cause),
          "error",
        ),
      );
  };

  return (
    <>
      <div className="page-head">
        <h1 className="mono">{detail.name}</h1>
        <Badge tone={detail.enabled ? "ok" : "muted"}>
          {detail.enabled ? "enabled" : "disabled"}
        </Badge>
        <span className="spacer" />
        <Button
          onClick={() => {
            navigate("/admin");
          }}
        >
          Back to providers
        </Button>
        <Button variant="primary" onClick={fetchModels} disabled={fetching}>
          {fetching ? "Fetching…" : "Fetch models"}
        </Button>
      </div>

      <SettingsForm detail={detail} onSaved={load} />

      <section className="panel" style={{ padding: 0 }}>
        <div className="panel-head" style={{ padding: "14px 16px 0" }}>
          <h2>API keys</h2>
          <span className="spacer" />
          <Button
            size="small"
            onClick={() => {
              setAddingKey(true);
              setKeyError(null);
            }}
          >
            Add key
          </Button>
        </div>
        <Table
          columns={[
            { key: "label", label: "Label" },
            { key: "preview", label: "Key" },
            { key: "status", label: "Status" },
            { key: "used", label: "Last used" },
            { key: "error", label: "Last error" },
            { key: "actions", label: "" },
          ]}
          stack
          empty={
            detail.keys.length === 0
              ? "No API keys yet. Requests fail until you add one."
              : null
          }
        >
          {detail.keys.map((key) => (
            <tr key={key.id}>
              <td data-label="Label">{key.label}</td>
              <td data-label="Key" className="mono small">
                {key.keyPreview}
              </td>
              <td data-label="Status">
                <StatusBadge providerKey={key} now={now} />
              </td>
              <td data-label="Last used" className="small muted">
                {formatAgo(key.lastUsedAt)}
              </td>
              <td
                data-label="Last error"
                className="small"
                style={{ maxWidth: 260, whiteSpace: "normal" }}
              >
                {key.lastError ? (
                  <span className="muted" title={key.lastError}>
                    {key.lastError.slice(0, 90)}
                    {key.lastError.length > 90 ? "…" : ""}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <span className="row-actions">
                  <Button
                    size="small"
                    onClick={() =>
                      patchKey(
                        key,
                        { enabled: !key.enabled },
                        key.enabled ? "Key disabled." : "Key enabled.",
                      )
                    }
                  >
                    {key.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="small" onClick={() => resetKey(key)}>
                    Reset
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={() => deleteKey(key)}
                  >
                    Delete
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="panel" style={{ padding: 0 }}>
        <div className="panel-head" style={{ padding: "14px 16px 0" }}>
          <h2>Models</h2>
          <span className="spacer" />
          <Button size="small" onClick={() => setCreatingModel(true)}>
            Add model
          </Button>
        </div>
        <Table
          columns={[
            { key: "publicId", label: "Public ID" },
            { key: "upstreamId", label: "Upstream ID" },
            { key: "enabled", label: "Enabled" },
            { key: "available", label: "Upstream" },
            { key: "context", label: "Context", numeric: true },
            { key: "output", label: "Max output", numeric: true },
            { key: "actions", label: "" },
          ]}
          stack
          empty={
            detail.models.length === 0
              ? "No models yet. Fetch the upstream catalog to add some."
              : null
          }
        >
          {detail.models.map((model) => (
            <tr key={model.id}>
              <td data-label="Public ID" className="mono small">
                {model.publicId}
              </td>
              <td data-label="Upstream ID" className="mono small muted">
                {model.upstreamId}
              </td>
              <td data-label="Enabled">
                <input
                  type="checkbox"
                  aria-label={`Enable ${model.publicId}`}
                  checked={model.enabled}
                  onChange={() =>
                    adminFetch(`/api/admin/models/${model.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: !model.enabled }),
                    })
                      .then(load)
                      .catch((cause: unknown) =>
                        showToast(
                          String(
                            cause instanceof Error ? cause.message : cause,
                          ),
                          "error",
                        ),
                      )
                  }
                />
              </td>
              <td data-label="Upstream">
                <Badge tone={model.upstreamAvailable ? "ok" : "warn"}>
                  {model.upstreamAvailable ? "available" : "missing"}
                </Badge>
              </td>
              <td data-label="Context" className="num">
                {model.contextWindow ?? "—"}
              </td>
              <td data-label="Max output" className="num">
                {model.maxOutputTokens ?? "—"}
              </td>
              <td>
                <span className="row-actions">
                  <Button size="small" onClick={() => setEditingModel(model)}>
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={() => deleteModel(model)}
                  >
                    Delete
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </Table>
      </section>

      {addingKey ? (
        <Modal
          title="Add API key"
          onClose={() => setAddingKey(false)}
          footer={
            <>
              <Button onClick={() => setAddingKey(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={addKey}
                disabled={keyLabel.trim() === "" || keySecret.trim() === ""}
              >
                Add key
              </Button>
            </>
          }
        >
          <Field label="Label" hint="Shown in the key list and usage log.">
            <input
              className="input"
              value={keyLabel}
              onChange={(event) => setKeyLabel(event.target.value)}
              placeholder="production"
            />
          </Field>
          <Field label="Secret" hint="Write-only: it is never displayed again.">
            <input
              className="input mono"
              type="password"
              value={keySecret}
              onChange={(event) => setKeySecret(event.target.value)}
              placeholder="sk-…"
            />
          </Field>
          {keyError ? <Banner>{keyError}</Banner> : null}
        </Modal>
      ) : null}

      {preview ? (
        <SyncPreviewDialog
          providerId={detail.id}
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={(next) => {
            setPreview(null);
            setDetail(next);
          }}
        />
      ) : null}

      {editingModel ? (
        <ModelDialog
          mode="edit"
          model={editingModel}
          providers={[detail]}
          onClose={() => setEditingModel(null)}
          onSaved={() => {
            setEditingModel(null);
            showToast("Model saved.");
            load();
          }}
        />
      ) : null}

      {creatingModel ? (
        <ModelDialog
          mode="create"
          providers={[detail]}
          defaultProviderId={detail.id}
          onClose={() => setCreatingModel(false)}
          onSaved={() => {
            setCreatingModel(false);
            showToast("Model created.");
            load();
          }}
        />
      ) : null}
    </>
  );
}
