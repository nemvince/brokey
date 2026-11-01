import { useState } from "react";
import { ApiError, login } from "../api.ts";
import { Banner, Button, Field } from "../components/ui.tsx";

export function LoginPage(props: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adminDisabled, setAdminDisabled] = useState(false);

  const submit = () => {
    if (token.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    login(token.trim())
      .then(() => props.onSignedIn())
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 503) {
          setAdminDisabled(true);
          setError("Admin is disabled: set ADMIN_TOKEN on the server.");
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="stats-page" style={{ maxWidth: 520 }}>
      <header className="site-head">
        <a className="wordmark" href="/">
          brokey<span>.</span>
        </a>
        <span className="spacer" />
        <a className="small" href="/">
          Public stats
        </a>
      </header>

      <section className="panel" style={{ marginTop: 28 }}>
        <h1 style={{ marginBottom: 6 }}>Admin sign in</h1>
        <p className="small muted">
          Paste the token from your server&apos;s <code>ADMIN_TOKEN</code>{" "}
          environment variable.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          style={{ display: "grid", gap: 12 }}
        >
          <Field label="Admin token">
            <input
              className="input mono"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="ADMIN_TOKEN"
            />
          </Field>
          {error ? (
            <Banner tone={adminDisabled ? "warn" : "danger"}>{error}</Banner>
          ) : null}
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || token.trim() === ""}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
