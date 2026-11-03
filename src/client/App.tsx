import {
  ChartLine,
  ClockCounterClockwise,
  Cube,
  Flask,
  Key,
  Lightning,
  PlugsConnected,
  SignOut,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { clearAdminToken, getAdminToken } from "./api.ts";
import { Button, ToastHost } from "./components/ui.tsx";
import { navigate, usePathname } from "./router.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { StatsPage } from "./pages/StatsPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { ProviderDetailPage } from "./pages/ProviderDetailPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { ClientKeysPage } from "./pages/ClientKeysPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
import { PlaygroundPage } from "./pages/PlaygroundPage.tsx";
import { APP_VERSION } from "./version.ts";

const NAV = [
  { href: "/admin", label: "Providers", icon: PlugsConnected },
  { href: "/admin/models", label: "Models", icon: Cube },
  { href: "/admin/keys", label: "Keys", icon: Key },
  { href: "/admin/usage", label: "Usage", icon: ClockCounterClockwise },
  { href: "/admin/playground", label: "Playground", icon: Flask },
];

function AdminShell(props: {
  pathname: string;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="admin-shell">
      <aside className="rail">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden="true">
            <Lightning size={17} weight="fill" />
          </span>
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
        </div>
        <nav className="rail-nav" aria-label="Admin sections">
          {NAV.map((item) => {
            const active =
              item.href === "/admin"
                ? props.pathname === "/admin" ||
                  /^\/admin\/providers\/\d+$/.test(props.pathname)
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
                <item.icon size={18} weight={active ? "fill" : "regular"} />
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
            <ChartLine size={16} />
            Public stats
          </a>
          <Button
            variant="ghost"
            size="small"
            icon={<SignOut size={16} />}
            onClick={props.onSignOut}
          >
            Sign out
          </Button>
          <span className="small muted mono version">v{APP_VERSION}</span>
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
    return () =>
      window.removeEventListener("brokey:unauthorized", onUnauthorized);
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
  if (detailMatch)
    page = <ProviderDetailPage providerId={Number(detailMatch[1])} />;
  else if (props.pathname === "/admin/models") page = <ModelsPage />;
  else if (props.pathname === "/admin/keys") page = <ClientKeysPage />;
  else if (props.pathname === "/admin/usage") page = <UsagePage />;
  else if (props.pathname === "/admin/playground") page = <PlaygroundPage />;
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
