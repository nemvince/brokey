import { useState, type ReactNode } from "react";
import type {
  EgressEntryDTO,
  EgressEntryUpdate,
  EgressPoolDTO,
  EgressPoolUpdate,
  EgressTestResult,
  OpenCodeGateDTO,
  OpenCodeIdentityDTO,
  ProviderDetailDTO,
} from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import {
  Badge,
  Banner,
  Button,
  Field,
  formatAgo,
  formatTime,
  Modal,
  showToast,
  Table,
} from "./ui.tsx";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

// The page re-renders once per second while the gate or an egress entry cools,
// so reading the clock during render keeps the countdowns live.
const remainingSeconds = (until: number | null): number | null =>
  until === null ? null : Math.max(0, Math.ceil((until - Date.now()) / 1000));

const entryList = (
  entries: EgressEntryDTO[],
  toggle?: { id: string; enabled: boolean },
): EgressEntryUpdate[] =>
  entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    enabled: toggle && toggle.id === entry.id ? toggle.enabled : entry.enabled,
    weight: entry.weight,
  }));

function IdentityPanel(props: {
  detail: ProviderDetailDTO;
  identity: OpenCodeIdentityDTO;
  gate: OpenCodeGateDTO;
  onChanged: () => void;
}) {
  const identity = props.identity;
  const gate = props.gate;
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    adminFetch<{ identity: OpenCodeIdentityDTO; gate: OpenCodeGateDTO }>(
      `/api/admin/providers/${props.detail.id}/opencode/refresh`,
      { method: "POST" },
    )
      .then(() => {
        setRefreshing(false);
        showToast("OpenCode identity refreshed.");
        props.onChanged();
      })
      .catch((cause: unknown) => {
        setRefreshing(false);
        showToast(errorMessage(cause), "error");
      });
  };

  const throttled =
    gate.status === "throttled" ? remainingSeconds(gate.throttledUntil) : null;
  const rejection = gate.lastRejection;
  const rows: Array<{ label: string; value: ReactNode }> = [
    {
      label: "Version",
      value: <span className="mono">{identity.version}</span>,
    },
    {
      label: "Channel",
      value: <span className="mono">{identity.channel}</span>,
    },
    { label: "Source", value: identity.source },
    {
      label: "SHA",
      value: (
        <span className="mono small">
          {identity.sha ? identity.sha.slice(0, 8) : "—"}
        </span>
      ),
    },
    {
      label: "User-Agent",
      value: (
        <span className="mono small" style={{ wordBreak: "break-all" }}>
          {identity.userAgent}
        </span>
      ),
    },
    {
      label: "Session",
      value: (
        <span className="mono small">
          {identity.sessionPrefix} · {identity.sessionLength} chars
        </span>
      ),
    },
    {
      label: "Chat URL",
      value: (
        <span className="mono small" style={{ wordBreak: "break-all" }}>
          {identity.chatUrl}
        </span>
      ),
    },
    {
      label: "Catalog",
      value: (
        <span className="small muted">
          {formatAgo(identity.catalogFetchedAt)}
        </span>
      ),
    },
  ];
  if (identity.availableVersion) {
    rows.push({
      label: "Available",
      value: <Badge tone="warn">available: {identity.availableVersion}</Badge>,
    });
  }

  return (
    <section className="panel" style={{ padding: 0 }}>
      <div className="panel-head" style={{ padding: "14px 16px 0" }}>
        <h2>OpenCode identity</h2>
        <span className="spacer" />
        <Badge
          tone={
            gate.status === "open"
              ? "ok"
              : gate.status === "ip-blocked"
                ? "danger"
                : "warn"
          }
        >
          {gate.status}
        </Badge>
        {throttled !== null ? (
          <span className="small muted">throttled {throttled}s</span>
        ) : null}
        <Button
          size="small"
          onClick={refresh}
          disabled={refreshing || identity.refreshInFlight}
        >
          {refreshing ? "Refreshing…" : "Refresh identity"}
        </Button>
      </div>
      {identity.lastError || identity.catalogError ? (
        <div style={{ padding: "0 16px 12px" }}>
          {identity.lastError ? <Banner>{identity.lastError}</Banner> : null}
          {identity.catalogError ? (
            <Banner tone="warn">Catalog: {identity.catalogError}</Banner>
          ) : null}
        </div>
      ) : null}
      <Table
        columns={[
          { key: "setting", label: "Setting" },
          { key: "value", label: "Value" },
        ]}
      >
        {rows.map((row) => (
          <tr key={row.label}>
            <td data-label="Setting" className="small muted">
              {row.label}
            </td>
            <td data-label="Value">{row.value}</td>
          </tr>
        ))}
      </Table>
      {rejection ? (
        <p className="small muted" style={{ padding: "12px 16px", margin: 0 }}>
          Last rejection: {formatTime(rejection.at)} · {rejection.kind} · status{" "}
          {rejection.status} · {rejection.logId ?? "no log id"} ·{" "}
          {rejection.shapeOk
            ? "shape ok"
            : `missing ${rejection.missing.join(", ")}`}{" "}
          · {rejection.model}
        </p>
      ) : null}
    </section>
  );
}

