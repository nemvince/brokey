import { Lightning, LockKey, SignIn } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiError, login } from "../api.ts";
import { Banner, Button, Field, PageHead } from "../components/ui.tsx";
import { APP_VERSION } from "../version.ts";

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
    <div className="login-page">
      <main className="login-card">
        <div className="login-brand">
          <span className="rail-mark" aria-hidden="true">
            <Lightning size={17} weight="fill" />
          </span>
          <span className="wordmark">
            brokey<span>.</span>
          </span>
        </div>
        <PageHead
          icon={<LockKey size={20} />}
          title="Admin sign in"
          description="Paste the token from your server's ADMIN_TOKEN environment variable."
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="login-form"
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
          <div className="login-actions">
            <Button
              type="submit"
              variant="primary"
              icon={<SignIn size={16} />}
              disabled={busy || token.trim() === ""}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>
        <div className="login-foot">
          <a className="small" href="/">
            Public stats
          </a>
          <span className="small muted mono">v{APP_VERSION}</span>
        </div>
      </main>
    </div>
  );
}
