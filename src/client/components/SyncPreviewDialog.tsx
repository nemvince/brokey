import { useState } from "react";
import type { ProviderDetailDTO, SyncField, SyncPreview } from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import { Badge, Banner, Button, Modal, showToast } from "./ui.tsx";

type MissingAction = "keep" | "disable" | "delete";

const FIELD_LABELS: Record<SyncField, string> = {
  displayName: "Display name",
  contextWindow: "Context window",
  maxOutputTokens: "Max output tokens",
};

export function SyncPreviewDialog(props: {
  providerId: number;
  preview: SyncPreview;
  onClose: () => void;
  onApplied: (detail: ProviderDetailDTO) => void;
}) {
  const [added, setAdded] = useState(
    props.preview.added.map((row) => ({
      upstreamId: row.upstreamId,
      publicId: row.suggestedPublicId,
      selected: true,
      aliasConflict: row.aliasConflict,
    })),
  );
  const [missing, setMissing] = useState<Record<number, MissingAction>>(() =>
    Object.fromEntries(props.preview.missing.map((row) => [row.modelId, "keep" as MissingAction])),
  );
  const [resolutions, setResolutions] = useState<Record<string, "local" | "upstream">>(() =>
    Object.fromEntries(
      props.preview.conflicts.map((row) => [`${row.modelId}:${row.field}`, "local" as const]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = () => {
    setBusy(true);
    setError(null);
    const body = {
      added: added
        .filter((row) => row.selected && row.publicId.trim() !== "")
        .map((row) => ({ upstreamId: row.upstreamId, publicId: row.publicId.trim() })),
      missing: props.preview.missing.map((row) => ({
        modelId: row.modelId,
        action: missing[row.modelId] ?? "keep",
      })),
      resolutions: props.preview.conflicts.map((row) => ({
        modelId: row.modelId,
        field: row.field,
        choice: resolutions[`${row.modelId}:${row.field}`] ?? "local",
      })),
    };
    adminFetch<ProviderDetailDTO>(`/api/admin/providers/${props.providerId}/models/apply`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((detail) => {
        setBusy(false);
        showToast("Models synced.");
        props.onApplied(detail);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const setAllUpstream = () => {
    setResolutions(
      Object.fromEntries(
        props.preview.conflicts.map((row) => [`${row.modelId}:${row.field}`, "upstream" as const]),
      ),
    );
  };

  const metadataUpdates = props.preview.matched.reduce(
    (sum, row) => sum + row.changedFields.length,
    0,
  );

  return (
    <Modal
      title="Sync models"
      wide
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={busy}>
            Apply sync
          </Button>
        </>
      }
    >
      {error ? <Banner>{error}</Banner> : null}

      <section>
        <h3>New models ({added.length})</h3>
        {added.length === 0 ? (
          <p className="small muted">No new models upstream.</p>
        ) : (
          <div className="preview-list">
            {added.map((row, index) => (
              <div className="preview-row" key={row.upstreamId}>
                <input
                  type="checkbox"
                  aria-label={`Add ${row.upstreamId}`}
                  checked={row.selected}
                  onChange={(event) => {
                    const next = [...added];
                    next[index] = { ...row, selected: event.target.checked };
                    setAdded(next);
                  }}
                />
                <span className="mono small">{row.upstreamId}</span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="input mono"
                    aria-label={`Public ID for ${row.upstreamId}`}
                    value={row.publicId}
                    onChange={(event) => {
                      const next = [...added];
                      next[index] = { ...row, publicId: event.target.value };
                      setAdded(next);
                    }}
                  />
                  {row.aliasConflict ? (
                    <span className="warn-icon" title="That name was taken; a suffix was added.">
                      !
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Missing upstream ({props.preview.missing.length})</h3>
        {props.preview.missing.length === 0 ? (
          <p className="small muted">Every local model is still upstream.</p>
        ) : (
          <div className="preview-list">
            {props.preview.missing.map((row) => (
              <div
                className="preview-row"
                key={row.modelId}
                style={{ gridTemplateColumns: "1fr 1fr 150px" }}
              >
                <span className="mono small">{row.publicId}</span>
                <span className="mono small muted">{row.upstreamId}</span>
                <select
                  className="select"
                  aria-label={`Action for ${row.publicId}`}
                  value={missing[row.modelId] ?? "keep"}
                  onChange={(event) =>
                    setMissing({ ...missing, [row.modelId]: event.target.value as MissingAction })
                  }
                >
                  <option value="keep">Keep</option>
                  <option value="disable">Disable</option>
                  <option value="delete">Delete</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>Conflicts ({props.preview.conflicts.length})</h3>
          <span className="spacer" />
          {props.preview.conflicts.length > 0 ? (
            <Button size="small" onClick={setAllUpstream}>
              Use provider for all
            </Button>
          ) : null}
        </div>
        {props.preview.conflicts.length === 0 ? (
          <p className="small muted">No field conflicts.</p>
        ) : (
          <div className="preview-list" style={{ maxHeight: 320 }}>
            {props.preview.conflicts.map((row) => {
              const key = `${row.modelId}:${row.field}`;
              const choice = resolutions[key] ?? "local";
              return (
                <div key={key} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div className="small">
                    <span className="mono">{row.publicId}</span>
                    <span className="muted"> · {FIELD_LABELS[row.field]}</span>
                  </div>
                  <div className="diff-grid" style={{ margin: "6px 0" }}>
                    <div className="diff-cell">
                      <div className="muted small">Mine</div>
                      {row.local === null ? "unset" : String(row.local)}
                    </div>
                    <div className="diff-cell">
                      <div className="muted small">Provider</div>
                      {String(row.upstream)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <label className="checkbox">
                      <input
                        type="radio"
                        name={`resolution-${key}`}
                        checked={choice === "local"}
                        onChange={() => setResolutions({ ...resolutions, [key]: "local" })}
                      />
                      Keep mine
                    </label>
                    <label className="checkbox">
                      <input
                        type="radio"
                        name={`resolution-${key}`}
                        checked={choice === "upstream"}
                        onChange={() => setResolutions({ ...resolutions, [key]: "upstream" })}
                      />
                      Use provider
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="small muted">
        {props.preview.matched.length} models checked, {metadataUpdates} metadata updates.{" "}
        <Badge tone="muted">{new Date(props.preview.fetchedAt).toISOString().slice(11, 19)} UTC</Badge>
      </p>
    </Modal>
  );
}
