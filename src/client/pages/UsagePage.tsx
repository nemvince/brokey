import { useEffect, useState } from "react";
import type {
  ClientKeyDTO,
  ProviderDTO,
  UsagePage as UsagePageBody,
} from "../../shared/types.ts";
import { adminFetch } from "../api.ts";
import {
  Badge,
  Banner,
  Button,
  Field,
  formatNumber,
  formatTime,
  Table,
} from "../components/ui.tsx";

const PAGE_SIZE = 50;

const RANGE_OPTIONS = [
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
  { key: "all", label: "All time", hours: 0 },
];

export function UsagePage() {
  const [data, setData] = useState<UsagePageBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ClientKeyDTO[]>([]);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [clientKeyId, setClientKeyId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("7d");
  const [page, setPage] = useState(0);

  useEffect(() => {
    adminFetch<{ clientKeys: ClientKeyDTO[] }>("/api/admin/client-keys")
      .then((body) => setKeys(body.clientKeys))
      .catch(() => setKeys([]));
    adminFetch<{ providers: ProviderDTO[] }>("/api/admin/providers")
      .then((body) => setProviders(body.providers))
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    if (clientKeyId !== "") params.set("clientKeyId", clientKeyId);
    if (providerId !== "") params.set("providerId", providerId);
    if (status !== "") params.set("status", status);
    const option = RANGE_OPTIONS.find((row) => row.key === range);
    if (option && option.hours > 0) {
      params.set("from", String(Date.now() - option.hours * 3_600_000));
    }
    adminFetch<UsagePageBody>(`/api/admin/usage?${params.toString()}`)
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [clientKeyId, providerId, status, range, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="page-head">
        <h1>Usage</h1>
        <span className="spacer" />
        <span className="small muted">
          {data ? `${formatNumber(data.total)} requests` : "loading…"}
        </span>
      </div>

      {error ? <Banner>{error}</Banner> : null}

      <div className="toolbar">
        <Field label="Client key">
          <select
            className="select"
            value={clientKeyId}
            onChange={(event) => {
              setClientKeyId(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All keys</option>
            {keys.map((key) => (
              <option key={key.id} value={String(key.id)}>
                {key.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider">
          <select
            className="select"
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={String(provider.id)}>
                {provider.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className="select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </Field>
        <Field label="Range">
          <select
            className="select"
            value={range}
            onChange={(event) => {
              setRange(event.target.value);
              setPage(0);
            }}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Table
        columns={[
          { key: "time", label: "Time" },
          { key: "requestId", label: "Request" },
          { key: "client", label: "Client key" },
          { key: "model", label: "Model" },
          { key: "provider", label: "Provider" },
          { key: "endpoint", label: "Endpoint" },
          { key: "status", label: "Status", numeric: true },
          { key: "prompt", label: "Prompt", numeric: true },
          { key: "completion", label: "Completion", numeric: true },
          { key: "total", label: "Total", numeric: true },
          { key: "latency", label: "Latency", numeric: true },
        ]}
        sticky
        stack
        empty={data && data.rows.length === 0 ? "No requests match these filters." : null}
      >
        {(data?.rows ?? []).map((row) => (
          <tr key={row.id}>
            <td data-label="Time" className="mono small">
              {formatTime(row.createdAt)}
            </td>
            <td data-label="Request" className="mono small muted">
              {row.requestId.slice(4, 12)}
            </td>
            <td data-label="Client key">{row.clientKeyLabel}</td>
            <td data-label="Model" className="mono small">
              {row.modelPublicId || "—"}
            </td>
            <td data-label="Provider">{row.providerName}</td>
            <td data-label="Endpoint" className="mono small">
              {row.method} {row.endpoint}
            </td>
            <td data-label="Status" className="num">
              {row.status >= 400 ? (
                <Badge tone="danger">{row.status}</Badge>
              ) : (
                <Badge tone="ok">{row.status}</Badge>
              )}
              {row.streamed ? <span className="muted small"> · stream</span> : null}
              {row.errorCode ? <span className="muted small"> {row.errorCode}</span> : null}
            </td>
            <td data-label="Prompt" className="num">
              {formatNumber(row.promptTokens)}
            </td>
            <td data-label="Completion" className="num">
              {formatNumber(row.completionTokens)}
            </td>
            <td data-label="Total" className="num">
              {formatNumber(row.totalTokens)}
              {row.estimated ? <span className="muted small"> · est</span> : null}
            </td>
            <td data-label="Latency" className="num">
              {formatNumber(row.latencyMs)} ms
            </td>
          </tr>
        ))}
      </Table>

      <div className="pager">
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <Button size="small" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
          Previous
        </Button>
        <Button
          size="small"
          disabled={page + 1 >= totalPages}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </Button>
      </div>
    </>
  );
}
