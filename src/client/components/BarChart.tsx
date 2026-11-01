import type { StatsRange } from "../../shared/types.ts";

type Bucket = { bucket: string; requests: number; totalTokens: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function isoHour(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:00:00Z`;
}

function isoDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Builds a continuous, zero-filled axis for the selected range. */
export function buildAxis(
  series: Bucket[],
  range: StatsRange,
  now = Date.now(),
): Bucket[] {
  const known = new Map(series.map((row) => [row.bucket, row]));
  const keys: string[] = [];

  if (range === "24h") {
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (let index = 23; index >= 0; index -= 1)
      keys.push(isoHour(currentHour - index * HOUR_MS));
  } else if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    for (let index = days - 1; index >= 0; index -= 1)
      keys.push(isoDay(today - index * DAY_MS));
  } else if (series.length > 0) {
    const sorted = [...series].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
    const first = sorted[0]?.bucket as string;
    const last = sorted[sorted.length - 1]?.bucket as string;
    const start = Date.parse(
      first.length === 10 ? `${first}T00:00:00Z` : first,
    );
    const end = Date.parse(last.length === 10 ? `${last}T00:00:00Z` : last);
    const daily = first.length === 10;
    const step = daily ? DAY_MS : HOUR_MS;
    for (let cursor = start; cursor <= end; cursor += step) {
      keys.push(daily ? isoDay(cursor) : isoHour(cursor));
    }
  }

  return keys.map(
    (bucket) => known.get(bucket) ?? { bucket, requests: 0, totalTokens: 0 },
  );
}

function shortLabel(bucket: string): string {
  if (bucket.length === 10) return bucket.slice(5);
  return `${bucket.slice(11, 13)}:00`;
}

export function BarChart(props: { series: Bucket[]; range: StatsRange }) {
  const data = buildAxis(props.series, props.range);
  const width = 1000;
  const height = 240;
  const padding = { top: 12, right: 8, bottom: 22, left: 8 };
  const plotHeight = height - padding.top - padding.bottom;
  const plotWidth = width - padding.left - padding.right;
  const maxTokens = Math.max(1, ...data.map((row) => row.totalTokens));
  const maxRequests = Math.max(1, ...data.map((row) => row.requests));
  const slot = plotWidth / Math.max(1, data.length);
  const barWidth = Math.max(1, slot * 0.62);
  const labelEvery = Math.max(1, Math.ceil(data.length / 12));

  const points = data.map((row, index) => {
    const centre = padding.left + slot * (index + 0.5);
    const value = row.totalTokens / maxTokens;
    return {
      ...row,
      centre,
      x: centre - barWidth / 2,
      barHeight: value * plotHeight,
      lineY:
        padding.top + plotHeight - (row.requests / maxRequests) * plotHeight,
    };
  });
  const linePath = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.centre.toFixed(2)} ${point.lineY.toFixed(2)}`,
    )
    .join(" ");

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Tokens per bucket with requests overlaid"
    >
      <line
        className="chart-axis"
        x1={padding.left}
        y1={padding.top + plotHeight}
        x2={width - padding.right}
        y2={padding.top + plotHeight}
      />
      {points.map((point) => (
        <g key={point.bucket}>
          <rect
            className="chart-bar"
            x={point.x}
            y={padding.top + plotHeight - point.barHeight}
            width={barWidth}
            height={Math.max(point.barHeight, point.totalTokens > 0 ? 1 : 0)}
          >
            <title>
              {`${point.bucket} — ${point.totalTokens.toLocaleString("en-US")} tokens, ${point.requests.toLocaleString("en-US")} requests`}
            </title>
          </rect>
        </g>
      ))}
      <path className="chart-line" d={linePath} />
      {points.map((point, index) =>
        index % labelEvery === 0 ? (
          <text
            key={`label-${point.bucket}`}
            className="chart-label"
            x={point.centre}
            y={height - 6}
            textAnchor="middle"
          >
            {shortLabel(point.bucket)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
