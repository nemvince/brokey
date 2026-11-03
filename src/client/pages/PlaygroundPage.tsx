import {
  ArrowClockwise,
  Cube,
  Code,
  Copy,
  ChatCircleDots,
  Check,
  Flask,
  Gauge,
  Hash,
  Lightning,
  PaperPlaneRight,
  Robot,
  SlidersHorizontal,
  Sparkle,
  Stop,
  Timer,
  Trash,
  User,
  WarningCircle,
  Gift,
  Key,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaygroundModelDTO,
  PlaygroundResult,
} from "../../shared/types.ts";
import { adminFetch, ApiError, getAdminToken } from "../api.ts";
import {
  Badge,
  Button,
  formatNumber,
  IconButton,
  PageHead,
  Segmented,
  StatList,
} from "../components/ui.tsx";

type Role = "system" | "user" | "assistant";

type Turn = {
  id: number;
  role: Role;
  content: string;
  /** Assistant output still arriving. */
  pending?: boolean;
  error?: string | null;
  usage?: PlaygroundResult["usage"];
  status?: number;
  latencyMs?: number;
};

type WireMessage = { role: Role; content: string };

const SYSTEM_PROMPT_KEY = "brokey.playground.systemPrompt";
const SETTINGS_KEY = "brokey.playground.settings";

type Settings = { temperature: string; maxTokens: string; stream: boolean };

const DEFAULT_SETTINGS: Settings = {
  temperature: "",
  maxTokens: "",
  stream: true,
};

const SUGGESTIONS = [
  {
    title: "Introduce yourself",
    hint: "A cheap check that the model answers at all.",
    prompt:
      "In two sentences, say what model you are and what you are good at.",
  },
  {
    title: "Reason about a number",
    hint: "Exercises longer generation and reasoning effort.",
    prompt:
      "A shop sells 3 items at 12 EUR, 5 at 7 EUR and 2 at 19 EUR. What is the total, and which item contributes most?",
  },
  {
    title: "Follow a format",
    hint: "Shows whether instructions survive the proxy's rewriting.",
    prompt:
      "List three use cases for an OpenAI-compatible proxy as a JSON array of strings. Output JSON only.",
  },
];

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      temperature:
        typeof parsed.temperature === "string" ? parsed.temperature : "",
      maxTokens: typeof parsed.maxTokens === "string" ? parsed.maxTokens : "",
      stream: parsed.stream !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Rough token count: enough to warn before a prompt blows the context. */
function estimateTokens(messages: WireMessage[]): number {
  const chars = messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  return Math.ceil(chars / 4) + 4 * messages.length;
}

