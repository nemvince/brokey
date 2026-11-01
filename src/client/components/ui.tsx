import { useEffect, useRef, useState, type ReactNode } from "react";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "default" | "danger" | "ghost";
  size?: "normal" | "small";
  disabled?: boolean;
  title?: string;
}) {
  const classes = ["btn"];
  if (props.variant === "primary") classes.push("btn-primary");
  if (props.variant === "danger") classes.push("btn-danger");
  if (props.variant === "ghost") classes.push("btn-ghost");
  if (props.size === "small") classes.push("btn-small");
  return (
    <button
      type={props.type ?? "button"}
      className={classes.join(" ")}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
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

export function Badge(props: { children: ReactNode; tone?: "ok" | "warn" | "danger" | "muted" }) {
  const tone = props.tone ?? "muted";
  return <span className={`badge badge-${tone}`}>{props.children}</span>;
}

export type Column = { key: string; label: string; numeric?: boolean };

export function Table(props: {
  columns: Column[];
  children: ReactNode;
  sticky?: boolean;
  stack?: boolean;
  empty?: string | null;
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
              <th key={column.key} className={column.numeric ? "num" : undefined}>
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

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const focusable = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
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
          <h2>{props.title}</h2>
          <span className="spacer" />
          <Button variant="ghost" onClick={props.onClose}>
            Close
          </Button>
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
        <div key={toast.id} className={`toast${toast.tone === "error" ? " toast-error" : ""}`}>
          {toast.message}
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

export function Banner(props: { children: ReactNode; tone?: "danger" | "info" | "warn" }) {
  const tone = props.tone ?? "danger";
  return <div className={`banner${tone === "danger" ? "" : ` banner-${tone}`}`}>{props.children}</div>;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
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
