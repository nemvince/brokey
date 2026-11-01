import { useEffect, useState } from "react";
import type { StatsRange, StatsResponse } from "../../shared/types.ts";
import { publicFetch } from "../api.ts";
import { BarChart } from "../components/BarChart.tsx";
import { Banner, formatNumber, formatTime, Table } from "../components/ui.tsx";
import { navigate } from "../router.tsx";

const RANGES: StatsRange[] = ["24h", "7d", "30d", "all"];

function HeroItem(props: { label: string; value: number }) {
  return (
    <div className="hero-item">
      <span className="hero-label">{props.label}</span>
      <span className="hero-value">{formatNumber(props.value)}</span>
    </div>
  );
}

export function StatsPage() {
  const [range, setRange] = useState<StatsRange>("30d");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      publicFetch<StatsResponse>(`/api/stats?range=${range}`)
        .then((body) => {
          if (!active) return;
          setData(body);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [range]);

  const totals = data?.totals;

  return (
    <div className="stats-page">
      <header className="site-head">
        <a
          className="wordmark"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          brokey<span>.</span>
        </a>
        <span className="small muted">
          <span className="live-dot" aria-hidden="true" />
          live
        </span>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <a
          href="/admin"
          className="small"
          onClick={(event) => {
            event.preventDefault();
            navigate("/admin");
          }}
        >
          Admin
        </a>
      </header>

      {error ? (
        <div style={{ marginTop: 20 }}>
          <Banner>Statistics are unavailable: {error}</Banner>
        </div>
      ) : null}

      <section className="hero-strip" aria-label="Totals">
        <HeroItem label="Requests" value={totals?.requests ?? 0} />
        <HeroItem label="Tokens" value={totals?.totalTokens ?? 0} />
        <HeroItem label="Prompt" value={totals?.promptTokens ?? 0} />
        <HeroItem label="Completion" value={totals?.completionTokens ?? 0} />
        <HeroItem label="Errors" value={totals?.errors ?? 0} />
        <HeroItem label="Estimated" value={totals?.estimatedRequests ?? 0} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Traffic</h2>
          <span className="spacer" />
          <div className="chart-legend">
            <span>
              <i
                className="legend-swatch"
                style={{ background: "var(--series-1)" }}
              />
              tokens
            </span>
            <span>
              <i
                className="legend-swatch"
                style={{ background: "var(--series-3)" }}
              />
              requests
            </span>
          </div>
        </div>
        <BarChart series={data?.series ?? []} range={range} />
      </section>

      <div className="grid-two">
        <section className="panel" style={{ padding: 0 }}>
          <div className="panel-head" style={{ padding: "14px 16px 0" }}>
            <h2>By model</h2>
          </div>
          <Table
            columns={[
              { key: "model", label: "Model" },
              { key: "provider", label: "Provider" },
              { key: "requests", label: "Requests", numeric: true },
              { key: "tokens", label: "Tokens", numeric: true },
            ]}
            stack
            empty={(data?.byModel.length ?? 0) === 0 ? "No traffic yet." : null}
          >
            {(data?.byModel ?? []).map((row) => (
              <tr key={`${row.provider}:${row.label}`}>
                <td data-label="Model" className="mono">
                  {row.label}
                </td>
                <td data-label="Provider">{row.provider}</td>
                <td data-label="Requests" className="num">
                  {formatNumber(row.requests)}
                </td>
                <td data-label="Tokens" className="num">
                  {formatNumber(row.totalTokens)}
                </td>
              </tr>
            ))}
          </Table>
        </section>

        <section className="panel" style={{ padding: 0 }}>
          <div className="panel-head" style={{ padding: "14px 16px 0" }}>
            <h2>By provider</h2>
          </div>
          <Table
            columns={[
              { key: "provider", label: "Provider" },
              { key: "requests", label: "Requests", numeric: true },
              { key: "tokens", label: "Tokens", numeric: true },
            ]}
            stack
            empty={
              (data?.byProvider.length ?? 0) === 0 ? "No traffic yet." : null
            }
          >
            {(data?.byProvider ?? []).map((row) => (
              <tr key={row.label}>
                <td data-label="Provider">{row.label}</td>
                <td data-label="Requests" className="num">
                  {formatNumber(row.requests)}
                </td>
                <td data-label="Tokens" className="num">
                  {formatNumber(row.totalTokens)}
                </td>
              </tr>
            ))}
          </Table>
        </section>

        <section className="panel" style={{ padding: 0 }}>
          <div className="panel-head" style={{ padding: "14px 16px 0" }}>
            <h2>By client key</h2>
          </div>
          <Table
            columns={[
              { key: "key", label: "Client key" },
              { key: "prefix", label: "Prefix" },
              { key: "requests", label: "Requests", numeric: true },
              { key: "tokens", label: "Tokens", numeric: true },
            ]}
            stack
            empty={
              (data?.byClientKey.length ?? 0) === 0 ? "No traffic yet." : null
            }
          >
            {(data?.byClientKey ?? []).map((row) => (
              <tr key={`${row.label}:${row.prefix}`}>
                <td data-label="Client key">{row.label}</td>
                <td data-label="Prefix" className="mono small">
                  {row.prefix || "—"}
                </td>
                <td data-label="Requests" className="num">
                  {formatNumber(row.requests)}
                </td>
                <td data-label="Tokens" className="num">
                  {formatNumber(row.totalTokens)}
                </td>
              </tr>
            ))}
          </Table>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Today</h2>
          </div>
          <p className="small muted" style={{ marginBottom: 8 }}>
            UTC day, independent of the selected range.
          </p>
          <div style={{ display: "flex", gap: 24 }}>
            <div>
              <span className="hero-label">Requests</span>
              <span className="hero-value">
                {formatNumber(data?.today.requests ?? 0)}
              </span>
            </div>
            <div>
              <span className="hero-label">Tokens</span>
              <span className="hero-value">
                {formatNumber(data?.today.totalTokens ?? 0)}
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 20, padding: 0 }}>
        <div className="panel-head" style={{ padding: "14px 16px 0" }}>
          <h2>Recent requests</h2>
        </div>
        <Table
          columns={[
            { key: "time", label: "Time" },
            { key: "endpoint", label: "Endpoint" },
            { key: "model", label: "Model" },
            { key: "provider", label: "Provider" },
            { key: "client", label: "Client key" },
            { key: "status", label: "Status", numeric: true },
            { key: "tokens", label: "Tokens", numeric: true },
            { key: "latency", label: "Latency", numeric: true },
          ]}
          stack
          empty={
            (data?.recent.length ?? 0) === 0
              ? "Traffic will appear here after the first proxied request."
              : null
          }
        >
          {(data?.recent ?? []).map((row) => (
            <tr key={row.requestId}>
              <td data-label="Time" className="mono small">
                {formatTime(row.createdAt)}
              </td>
              <td data-label="Endpoint" className="mono small">
                {row.endpoint}
              </td>
              <td data-label="Model" className="mono small">
                {row.model || "—"}
              </td>
              <td data-label="Provider">{row.provider}</td>
              <td data-label="Client key">{row.clientKey}</td>
              <td data-label="Status" className="num">
                {row.status}
                {row.streamed ? (
                  <span className="muted small"> · stream</span>
                ) : null}
              </td>
              <td data-label="Tokens" className="num">
                {formatNumber(row.totalTokens)}
                {row.estimated ? (
                  <span className="muted small"> · est</span>
                ) : null}
              </td>
              <td data-label="Latency" className="num">
                {formatNumber(row.latencyMs)} ms
              </td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}
