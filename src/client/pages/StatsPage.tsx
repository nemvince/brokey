import { useEffect, useMemo, useState } from "react";
import type { StatsRange, StatsResponse } from "../../shared/types.ts";
import { publicFetch } from "../api.ts";
import { BarChart } from "../components/BarChart";
import { Banner, formatCompact } from "../components/ui";
import { navigate } from "../router";

const RANGES: StatsRange[] = ["24h", "7d", "30d", "all"];

function Readout(props: { label: string; value: string; note?: string }) {
  return (
    <div className="readout-cell">
      <span className="readout-label">{props.label}</span>
      <span className="readout-figure">{props.value}</span>
      {props.note ? <span className="readout-note">{props.note}</span> : null}
    </div>
  );
}

function Meter(props: {
  label: string;
  value: number;
  total: number;
  display: string;
}) {
  // Share of the section's own total, so bars stay comparable within a list.
  const share = props.total > 0 ? props.value / props.total : 0;
  const percent = (share * 100).toFixed(share >= 0.1 || share === 0 ? 0 : 1);
  return (
    <li className="meter-row">
      <span className="meter-row-label" title={props.label}>
        {props.label}
      </span>
      <span className="meter-track" aria-hidden="true">
        <i
          style={{ width: `${Math.max(share * 100, 0.5)}%` }}
          aria-hidden="true"
        />
      </span>
      <span className="meter-row-value num">
        {props.display}
        <span className="muted small"> · {percent}%</span>
      </span>
    </li>
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
        .then((payload) => {
          if (!active) return;
          setData(payload);
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
  const tokenTotal = totals?.totalTokens ?? 0;

  const transferTotal = useMemo(
    () =>
      (data?.byTransfer ?? []).reduce((sum, row) => sum + row.totalTokens, 0),
    [data],
  );

  const modelTotal = useMemo(
    () => (data?.byModel ?? []).reduce((sum, row) => sum + row.totalTokens, 0),
    [data],
  );

  const transfer = data?.byTransfer ?? [];
  const requestTotal = useMemo(
    () => transfer.reduce((sum, row) => sum + row.requests, 0),
    [transfer],
  );
  const streamedRequests = useMemo(
    () => transfer.find((row) => row.label === "Streamed")?.requests ?? 0,
    [transfer],
  );

  const promptShare =
    tokenTotal > 0 ? (totals?.promptTokens ?? 0) / tokenTotal : 0;

  return (
    <div className="meter">
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

      <section className="readout" aria-label="Totals">
        <Readout
          label="Tokens processed"
          value={formatCompact(tokenTotal)}
          note={`${formatCompact(totals?.requests ?? 0)} requests`}
        />
        <div className="readout-cells">
          <Readout
            label="Prompt"
            value={formatCompact(totals?.promptTokens ?? 0)}
            note={`${(promptShare * 100).toFixed(0)}% of tokens`}
          />
          <Readout
            label="Completion"
            value={formatCompact(totals?.completionTokens ?? 0)}
          />
          <Readout
            label="Avg completion"
            value={formatCompact(totals?.averageCompletionTokens ?? 0)}
            note="tokens per request"
          />
          <Readout
            label="Models served"
            value={formatCompact(data?.byModel.length ?? 0)}
          />
          <Readout
            label="Errors"
            value={formatCompact(totals?.errors ?? 0)}
            note={`${formatCompact(totals?.estimatedRequests ?? 0)} estimated`}
          />
        </div>
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

      <div className="meter-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>By model</h2>
          </div>
          {(data?.byModel.length ?? 0) === 0 ? (
            <p className="small muted">No traffic yet.</p>
          ) : (
            <ul className="meter-list">
              {(data?.byModel ?? []).map((row) => (
                <Meter
                  key={row.label}
                  label={row.label}
                  value={row.totalTokens}
                  total={modelTotal}
                  display={formatCompact(row.totalTokens)}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Delivery</h2>
          </div>
          <ul className="meter-list">
            {(data?.byTransfer ?? []).map((row) => (
              <Meter
                key={row.label}
                label={row.label}
                value={row.totalTokens}
                total={transferTotal}
                display={formatCompact(row.totalTokens)}
              />
            ))}
          </ul>
          <p className="small muted meter-foot">
            {formatCompact(streamedRequests)} of {formatCompact(requestTotal)}{" "}
            requests streamed.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Today</h2>
          </div>
          <div className="stack-figures">
            <Readout
              label="Requests"
              value={formatCompact(data?.today.requests ?? 0)}
            />
            <Readout
              label="Tokens"
              value={formatCompact(data?.today.totalTokens ?? 0)}
            />
          </div>
          <p className="small muted meter-foot">
            UTC day, independent of the selected range.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Spread</h2>
          </div>
          <div className="stack-figures">
            <Readout
              label="Active client keys"
              value={formatCompact(data?.activeUsers.clientKeys ?? 0)}
            />
            <Readout
              label="Upstreams used"
              value={formatCompact(data?.activeUsers.providers ?? 0)}
            />
          </div>
          <p className="small muted meter-foot">
            Counts only — no names or identifiers are published.
          </p>
        </section>
      </div>
    </div>
  );
}
