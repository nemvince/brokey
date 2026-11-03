import {
  Check,
  CheckCircle,
  Copy,
  Info,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Icons inherit the text colour and sit at a fixed optical size. */
export const ICON_SIZE = 16;

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "default" | "danger" | "ghost";
  size?: "normal" | "small";
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  iconRight?: ReactNode;
}) {
  const classes = ["btn"];
  if (props.variant === "primary") classes.push("btn-primary");
  if (props.variant === "danger") classes.push("btn-danger");
  if (props.variant === "ghost") classes.push("btn-ghost");
  if (props.size === "small") classes.push("btn-small");
  if (props.icon) classes.push("btn-with-icon");
  return (
    <button
      type={props.type ?? "button"}
      className={classes.join(" ")}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.icon}
      <span className="btn-label">{props.children}</span>
      {props.iconRight}
    </button>
  );
}

/** A square, icon-only control; the label is carried by `aria-label`+tooltip. */
export function IconButton(props: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  variant?: "default" | "ghost" | "danger";
  size?: "normal" | "small";
  disabled?: boolean;
  pressed?: boolean;
}) {
  const classes = ["btn", "btn-icon-only"];
  if (props.variant === "danger") classes.push("btn-danger");
  else if (props.variant !== "default") classes.push("btn-ghost");
  if (props.size === "small") classes.push("btn-small");
  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
    >
      {props.icon}
    </button>
  );
}

/**
 * The header every admin page shares: an icon tile, the title, one line of
 * explanation, and at most two primary actions on the right.
 */
export function PageHead(props: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <span className="page-head-icon" aria-hidden="true">
        {props.icon}
      </span>
      <div className="page-head-title">
        <h1>{props.title}</h1>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.badge ? (
        <div className="page-head-badge">{props.badge}</div>
      ) : null}
      <span className="spacer" />
      {props.actions ? (
        <div className="page-head-actions">{props.actions}</div>
      ) : null}
    </header>
  );
}

export function Field(props: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
  full?: boolean;
}) {
  return (
    <label className={`field${props.full ? " full" : ""}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
      {props.error ? <span className="field-error">{props.error}</span> : null}
    </label>
  );
}

export function Badge(props: {
  children: ReactNode;
  tone?: "ok" | "warn" | "danger" | "muted";
  icon?: ReactNode;
}) {
  const tone = props.tone ?? "muted";
  return (
    <span className={`badge badge-${tone}`}>
      {props.icon ?? <i className="badge-dot" aria-hidden="true" />}
      {props.children}
    </span>
  );
}

export type Column = { key: string; label: string; numeric?: boolean };

export function Table(props: {
  columns: Column[];
  children: ReactNode;
  sticky?: boolean;
  stack?: boolean;
  empty?: ReactNode;
}) {
  const classes = ["table"];
  if (props.sticky) classes.push("sticky");
  if (props.stack) classes.push("stack-sm");
  return (
    <div className="table-wrap">
      <table className={classes.join(" ")}>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.key}
                className={column.numeric ? "num" : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.empty ? (
            <tr>
              <td className="empty" colSpan={props.columns.length}>
                {props.empty}
              </td>
            </tr>
          ) : (
            props.children
          )}
        </tbody>
      </table>
    </div>
  );
}

/** What a list shows instead of rows: what is missing and how to fix it. */
export function EmptyState(props: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        {props.icon}
      </span>
      <div className="empty-state-text">
        <strong>{props.title}</strong>
        {props.body ? <span>{props.body}</span> : null}
      </div>
      {props.action ? <div>{props.action}</div> : null}
    </div>
  );
}

/** A row of icon-labelled figures; the workhorse of the inspector panels. */
export function StatList(props: {
  items: {
    label: string;
    value: ReactNode;
    icon?: ReactNode;
    title?: string;
  }[];
}) {
  return (
    <dl className="stat-list">
      {props.items.map((item) => (
        <div key={item.label} title={item.title}>
          <dt>
            {item.icon ? (
              <span className="stat-icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {item.label}
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Single-choice control where each option may carry its own icon. */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
  subtitle?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    // Focus the first field so typing starts in the form, not on Close.
    const focusable = ref.current?.querySelector<HTMLElement>(
      "input, select, textarea",
    );
    focusable?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        ref={ref}
        style={props.wide ? { width: "min(900px, 100%)" } : undefined}
      >
        <div className="modal-head">
          {props.icon ? (
            <span className="modal-icon" aria-hidden="true">
              {props.icon}
            </span>
          ) : null}
          <div className="modal-title">
            <h2>{props.title}</h2>
            {props.subtitle ? (
              <p className="small muted">{props.subtitle}</p>
            ) : null}
          </div>
          <span className="spacer" />
          <IconButton
            label="Close"
            variant="ghost"
            onClick={props.onClose}
            icon={<XCircle size={18} />}
          />
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

type Toast = { id: number; message: string; tone: "ok" | "error" };
type ToastListener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<ToastListener>();

function emit(): void {
  for (const listener of listeners) listener([...toasts]);
}

export function showToast(message: string, tone: "ok" | "error" = "ok"): void {
  const toast: Toast = { id: nextId++, message, tone };
  toasts = [...toasts, toast];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((row) => row.id !== toast.id);
    emit();
  }, 4000);
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const listener: ToastListener = (next) => setItems(next);
    listeners.add(listener);
    listener([...toasts]);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((toast) => (
        <div
          key={toast.id}
          className={`toast${toast.tone === "error" ? " toast-error" : ""}`}
        >
          {toast.tone === "error" ? (
            <WarningCircle size={18} aria-hidden="true" />
          ) : (
            <CheckCircle size={18} aria-hidden="true" />
          )}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

export function CopyButton(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="small"
      icon={copied ? <Check size={ICON_SIZE} /> : <Copy size={ICON_SIZE} />}
      onClick={() => {
        void navigator.clipboard
          .writeText(props.value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => showToast("Clipboard is unavailable.", "error"));
      }}
    >
      {copied ? "Copied" : (props.label ?? "Copy")}
    </Button>
  );
}

export function Banner(props: {
  children: ReactNode;
  tone?: "danger" | "info" | "warn";
}) {
  const tone = props.tone ?? "danger";
  const ToneIcon =
    tone === "danger" ? WarningCircle : tone === "warn" ? Info : Info;
  return (
    <div
      className={`banner${tone === "danger" ? "" : ` banner-${tone}`}`}
      role={tone === "danger" ? "alert" : undefined}
    >
      <ToneIcon size={18} className="banner-icon" aria-hidden="true" />
      <div className="banner-text">{props.children}</div>
    </div>
  );
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

// Dashboards render figures in fixed-width slots; full digit grouping needs
// hundreds of pixels, so anything 6 digits or longer is shown compactly ("1.2M").
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCompact(value: number): string {
  return Math.abs(value) < 100_000
    ? formatNumber(value)
    : compact.format(value);
}

export function formatTime(value: number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

export function formatAgo(value: number | null): string {
  if (value === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
