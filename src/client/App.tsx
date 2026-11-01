import { useEffect, useState } from "react";
import { clearAdminToken, getAdminToken } from "./api.ts";
import { ToastHost } from "./components/ui.tsx";
import { navigate, usePathname } from "./router.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { StatsPage } from "./pages/StatsPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { ProviderDetailPage } from "./pages/ProviderDetailPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { ClientKeysPage } from "./pages/ClientKeysPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";

const NAV = [
  { href: "/admin", label: "Providers" },
  { href: "/admin/models", label: "Models" },
  { href: "/admin/keys", label: "Keys" },
  { href: "/admin/usage", label: "Usage" },
];

function AdminShell(props: {
  pathname: string;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="admin-shell">
      <aside className="rail">
        <a
          className="wordmark"
          href="/admin"
          onClick={(event) => {
            event.preventDefault();
            navigate("/admin");
          }}
        >
          brokey<span>.</span>
        </a>
        <nav className="rail-nav" aria-label="Admin sections">
          {NAV.map((item) => {
            const active =
              item.href === "/admin"
                ? props.pathname === "/admin" || /^\/admin\/providers\/\d+$/.test(props.pathname)
                : props.pathname.startsWith(item.href);
            return (
              <a
                key={item.href}
                className="rail-link"
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(item.href);
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="rail-foot">
          <a
            className="small"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            Public stats
          </a>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <div className="admin-content">{props.children}</div>
      </main>
    </div>
  );
}

function AdminArea(props: { pathname: string }) {
  const [token, setToken] = useState<string | null>(() => getAdminToken());

  useEffect(() => {
    const onUnauthorized = () => setToken(null);
    window.addEventListener("brokey:unauthorized", onUnauthorized);
    return () => window.removeEventListener("brokey:unauthorized", onUnauthorized);
  }, []);

  if (!token) {
    return (
      <LoginPage
        onSignedIn={() => {
          setToken(getAdminToken());
          navigate(props.pathname);
        }}
      />
    );
  }

  const signOut = () => {
    clearAdminToken();
    setToken(null);
  };

  const detailMatch = /^\/admin\/providers\/(\d+)$/.exec(props.pathname);
  let page: React.ReactNode;
  if (detailMatch) page = <ProviderDetailPage providerId={Number(detailMatch[1])} />;
  else if (props.pathname === "/admin/models") page = <ModelsPage />;
  else if (props.pathname === "/admin/keys") page = <ClientKeysPage />;
  else if (props.pathname === "/admin/usage") page = <UsagePage />;
  else page = <ProvidersPage />;

  return (
    <AdminShell pathname={props.pathname} onSignOut={signOut}>
      {page}
    </AdminShell>
  );
}

export function App() {
  const pathname = usePathname();
  const admin = pathname === "/admin" || pathname.startsWith("/admin/");
  return (
    <>
      {admin ? <AdminArea pathname={pathname} /> : <StatsPage />}
      <ToastHost />
    </>
  );
}
