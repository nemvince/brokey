import { useEffect, useState } from "react";
import type { ModelDTO, ProviderDTO } from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
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

export function ModelsPage() {
  const [models, setModels] = useState<ModelDTO[]>([]);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ModelDTO | null>(null);

  const load = () => {
    Promise.all([
      adminFetch<{ models: ModelDTO[] }>("/api/admin/models"),
      adminFetch<{ providers: ProviderDTO[] }>("/api/admin/providers"),
    ])
      .then(([modelBody, providerBody]) => {
        setModels(modelBody.models);
        setProviders(providerBody.providers);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(load, []);

  const needle = search.trim().toLowerCase();
  const visible = models.filter((model) => {
    if (providerFilter !== "all" && String(model.providerId) !== providerFilter)
      return false;
    if (needle === "") return true;
    return (
      model.publicId.toLowerCase().includes(needle) ||
      model.upstreamId.toLowerCase().includes(needle) ||
      model.displayName.toLowerCase().includes(needle)
    );
  });

  const remove = () => {
    if (!deleting) return;
    adminFetch(`/api/admin/models/${deleting.id}`, { method: "DELETE" })
      .then(() => {
        setDeleting(null);
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
        <h1>Models</h1>
        <span className="spacer" />
        <Button
          variant="primary"
          onClick={() => setCreating(true)}
          disabled={providers.length === 0}
          title={providers.length === 0 ? "Add a provider first" : undefined}
        >
          Add model
        </Button>
      </div>

      {error ? <Banner>{error}</Banner> : null}

      <div className="toolbar">
        <Field label="Search">
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="public ID, upstream ID or name"
          />
        </Field>
        <Field label="Provider">
          <select
            className="select"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
          >
            <option value="all">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={String(provider.id)}>
                {provider.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Table
        columns={[
          { key: "publicId", label: "Public ID" },
          { key: "model", label: "Model" },
          { key: "provider", label: "Provider" },
          { key: "enabled", label: "Enabled" },
          { key: "upstream", label: "Upstream" },
          { key: "context", label: "Context", numeric: true },
          { key: "output", label: "Max output", numeric: true },
          { key: "updated", label: "Updated" },
          { key: "actions", label: "" },
        ]}
        sticky
        stack
        empty={
          visible.length === 0
            ? models.length === 0
              ? "No models yet. Fetch a provider's catalog or add one manually."
              : "No models match the current filters."
            : null
        }
      >
        {visible.map((model) => (
          <tr key={model.id}>
            <td data-label="Public ID" className="mono small">
              {model.publicId}
            </td>
            <td data-label="Model">
              {model.displayName}
              <div className="mono small muted">{model.upstreamId}</div>
            </td>
            <td data-label="Provider">{model.providerName}</td>
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
                        String(cause instanceof Error ? cause.message : cause),
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
            <td data-label="Updated" className="small muted">
              {formatAgo(model.updatedAt)}
            </td>
            <td>
              <span className="row-actions">
                <Button size="small" onClick={() => setEditing(model)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  onClick={() => setDeleting(model)}
                >
                  Delete
                </Button>
              </span>
            </td>
          </tr>
        ))}
      </Table>

      {editing ? (
        <ModelDialog
          mode="edit"
          model={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            showToast("Model saved.");
            load();
          }}
        />
      ) : null}

      {creating ? (
        <ModelDialog
          mode="create"
          providers={providers}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            showToast("Model created.");
            load();
          }}
        />
      ) : null}

      {deleting ? (
        <Modal
          title={`Delete model "${deleting.publicId}"`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={remove}>
                Delete model
              </Button>
            </>
          }
        >
          <p className="small muted">
            Usage history keeps the public ID snapshot; the request log loses
            its link to this model.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
