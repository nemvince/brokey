import { Cube, PencilSimple, Plus, Trash, Tray } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ModelDTO, ProviderDTO } from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  formatAgo,
  IconButton,
  Modal,
  PageHead,
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
      <PageHead
        icon={<Cube size={20} />}
        title="Models"
        description="The catalog clients see, and the upstream models it maps to."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} weight="bold" />}
            onClick={() => setCreating(true)}
            disabled={providers.length === 0}
            title={providers.length === 0 ? "Add a provider first" : undefined}
          >
            Add model
          </Button>
        }
      />

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
          visible.length === 0 ? (
            models.length === 0 ? (
              <EmptyState
                icon={<Cube size={20} />}
                title="No models yet"
                body="Fetch a provider's catalog to import its models, or add one by hand."
              />
            ) : (
              <EmptyState
                icon={<Tray size={20} />}
                title="No models match these filters"
                body="Clear the search or pick another provider."
              />
            )
          ) : null
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
                <IconButton
                  label="Edit model"
                  size="small"
                  icon={<PencilSimple size={16} />}
                  onClick={() => setEditing(model)}
                />
                <IconButton
                  label="Delete model"
                  variant="danger"
                  size="small"
                  icon={<Trash size={16} />}
                  onClick={() => setDeleting(model)}
                />
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
