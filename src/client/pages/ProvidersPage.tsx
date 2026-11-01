import { useEffect, useState } from "react";
import type { ProviderDTO } from "../../shared/types.ts";
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

type Draft = {
  name: string;
  baseUrl: string;
  extraHeaders: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  baseUrl: "",
  extraHeaders: "",
  enabled: true,
};

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProviderDTO | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    adminFetch<{ providers: ProviderDTO[] }>("/api/admin/providers")
      .then((body) => {
        setProviders(body.providers);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(load, []);

  const create = () => {
    if (!draft) return;
    setBusy(true);
    setFormError(null);
    const extraHeaders =
      draft.extraHeaders.trim() === "" ? null : draft.extraHeaders;
    let parsedHeaders: Record<string, string> | null = null;
    if (extraHeaders !== null) {
      try {
        const parsed: unknown = JSON.parse(extraHeaders);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Extra headers must be a JSON object.");
        }
        parsedHeaders = parsed as Record<string, string>;
      } catch (cause) {
        setBusy(false);
        setFormError(
          cause instanceof Error
            ? cause.message
            : "Extra headers must be valid JSON.",
        );
        return;
      }
    }
    adminFetch<ProviderDTO>("/api/admin/providers", {
      method: "POST",
      body: JSON.stringify({
        name: draft.name,
        baseUrl: draft.baseUrl,
        extraHeaders: parsedHeaders,
        enabled: draft.enabled,
      }),
    })
      .then(() => {
        setDraft(null);
        showToast("Provider created.");
        load();
        setBusy(false);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setFormError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const remove = () => {
    if (!deleting) return;
    setBusy(true);
    adminFetch(`/api/admin/providers/${deleting.id}`, { method: "DELETE" })
      .then(() => {
        setDeleting(null);
        setConfirmName("");
        showToast("Provider deleted.");
        load();
      })
      .catch((cause: unknown) =>
        showToast(
          String(cause instanceof Error ? cause.message : cause),
          "error",
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="page-head">
        <h1>Providers</h1>
        <span className="spacer" />
        <Button
          variant="primary"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT });
            setFormError(null);
          }}
        >
          Add provider
        </Button>
      </div>

      {error ? <Banner>{error}</Banner> : null}

      <Table
        columns={[
          { key: "name", label: "Name" },
          { key: "baseUrl", label: "Base URL" },
          { key: "enabled", label: "Enabled" },
          { key: "keys", label: "Keys" },
          { key: "models", label: "Models", numeric: true },
          { key: "synced", label: "Last synced" },
          { key: "actions", label: "" },
        ]}
        sticky
        stack
        empty={
          providers.length === 0
            ? "No providers yet. Add one to get started."
            : null
        }
      >
        {providers.map((provider) => (
          <tr key={provider.id}>
            <td data-label="Name">
              <a
                href={`/admin/providers/${provider.id}`}
                className="mono"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/admin/providers/${provider.id}`);
                }}
              >
                {provider.name}
              </a>
            </td>
            <td data-label="Base URL" className="mono small">
              {provider.baseUrl}
            </td>
            <td data-label="Enabled">
              <Badge tone={provider.enabled ? "ok" : "muted"}>
                {provider.enabled ? "yes" : "no"}
              </Badge>
            </td>
            <td data-label="Keys">
              <span className="small">
                {provider.keyCount === 0
                  ? "none"
                  : `${provider.keyCount} total`}{" "}
                <span className="muted">
                  ({provider.keyStatusCounts.active} active
                  {provider.keyStatusCounts.cooling > 0
                    ? `, ${provider.keyStatusCounts.cooling} cooling`
                    : ""}
                  {provider.keyStatusCounts.disabled > 0
                    ? `, ${provider.keyStatusCounts.disabled} disabled`
                    : ""}
                  )
                </span>
              </span>
            </td>
            <td data-label="Models" className="num">
              {provider.modelCount}
            </td>
            <td data-label="Last synced" className="small muted">
              {formatAgo(provider.lastSyncedAt)}
            </td>
            <td>
              <span className="row-actions">
                <Button
                  size="small"
                  onClick={() => navigate(`/admin/providers/${provider.id}`)}
                >
                  Manage
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  onClick={() => {
                    setDeleting(provider);
                    setConfirmName("");
                  }}
                >
                  Delete
                </Button>
              </span>
            </td>
          </tr>
        ))}
      </Table>

      {draft ? (
        <Modal
          title="Add provider"
          onClose={() => setDraft(null)}
          footer={
            <>
              <Button onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" onClick={create} disabled={busy}>
                Create provider
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Name">
              <input
                className="input mono"
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="openai"
              />
            </Field>
            <Field label="Base URL" hint="Include the API version prefix.">
              <input
                className="input mono"
                value={draft.baseUrl}
                onChange={(event) =>
                  setDraft({ ...draft, baseUrl: event.target.value })
                }
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field
              label="Extra headers (JSON)"
              hint='Optional, for example {"HTTP-Referer": "https://example.com"}'
              full
            >
              <textarea
                className="input mono"
                value={draft.extraHeaders}
                onChange={(event) =>
                  setDraft({ ...draft, extraHeaders: event.target.value })
                }
                placeholder="{}"
              />
            </Field>
            <label className="checkbox full">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              Enabled
            </label>
          </div>
          {formError ? <Banner>{formError}</Banner> : null}
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title={`Delete provider "${deleting.name}"`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={busy || confirmName !== deleting.name}
                onClick={remove}
              >
                Delete provider
              </Button>
            </>
          }
        >
          <Banner>
            This deletes the provider, its {deleting.keyCount} key(s) and{" "}
            {deleting.modelCount} model(s). Usage history keeps its snapshot
            labels.
          </Banner>
          <Field label={`Type "${deleting.name}" to confirm`}>
            <input
              className="input mono"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
            />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}
