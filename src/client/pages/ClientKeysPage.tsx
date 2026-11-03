import { Key, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type {
  ClientKeyCreatedDTO,
  ClientKeyDTO,
  LimitWindow,
} from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  EmptyState,
  Field,
  formatAgo,
  formatNumber,
  IconButton,
  Modal,
  PageHead,
  showToast,
  Table,
} from "../components/ui.tsx";

const WINDOWS: LimitWindow[] = ["total", "day", "month"];

function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : formatNumber(limit);
}

/**
 * Upstream error bodies are often raw JSON envelopes: show the sentence inside
 * them rather than a wall of braces, and keep the cell to one readable line.
 */
function errorSummary(message: string, max = 120): string {
  let text = message.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const error =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).error
        : null;
    if (typeof error === "string") text = error;
    else if (error && typeof error === "object") {
      const detail = (error as Record<string, unknown>).message;
      if (typeof detail === "string") text = detail;
    }
  } catch {
    // Not JSON: the body itself is the message.
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text === "") return "No error details.";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function ClientKeysPage() {
  const [keys, setKeys] = useState<ClientKeyDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [window, setWindow] = useState<LimitWindow>("total");
  const [limitTokens, setLimitTokens] = useState("");
  const [limitRequests, setLimitRequests] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientKeyDTO | null>(null);
  const [deleting, setDeleting] = useState<ClientKeyDTO | null>(null);

  const load = () => {
    adminFetch<{ clientKeys: ClientKeyDTO[] }>("/api/admin/client-keys")
      .then((body) => {
        setKeys(body.clientKeys);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(load, []);

  const create = () => {
    setFormError(null);
    adminFetch<ClientKeyCreatedDTO>("/api/admin/client-keys", {
      method: "POST",
      body: JSON.stringify({
        name,
        limitWindow: window,
        limitTokens: limitTokens.trim() === "" ? null : Number(limitTokens),
        limitRequests:
          limitRequests.trim() === "" ? null : Number(limitRequests),
      }),
    })
      .then((created) => {
        setCreatedToken(created.key);
        setName("");
        setLimitTokens("");
        setLimitRequests("");
        setWindow("total");
        load();
      })
      .catch((cause: unknown) =>
        setFormError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  const remove = () => {
    if (!deleting) return;
    adminFetch(`/api/admin/client-keys/${deleting.id}`, { method: "DELETE" })
      .then(() => {
        setDeleting(null);
        showToast("Client key deleted.");
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
      <PageHead
        icon={<Key size={20} />}
        title="Client keys"
        description="Tokens your applications use, with optional request and token caps."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} weight="bold" />}
            onClick={() => {
              setCreating(true);
              setCreatedToken(null);
              setFormError(null);
            }}
          >
            Create key
          </Button>
        }
      />

      {error ? <Banner>{error}</Banner> : null}

      <Table
        columns={[
          { key: "name", label: "Name" },
          { key: "prefix", label: "Prefix" },
          { key: "enabled", label: "Enabled" },
          { key: "window", label: "Window" },
          { key: "requests", label: "Requests", numeric: true },
          { key: "tokens", label: "Tokens", numeric: true },
          { key: "lastUsed", label: "Last used" },
          { key: "lastError", label: "Last error" },
          { key: "actions", label: "" },
        ]}
        sticky
        stack
        empty={
          keys.length === 0 ? (
            <EmptyState
              icon={<Key size={20} />}
              title="No client keys yet"
              body="Mint a token, then point any OpenAI client at /v1 with it."
              action={
                <Button
                  icon={<Plus size={16} weight="bold" />}
                  onClick={() => {
                    setCreating(true);
                    setCreatedToken(null);
                    setFormError(null);
                  }}
                >
                  Create key
                </Button>
              }
            />
          ) : null
        }
      >
        {keys.map((key) => (
          <tr key={key.id}>
            <td data-label="Name">{key.name}</td>
            <td data-label="Prefix" className="mono small">
              {key.keyPrefix}…
            </td>
            <td data-label="Enabled">
              <Badge tone={key.enabled ? "ok" : "muted"}>
                {key.enabled ? "yes" : "no"}
              </Badge>
            </td>
            <td data-label="Window" className="mono small">
              {key.limitWindow}
            </td>
            <td data-label="Requests" className="num">
              {formatNumber(key.usage.requests)} /{" "}
              {limitText(key.limitRequests)}
            </td>
            <td data-label="Tokens" className="num">
              {formatNumber(key.usage.tokens)} / {limitText(key.limitTokens)}
            </td>
            <td data-label="Last used" className="small muted">
              {formatAgo(key.lastUsedAt)}
            </td>
            <td data-label="Last error" className="last-error">
              {key.lastError ? (
                <>
                  <span className="last-error-head">
                    <Badge
                      tone={key.lastError.status < 500 ? "warn" : "danger"}
                    >
                      {key.lastError.status}
                    </Badge>
                    <span className="small muted">
                      {formatAgo(key.lastError.at)}
                    </span>
                  </span>
                  <span
                    className="small muted last-error-message"
                    title={key.lastError.message}
                  >
                    {errorSummary(key.lastError.message)}
                  </span>
                </>
              ) : (
                <span className="muted small">—</span>
              )}
            </td>
            <td>
              <span className="row-actions">
                <IconButton
                  label="Edit key"
                  size="small"
                  icon={<PencilSimple size={16} />}
                  onClick={() => setEditing(key)}
                />
                <IconButton
                  label="Delete key"
                  variant="danger"
                  size="small"
                  icon={<Trash size={16} />}
                  onClick={() => setDeleting(key)}
                />
              </span>
            </td>
          </tr>
        ))}
      </Table>

      {creating ? (
        <Modal
          title={createdToken ? "Key created" : "Create client key"}
          icon={<Key size={19} />}
          subtitle={
            createdToken
              ? "The token is shown once. Copy it into your application now."
              : "A token scoped to these limits; requests are counted per window."
          }
          onClose={() => {
            setCreating(false);
            setCreatedToken(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setCreating(false);
                  setCreatedToken(null);
                }}
              >
                {createdToken ? "Done" : "Cancel"}
              </Button>
              {createdToken ? null : (
                <Button
                  variant="primary"
                  icon={<Plus size={16} weight="bold" />}
                  onClick={create}
                  disabled={name.trim() === ""}
                >
                  Create key
                </Button>
              )}
            </>
          }
        >
          {createdToken ? (
            <div className="key-panel">
              <span className="key-panel-head">
                <Key size={18} />
                This key cannot be shown again
              </span>
              <span className="key-value">{createdToken}</span>
              <div>
                <CopyButton value={createdToken} label="Copy key" />
              </div>
            </div>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Name">
                  <input
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="my-app"
                  />
                </Field>
                <Field label="Limit window" hint="UTC-based for day and month.">
                  <select
                    className="select"
                    value={window}
                    onChange={(event) =>
                      setWindow(event.target.value as LimitWindow)
                    }
                  >
                    {WINDOWS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Token cap" hint="Leave empty for unlimited.">
                  <input
                    className="input mono"
                    value={limitTokens}
                    onChange={(event) => setLimitTokens(event.target.value)}
                    inputMode="numeric"
                    placeholder="unlimited"
                  />
                </Field>
                <Field label="Request cap" hint="Leave empty for unlimited.">
                  <input
                    className="input mono"
                    value={limitRequests}
                    onChange={(event) => setLimitRequests(event.target.value)}
                    inputMode="numeric"
                    placeholder="unlimited"
                  />
                </Field>
              </div>
              {formError ? <Banner>{formError}</Banner> : null}
            </>
          )}
        </Modal>
      ) : null}

      {editing ? (
        <EditKeyDialog
          clientKey={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            showToast("Client key saved.");
            load();
          }}
        />
      ) : null}

      {deleting ? (
        <Modal
          title={`Delete client key "${deleting.name}"`}
          icon={<Trash size={19} />}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="danger"
                icon={<Trash size={16} />}
                onClick={remove}
              >
                Delete key
              </Button>
            </>
          }
        >
          <p className="small muted">
            Requests signed with this key stop working immediately. Usage
            history keeps its label.
          </p>
        </Modal>
      ) : null}
    </>
  );
}

function EditKeyDialog(props: {
  clientKey: ClientKeyDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(props.clientKey.name);
  const [enabled, setEnabled] = useState(props.clientKey.enabled);
  const [window, setWindow] = useState<LimitWindow>(
    props.clientKey.limitWindow,
  );
  const [limitTokens, setLimitTokens] = useState(
    props.clientKey.limitTokens === null
      ? ""
      : String(props.clientKey.limitTokens),
  );
  const [limitRequests, setLimitRequests] = useState(
    props.clientKey.limitRequests === null
      ? ""
      : String(props.clientKey.limitRequests),
  );
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setError(null);
    adminFetch(`/api/admin/client-keys/${props.clientKey.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        enabled,
        limitWindow: window,
        limitTokens: limitTokens.trim() === "" ? null : Number(limitTokens),
        limitRequests:
          limitRequests.trim() === "" ? null : Number(limitRequests),
      }),
    })
      .then(props.onSaved)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  return (
    <Modal
      title={`Edit ${props.clientKey.name}`}
      icon={<PencilSimple size={19} />}
      subtitle={props.clientKey.keyPrefix + "…"}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Limit window">
          <select
            className="select"
            value={window}
            onChange={(event) => setWindow(event.target.value as LimitWindow)}
          >
            {WINDOWS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Token cap">
          <input
            className="input mono"
            value={limitTokens}
            onChange={(event) => setLimitTokens(event.target.value)}
            inputMode="numeric"
            placeholder="unlimited"
          />
        </Field>
        <Field label="Request cap">
          <input
            className="input mono"
            value={limitRequests}
            onChange={(event) => setLimitRequests(event.target.value)}
            inputMode="numeric"
            placeholder="unlimited"
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
    </Modal>
  );
}