function EgressPanel(props: {
  detail: ProviderDetailDTO;
  egress: EgressPoolDTO;
  onChanged: () => void;
}) {
  const egress = props.egress;
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Record<string, EgressTestResult>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [weight, setWeight] = useState("1");
  const [direct, setDirect] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<EgressEntryDTO | null>(null);
  const [replaceUrl, setReplaceUrl] = useState("");
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [relay, setRelay] = useState("");
  const hasDirect = egress.entries.some((entry) => entry.direct);
  const parsedWeight = Number(weight);
  const weightOk =
    Number.isInteger(parsedWeight) && parsedWeight >= 1 && parsedWeight <= 100;

  const put = (
    update: EgressPoolUpdate,
    message: string,
    done?: () => void,
  ) => {
    setBusy(true);
    adminFetch<{ ok: true; egress: EgressPoolDTO }>(
      `/api/admin/providers/${props.detail.id}/egress`,
      { method: "PUT", body: JSON.stringify(update) },
    )
      .then(() => {
        setBusy(false);
        if (done) done();
        showToast(message);
        props.onChanged();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        showToast(errorMessage(cause), "error");
      });
  };

  const saveStrategy = (value: string) => {
    if (value !== "round-robin" && value !== "failover" && value !== "random")
      return;
    put({ strategy: value }, "Egress strategy saved.");
  };

  const toggle = (entry: EgressEntryDTO) =>
    put(
      {
        entries: entryList(egress.entries, {
          id: entry.id,
          enabled: !entry.enabled,
        }),
      },
      entry.enabled ? "Egress entry disabled." : "Egress entry enabled.",
    );

  const deleteEntry = (entry: EgressEntryDTO) =>
    put(
      {
        entries: entryList(
          egress.entries.filter((item) => item.id !== entry.id),
        ),
      },
      "Egress entry deleted.",
    );

  const addEntry = () => {
    setAddError(null);
    setBusy(true);
    adminFetch<{ ok: true; egress: EgressPoolDTO }>(
      `/api/admin/providers/${props.detail.id}/egress`,
      {
        method: "PUT",
        body: JSON.stringify({
          entries: [
            ...entryList(egress.entries),
            {
              label: label.trim() === "" ? undefined : label.trim(),
              url: direct ? "" : url.trim(),
              weight: parsedWeight,
            },
          ],
        }),
      },
    )
      .then(() => {
        setBusy(false);
        setAddOpen(false);
        setLabel("");
        setUrl("");
        setWeight("1");
        setDirect(false);
        showToast("Egress entry added.");
        props.onChanged();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setAddError(errorMessage(cause));
      });
  };

  const replaceEntry = () => {
    if (!replacing) return;
    setReplaceError(null);
    setBusy(true);
    const entries = entryList(egress.entries).map((entry) =>
      entry.id === replacing.id ? { ...entry, url: replaceUrl.trim() } : entry,
    );
    adminFetch<{ ok: true; egress: EgressPoolDTO }>(
      `/api/admin/providers/${props.detail.id}/egress`,
      { method: "PUT", body: JSON.stringify({ entries }) },
    )
      .then(() => {
        setBusy(false);
        setReplacing(null);
        setReplaceUrl("");
        showToast("Egress URL replaced.");
        props.onChanged();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setReplaceError(errorMessage(cause));
      });
  };

  const testAll = () => {
    setTesting(true);
    adminFetch<{ results: EgressTestResult[] }>(
      `/api/admin/providers/${props.detail.id}/egress/test`,
      { method: "POST" },
    )
      .then((body) => {
        setTesting(false);
        const next: Record<string, EgressTestResult> = {};
        for (const result of body.results) next[result.id] = result;
        setResults(next);
        showToast("Egress test finished.");
        props.onChanged();
      })
      .catch((cause: unknown) => {
        setTesting(false);
        showToast(errorMessage(cause), "error");
      });
  };

  const saveRelay = () =>
    put({ relayUrl: relay.trim() }, "Relay saved.", () => setRelay(""));

  const clearRelay = () => put({ relayUrl: null }, "Relay cleared.");

  return (
    <section className="panel" style={{ padding: 0 }}>
      <div className="panel-head" style={{ padding: "14px 16px 0" }}>
        <h2>Egress</h2>
        <span className="spacer" />
        <select
          className="input"
          style={{ width: 150 }}
          value={egress.strategy}
          onChange={(event) => saveStrategy(event.target.value)}
          disabled={busy}
          aria-label="Egress strategy"
        >
          <option value="round-robin">round-robin</option>
          <option value="failover">failover</option>
          <option value="random">random</option>
        </select>
        <Button
          size="small"
          onClick={testAll}
          disabled={testing || egress.entries.length === 0}
        >
          {testing ? "Testing…" : "Test all"}
        </Button>
        <Button size="small" onClick={() => setAddOpen(true)} disabled={busy}>
          Add egress
        </Button>
      </div>
      <Table
        columns={[
          { key: "label", label: "Label" },
          { key: "host", label: "Host" },
          { key: "status", label: "Status" },
          { key: "weight", label: "Weight", numeric: true },
          { key: "actions", label: "" },
        ]}
        stack
        empty={
          egress.entries.length === 0
            ? "No egress entries: requests leave from this host."
            : null
        }
      >
        {egress.entries.map((entry) => {
          const result = results[entry.id];
          const cooling = entry.cooling
            ? remainingSeconds(entry.cooldownUntil)
            : null;
          return (
            <tr key={entry.id}>
              <td data-label="Label">
                {entry.label}
                {entry.direct ? (
                  <>
                    {" "}
                    <Badge tone="muted">direct</Badge>
                  </>
                ) : null}
              </td>
              <td data-label="Host" className="mono small">
                {entry.host ?? "this host"}
              </td>
              <td data-label="Status">
                <Badge tone={entry.enabled ? "ok" : "muted"}>
                  {entry.enabled ? "enabled" : "disabled"}
                </Badge>
                {cooling !== null ? (
                  <span className="small muted"> cooling {cooling}s</span>
                ) : null}
                {entry.failures > 0 ? (
                  <span className="small muted">
                    {" "}
                    · failures: {entry.failures}
                  </span>
                ) : null}
                {result ? (
                  <div className="small">
                    {result.skipped ? (
                      <span className="muted">skipped</span>
                    ) : result.ok ? (
                      <span className="mono">
                        200
                        {result.latencyMs !== null &&
                        result.latencyMs !== undefined
                          ? ` · ${result.latencyMs}ms`
                          : ""}
                        {result.exitIp ? ` · ${result.exitIp}` : ""}
                      </span>
                    ) : (
                      <span style={{ color: "var(--danger)" }}>
                        {result.error ??
                          (result.status ? String(result.status) : "failed")}
                      </span>
                    )}
                  </div>
                ) : null}
                {entry.lastError ? (
                  <div
                    className="small muted"
                    title={entry.lastError}
                    style={{ maxWidth: 260, whiteSpace: "normal" }}
                  >
                    {entry.lastError.slice(0, 90)}
                    {entry.lastError.length > 90 ? "…" : ""}
                  </div>
                ) : null}
              </td>
              <td data-label="Weight" className="num">
                {entry.weight}
              </td>
              <td>
                <span className="row-actions">
                  <Button
                    size="small"
                    onClick={() => toggle(entry)}
                    disabled={busy}
                  >
                    {entry.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setReplacing(entry);
                      setReplaceUrl("");
                      setReplaceError(null);
                    }}
                    disabled={busy}
                  >
                    Replace URL
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={() => deleteEntry(entry)}
                    disabled={busy}
                  >
                    Delete
                  </Button>
                </span>
              </td>
            </tr>
          );
        })}
      </Table>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "12px 16px 16px",
        }}
      >
        <span className="small muted">Relay:</span>
        <span className="mono small">{egress.relayHost ?? "none"}</span>
        <span className="spacer" />
        <input
          className="input mono"
          style={{ width: 320 }}
          value={relay}
          onChange={(event) => setRelay(event.target.value)}
          placeholder="https://relay.example/proxy"
          aria-label="Relay URL"
        />
        <Button
          size="small"
          onClick={saveRelay}
          disabled={busy || relay.trim() === ""}
        >
          Save relay
        </Button>
        <Button
          size="small"
          onClick={clearRelay}
          disabled={busy || egress.relayHost === null}
        >
          Clear
        </Button>
      </div>

      {addOpen ? (
        <Modal
          title="Add egress"
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <Button onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={addEntry}
                disabled={busy || (!direct && url.trim() === "") || !weightOk}
              >
                Add egress
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Label" hint="Shown in the egress table.">
              <input
                className="input"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="proxy-eu"
              />
            </Field>
            <Field
              label="Proxy URL"
              hint="http(s)://[[user:pass@]host:port], no path or query."
            >
              <input
                className="input mono"
                value={direct ? "" : url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://10.0.0.2:8888"
                disabled={direct}
              />
            </Field>
            <Field label="Weight" hint="1–100; used by the random strategy.">
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
            </Field>
            <label className="checkbox full">
              <input
                type="checkbox"
                checked={direct}
                disabled={hasDirect}
                onChange={(event) => setDirect(event.target.checked)}
              />
              Direct (this host)
            </label>
          </div>
          {hasDirect ? (
            <p className="small muted">
              A direct entry already exists; delete it first to move it.
            </p>
          ) : null}
          {addError ? <Banner>{addError}</Banner> : null}
        </Modal>
      ) : null}

      {replacing ? (
        <Modal
          title={`Replace URL: ${replacing.label}`}
          onClose={() => setReplacing(null)}
          footer={
            <>
              <Button onClick={() => setReplacing(null)}>Cancel</Button>
              <Button variant="primary" onClick={replaceEntry} disabled={busy}>
                Replace URL
              </Button>
            </>
          }
        >
          <Field
            label="Proxy URL"
            hint="Empty clears the endpoint and makes this entry the direct entry."
          >
            <input
              className="input mono"
              value={replaceUrl}
              onChange={(event) => setReplaceUrl(event.target.value)}
              placeholder="http://10.0.0.2:8888"
            />
          </Field>
          {replaceError ? <Banner>{replaceError}</Banner> : null}
        </Modal>
      ) : null}
    </section>
  );
}

export function OpenCodePanels(props: {
  detail: ProviderDetailDTO;
  onChanged: () => void;
}) {
  const opencode = props.detail.opencode;
  if (!opencode) return null;
  return (
    <>
      <IdentityPanel
        detail={props.detail}
        identity={opencode.identity}
        gate={opencode.gate}
        onChanged={props.onChanged}
      />
      <EgressPanel
        detail={props.detail}
        egress={opencode.egress}
        onChanged={props.onChanged}
      />
    </>
  );
}