export function PlaygroundPage() {
  const [models, setModels] = useState<PlaygroundModelDTO[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    () => localStorage.getItem(SYSTEM_PROMPT_KEY) ?? "",
  );
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    adminFetch<{ models: PlaygroundModelDTO[] }>("/api/admin/playground/models")
      .then((body) => {
        setModels(body.models);
        setModelsError(null);
        setModel((current) => current || body.models[0]?.publicId || "");
      })
      .catch((cause: unknown) =>
        setModelsError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    localStorage.setItem(SYSTEM_PROMPT_KEY, systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Stick to the bottom only while the reader has not scrolled up. An empty
  // transcript is always read from the top, so its suggestions stay visible.
  // The scroll runs after paint so the message just added is fully measured.
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    if (turns.length === 0) {
      node.scrollTop = 0;
      return;
    }
    if (!stickRef.current) return;
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [turns, busy]);

  // Grow the composer with its content, up to the CSS max-height.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [draft]);

  const selected = models.find((row) => row.publicId === model) ?? null;

  const patchTurn = (id: number, patch: Partial<Turn>) => {
    setTurns((current) =>
      current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)),
    );
  };

  const history = useMemo(
    () =>
      turns
        .filter(
          (turn) =>
            !turn.pending && turn.error == null && turn.content.trim() !== "",
        )
        .map((turn) => ({ role: turn.role, content: turn.content })),
    [turns],
  );

  /** The exact payload the proxy will see, for the token estimate. */
  const requestPreview: WireMessage[] = useMemo(() => {
    const base: WireMessage[] = [
      ...(systemPrompt.trim() === ""
        ? []
        : [{ role: "system" as const, content: systemPrompt }]),
      ...history,
    ];
    if (draft.trim() !== "") base.push({ role: "user", content: draft });
    return base;
  }, [systemPrompt, history, draft]);

  const runExchange = async (
    messages: WireMessage[],
    options: { userText?: string; replaceId?: number } = {},
  ) => {
    if (busy) return;
    const userTurn: Turn | null =
      options.userText === undefined
        ? null
        : {
            id: nextId.current++,
            role: "user",
            content: options.userText,
          };
    const assistantId = options.replaceId ?? nextId.current++;
    const assistantTurn: Turn = {
      id: assistantId,
      role: "assistant",
      content: "",
      pending: true,
    };

    setTurns((current) => {
      const next = userTurn ? [...current, userTurn] : [...current];
      if (options.replaceId !== undefined) {
        return next.map((turn) =>
          turn.id === options.replaceId ? assistantTurn : turn,
        );
      }
      return [...next, assistantTurn];
    });

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    stickRef.current = true;

    const body = {
      model,
      systemPrompt: systemPrompt.trim() === "" ? undefined : systemPrompt,
      messages,
      stream: settings.stream,
      temperature:
        settings.temperature.trim() === ""
          ? undefined
          : Number(settings.temperature),
      maxTokens:
        settings.maxTokens.trim() === ""
          ? undefined
          : Number(settings.maxTokens),
    };

    try {
      const token = getAdminToken() ?? "";
      const response = await fetch("/api/admin/playground/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          window.dispatchEvent(new Event("brokey:unauthorized"));
        }
        let message = `${response.status} ${response.statusText}`;
        try {
          const parsed = (await response.json()) as {
            error?: { message?: string };
          };
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // keep the status text
        }
        throw new ApiError(response.status, message);
      }

      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        const result = (await response.json()) as PlaygroundResult;
        patchTurn(assistantId, {
          content: result.content,
          pending: false,
          error: result.error,
          usage: result.usage,
          status: result.status,
          latencyMs: result.latencyMs,
        });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("The response had no body.");
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let usage: PlaygroundResult["usage"] | undefined;
      let streamError: string | null = null;
      const started = performance.now();

      const consume = (frame: string) => {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let event: unknown;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          if (!event || typeof event !== "object") continue;
          const record = event as Record<string, unknown>;
          if (typeof record.delta === "string") {
            text += record.delta;
            patchTurn(assistantId, { content: text });
          }
          if (typeof record.error === "string") streamError = record.error;
          if (record.usage && typeof record.usage === "object") {
            usage = record.usage as PlaygroundResult["usage"];
          }
        }
      };

      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          consume(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() !== "") consume(buffer);

      patchTurn(assistantId, {
        content: text,
        pending: false,
        error: streamError,
        usage,
        status: streamError ? 502 : 200,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (cause) {
      const aborted = controller.signal.aborted;
      patchTurn(assistantId, {
        pending: false,
        error: aborted
          ? "Stopped before the reply finished."
          : cause instanceof Error
            ? cause.message
            : String(cause),
      });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const send = () => {
    const prompt = draft.trim();
    if (prompt === "" || busy || model === "") return;
    setDraft("");
    void runExchange(
      [
        ...(systemPrompt.trim() === ""
          ? []
          : [{ role: "system" as const, content: systemPrompt }]),
        ...history,
        { role: "user", content: prompt },
      ],
      { userText: prompt },
    );
  };

  /** Re-ask the same exchange, keeping the prompt but replacing the answer. */
  const retry = (turnId: number) => {
    if (busy || model === "") return;
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 1) return;
    const before = turns
      .slice(0, index)
      .filter(
        (turn) =>
          !turn.pending && turn.error == null && turn.content.trim() !== "",
      )
      .map((turn) => ({ role: turn.role, content: turn.content }));
    if (before.length === 0) return;
    void runExchange(
      [
        ...(systemPrompt.trim() === ""
          ? []
          : [{ role: "system" as const, content: systemPrompt }]),
        ...before,
      ],
      { replaceId: turnId },
    );
  };

  const stop = () => abortRef.current?.abort();

  const clear = () => {
    if (busy) return;
    setTurns([]);
  };

  const copyTurn = (turn: Turn) => {
    void navigator.clipboard
      .writeText(turn.content)
      .then(() => {
        setCopiedId(turn.id);
        setTimeout(
          () => setCopiedId((id) => (id === turn.id ? null : id)),
          1500,
        );
      })
      .catch(() => undefined);
  };

  const totals = turns.reduce(
    (sum, turn) =>
      turn.usage
        ? {
            prompt: sum.prompt + turn.usage.promptTokens,
            completion: sum.completion + turn.usage.completionTokens,
          }
        : sum,
    { prompt: 0, completion: 0 },
  );

  const contextWindow = selected?.contextWindow ?? null;
  const estimatedPrompt = estimateTokens(requestPreview);
  const overContext =
    contextWindow !== null && estimatedPrompt > contextWindow * 0.9;

  const lane = selected?.providerKind === "opencode" ? "free tier" : "key pool";

  return (
    <>
      <PageHead
        icon={<Flask size={20} />}
        title="Playground"
        description="Send a prompt through the proxy and watch exactly what a client would get."
        actions={
          <Button
            variant="ghost"
            icon={<Trash size={16} />}
            onClick={clear}
            disabled={busy || turns.length === 0}
          >
            Clear
          </Button>
        }
      />

      {modelsError ? (
        <div className="banner banner-warn" role="alert">
          <WarningCircle size={18} className="banner-icon" aria-hidden="true" />
          <div className="banner-text">
            {modelsError} Open Providers to add one, then Models to expose it.
          </div>
        </div>
      ) : null}

      <div className="pg">
        <section className="panel pg-console">
          <div className="pg-bar">
            <div className="pg-model">
              <Flask size={16} className="muted" aria-hidden="true" />
              <select
                className="select"
                aria-label="Model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={busy || models.length === 0}
              >
                {models.length === 0 ? (
                  <option value="">No enabled models</option>
                ) : null}
                {models.map((row) => (
                  <option key={row.publicId} value={row.publicId}>
                    {row.publicId}
                  </option>
                ))}
              </select>
            </div>
            <div className="pg-bar-actions">
              {selected ? (
                <Badge
                  tone={selected.providerKind === "opencode" ? "warn" : "ok"}
                  icon={
                    selected.providerKind === "opencode" ? (
                      <Gift size={13} />
                    ) : (
                      <Key size={13} />
                    )
                  }
                >
                  {lane}
                </Badge>
              ) : null}
              <IconButton
                label="Run settings"
                icon={<SlidersHorizontal size={16} />}
                pressed={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              />
              <IconButton
                label="Show raw text"
                icon={<Code size={16} />}
                pressed={showRaw}
                onClick={() => setShowRaw((raw) => !raw)}
              />
            </div>
          </div>

          <div className="pg-settings" hidden={!settingsOpen}>
            <div className="pg-settings-grid">
              <label className="field">
                <span className="field-label">Temperature</span>
                <input
                  className="input mono"
                  inputMode="decimal"
                  placeholder="provider default"
                  value={settings.temperature}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      temperature: event.target.value,
                    })
                  }
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span className="field-label">Max tokens</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  placeholder={
                    selected?.maxOutputTokens
                      ? String(selected.maxOutputTokens)
                      : "provider default"
                  }
                  value={settings.maxTokens}
                  onChange={(event) =>
                    setSettings({ ...settings, maxTokens: event.target.value })
                  }
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span className="field-label">Delivery</span>
                <Segmented
                  ariaLabel="Delivery"
                  value={settings.stream ? "stream" : "buffered"}
                  onChange={(next) =>
                    setSettings({ ...settings, stream: next === "stream" })
                  }
                  options={[
                    { value: "stream", label: "Stream" },
                    { value: "buffered", label: "Complete" },
                  ]}
                />
              </label>
              <label className="field system-prompt">
                <span className="field-label">System prompt</span>
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Optional. Sent before the conversation."
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  disabled={busy}
                />
              </label>
            </div>
            <p className="pg-settings-hint">
              Settings apply to the next message. Runs use a real provider key
              and appear in Usage, but never charge a client key.
            </p>
          </div>

          <div
            className="pg-log"
            ref={logRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              stickRef.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            {turns.length === 0 ? (
              <div className="pg-empty">
                <span className="pg-empty-icon" aria-hidden="true">
                  <ChatCircleDots size={26} />
                </span>
                <h2>Test a model end to end</h2>
                <p>
                  A run goes through the same path as a client request: provider
                  key selection, failover, cooldowns, and the usage log.
                </p>
                <div className="pg-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      type="button"
                      className="pg-suggestion"
                      onClick={() => {
                        setDraft(suggestion.prompt);
                        textareaRef.current?.focus();
                      }}
                    >
                      <Sparkle size={16} />
                      <span>
                        <strong>{suggestion.title}</strong>
                        {suggestion.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn) => {
                const RoleIcon =
                  turn.role === "user"
                    ? User
                    : turn.role === "system"
                      ? SlidersHorizontal
                      : Robot;
                return (
                  <article
                    key={turn.id}
                    className={`msg msg-${turn.role}${
                      turn.pending && turn.role === "assistant"
                        ? " msg-streaming"
                        : ""
                    }`}
                  >
                    <span className="msg-avatar" aria-hidden="true">
                      <RoleIcon size={16} />
                    </span>
                    <div className="msg-main">
                      <div className="msg-head">
                        <span className="msg-role">
                          {turn.role === "assistant"
                            ? "Model"
                            : turn.role === "user"
                              ? "You"
                              : "System"}
                        </span>
                        <span className="msg-chips">
                          {turn.pending ? (
                            <Badge tone="warn">streaming</Badge>
                          ) : null}
                          {turn.error && !turn.pending ? (
                            <Badge tone="danger">failed</Badge>
                          ) : null}
                          {turn.latencyMs !== undefined ? (
                            <span className="small muted">
                              {formatNumber(turn.latencyMs)} ms
                            </span>
                          ) : null}
                          {turn.usage ? (
                            <span className="small muted mono">
                              {formatNumber(turn.usage.promptTokens)} in ·{" "}
                              {formatNumber(turn.usage.completionTokens)} out
                            </span>
                          ) : null}
                        </span>
                        <span className="spacer" />
                        <span className="msg-actions">
                          {turn.content !== "" ? (
                            <IconButton
                              label="Copy reply"
                              size="small"
                              icon={
                                copiedId === turn.id ? (
                                  <Check size={15} />
                                ) : (
                                  <Copy size={15} />
                                )
                              }
                              onClick={() => copyTurn(turn)}
                            />
                          ) : null}
                          {turn.role === "assistant" &&
                          !turn.pending &&
                          !busy ? (
                            <IconButton
                              label="Send again"
                              size="small"
                              icon={<ArrowClockwise size={15} />}
                              onClick={() => retry(turn.id)}
                            />
                          ) : null}
                        </span>
                      </div>
                      {turn.content !== "" ? (
                        showRaw ? (
                          <pre className="msg-body mono">{turn.content}</pre>
                        ) : (
                          <div className="msg-body">{turn.content}</div>
                        )
                      ) : turn.pending ? (
                        <div className="msg-body muted small">
                          Waiting for the first token…
                        </div>
                      ) : turn.error ? null : (
                        <div className="msg-empty">(empty reply)</div>
                      )}
                      {turn.error ? (
                        <div className="msg-error">
                          <WarningCircle size={16} aria-hidden="true" />
                          <span>
                            {turn.status ? `${turn.status} · ` : ""}
                            {turn.error}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="pg-composer">
            <textarea
              ref={textareaRef}
              aria-label="Message"
              value={draft}
              placeholder={
                models.length === 0
                  ? "No model is available yet."
                  : "Send a prompt to " + (model || "a model") + "…"
              }
              disabled={busy || models.length === 0}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && busy) {
                  event.preventDefault();
                  stop();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="pg-composer-foot">
              <span className="pg-hint">
                <span className="kbd">Enter</span> send
                <span className="kbd">Shift</span>
                <span className="kbd">Enter</span> newline
              </span>
              <span className="spacer" />
              <span
                className="pg-count"
                title="Rough prompt size for the next request"
              >
                ~{formatNumber(estimatedPrompt)} tokens
                {contextWindow ? ` / ${formatNumber(contextWindow)}` : ""}
              </span>
              {overContext ? (
                <span className="small" style={{ color: "var(--warn)" }}>
                  near the context limit
                </span>
              ) : null}
              {busy ? (
                <Button
                  variant="danger"
                  size="small"
                  icon={<Stop size={15} weight="fill" />}
                  onClick={stop}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="small"
                  iconRight={<PaperPlaneRight size={15} weight="fill" />}
                  onClick={send}
                  disabled={model === "" || draft.trim() === ""}
                >
                  Send
                </Button>
              )}
            </div>
          </div>
        </section>

        <aside className="pg-side">
          <section className="panel">
            <div className="panel-head">
              <h2>
                <span className="panel-icon" aria-hidden="true">
                  <Gauge size={16} />
                </span>
                This session
              </h2>
            </div>
            <StatList
              items={[
                {
                  label: "Messages",
                  value: formatNumber(turns.length),
                  icon: <ChatCircleDots size={14} />,
                },
                {
                  label: "Prompt tokens",
                  value: formatNumber(totals.prompt),
                  icon: <Lightning size={14} />,
                },
                {
                  label: "Completion tokens",
                  value: formatNumber(totals.completion),
                  icon: <Sparkle size={14} />,
                },
                {
                  label: "Delivery",
                  value: settings.stream ? "streamed" : "complete",
                  icon: <Timer size={14} />,
                },
              ]}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>
                <span className="panel-icon" aria-hidden="true">
                  <Cube size={16} />
                </span>
                Model
              </h2>
            </div>
            {selected ? (
              <StatList
                items={[
                  {
                    label: "Routing ID",
                    value: <span className="mono">{selected.publicId}</span>,
                    title: selected.publicId,
                  },
                  {
                    label: "Provider",
                    value: selected.providerName,
                    icon: <Hash size={14} />,
                  },
                  {
                    label: "Lane",
                    value: lane,
                    icon:
                      selected.providerKind === "opencode" ? (
                        <Gift size={14} />
                      ) : (
                        <Key size={14} />
                      ),
                  },
                  {
                    label: "Context",
                    value: selected.contextWindow
                      ? formatNumber(selected.contextWindow)
                      : "—",
                  },
                  {
                    label: "Max output",
                    value: selected.maxOutputTokens
                      ? formatNumber(selected.maxOutputTokens)
                      : "—",
                  },
                ]}
              />
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                No enabled model. Add a provider, sync its catalog, and enable a
                model.
              </p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
