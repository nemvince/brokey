import { useState } from "react";
import type { ModelDTO, ProviderDTO } from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import { Banner, Button, Field, Modal } from "./ui.tsx";

export function ModelDialog(props: {
  mode: "create" | "edit";
  model?: ModelDTO;
  providers: ProviderDTO[];
  defaultProviderId?: number;
  onClose: () => void;
  onSaved: (model: ModelDTO) => void;
}) {
  const editing = props.mode === "edit";
  const model = props.model;
  const [providerId, setProviderId] = useState(
    String(
      model?.providerId ??
        props.defaultProviderId ??
        props.providers[0]?.id ??
        "",
    ),
  );
  const [upstreamId, setUpstreamId] = useState(model?.upstreamId ?? "");
  const [publicId, setPublicId] = useState(model?.publicId ?? "");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [contextWindow, setContextWindow] = useState(
    model?.contextWindow === null || model?.contextWindow === undefined
      ? ""
      : String(model.contextWindow),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    model?.maxOutputTokens === null || model?.maxOutputTokens === undefined
      ? ""
      : String(model.maxOutputTokens),
  );
  const [notes, setNotes] = useState(model?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = () => {
    setBusy(true);
    setError(null);
    const optionalNumber = (value: string): number | null =>
      value.trim() === "" ? null : Number(value);
    const body: Record<string, unknown> = {
      upstreamId,
      publicId: publicId.trim() === "" ? undefined : publicId,
      displayName: displayName.trim() === "" ? undefined : displayName,
      enabled,
      contextWindow: optionalNumber(contextWindow),
      maxOutputTokens: optionalNumber(maxOutputTokens),
      notes: notes.trim() === "" ? null : notes,
    };
    if (!editing) {
      body.providerId = Number(providerId);
    }
    const promise = editing
      ? adminFetch<ModelDTO>(`/api/admin/models/${model?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : adminFetch<ModelDTO>("/api/admin/models", {
          method: "POST",
          body: JSON.stringify(body),
        });
    promise
      .then((saved) => {
        setBusy(false);
        props.onSaved(saved);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <Modal
      title={editing ? `Edit ${model?.publicId}` : "Add model"}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {editing ? "Save changes" : "Add model"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label="Provider"
          hint={editing ? "A model cannot move between providers." : undefined}
        >
          <select
            className="select"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            disabled={editing}
          >
            {props.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Upstream ID" hint="The model ID the provider expects.">
          <input
            className="input mono"
            value={upstreamId}
            onChange={(event) => setUpstreamId(event.target.value)}
          />
        </Field>
        <Field label="Public ID" hint="What clients send as `model`.">
          <input
            className="input mono"
            value={publicId}
            onChange={(event) => setPublicId(event.target.value)}
            placeholder="defaults to the upstream ID"
          />
        </Field>
        <Field label="Display name">
          <input
            className="input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Context window">
          <input
            className="input mono"
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
            inputMode="numeric"
            placeholder="unset"
          />
        </Field>
        <Field label="Max output tokens">
          <input
            className="input mono"
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
            inputMode="numeric"
            placeholder="unset"
          />
        </Field>
        <Field label="Notes" full>
          <textarea
            className="input"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
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
      {editing ? (
        <p className="small muted">
          Sync status:{" "}
          {model?.upstreamAvailable ? "available upstream" : "missing upstream"}{" "}
          · last seen {model?.upstreamOwnedBy ?? "unknown vendor"}
        </p>
      ) : null}
      {error ? <Banner>{error}</Banner> : null}
    </Modal>
  );
}
