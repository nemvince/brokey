import { useEffect, useState } from "react";
import type { ClientKeyCreatedDTO, ClientKeyDTO, LimitWindow } from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  Field,
  formatAgo,
  formatNumber,
  Modal,
  showToast,
  Table,
} from "../components/ui.tsx";

const WINDOWS: LimitWindow[] = ["total", "day", "month"];

function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : formatNumber(limit);
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
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
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
        limitRequests: limitRequests.trim() === "" ? null : Number(limitRequests),
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
      .catch((cause: unknown) => setFormError(cause instanceof Error ? cause.message : String(cause)));
  };

  const remove = () => {
    if (!deleting) return;
    adminFetch(`/api/admin/client-keys/${deleting.id}`, { method: "DELETE" })
      .then(() => {
        setDeleting(null);
        showToast("Client key deleted.");
        load();
      })
      .catch((cause: unknown) => showToast(String(cause instanceof Error ? cause.message : cause), "error"));
  };

  return (
    <>
      <div className="page-head">
        <h1>Client keys</h1>
        <span className="spacer" />
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
            setCreatedToken(null);
            setFormError(null);
          }}
        >
          Create key
        </Button>
      </div>

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
          { key: "actions", label: "" },
        ]}
        sticky
        stack
        empty={keys.length === 0 ? "No client keys yet. Create one to start proxying." : null}
      >
        {keys.map((key) => (
          <tr key={key.id}>
            <td data-label="Name">{key.name}</td>
            <td data-label="Prefix" className="mono small">
              {key.keyPrefix}…
            </td>
            <td data-label="Enabled">
              <Badge tone={key.enabled ? "ok" : "muted"}>{key.enabled ? "yes" : "no"}</Badge>
            </td>
            <td data-label="Window" className="mono small">
              {key.limitWindow}
            </td>
            <td data-label="Requests" className="num">
              {formatNumber(key.usage.requests)} / {limitText(key.limitRequests)}
            </td>
            <td data-label="Tokens" className="num">
              {formatNumber(key.usage.tokens)} / {limitText(key.limitTokens)}
            </td>
            <td data-label="Last used" className="small muted">
              {formatAgo(key.lastUsedAt)}
            </td>
            <td>
              <span className="row-actions">
                <Button size="small" onClick={() => setEditing(key)}>
                  Edit
                </Button>
                <Button size="small" variant="danger" onClick={() => setDeleting(key)}>
                  Delete
                </Button>
              </span>
            </td>
          </tr>
        ))}
      </Table>

      {creating ? (
        <Modal
          title="Create client key"
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
                <Button variant="primary" onClick={create} disabled={name.trim() === ""}>
                  Create key
                </Button>
              )}
            </>
          }
        >
          {createdToken ? (
            <div className="key-panel">
              <strong className="small">Copy this key now — it cannot be shown again.</strong>
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
                    onChange={(event) => setWindow(event.target.value as LimitWindow)}
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
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={remove}>
                Delete key
              </Button>
            </>
          }
        >
          <p className="small muted">
            Requests signed with this key stop working immediately. Usage history keeps its label.
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
  const [window, setWindow] = useState<LimitWindow>(props.clientKey.limitWindow);
  const [limitTokens, setLimitTokens] = useState(
    props.clientKey.limitTokens === null ? "" : String(props.clientKey.limitTokens),
  );
  const [limitRequests, setLimitRequests] = useState(
    props.clientKey.limitRequests === null ? "" : String(props.clientKey.limitRequests),
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
        limitRequests: limitRequests.trim() === "" ? null : Number(limitRequests),
      }),
    })
      .then(props.onSaved)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <Modal
      title={`Edit ${props.clientKey.name}`}
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
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
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
