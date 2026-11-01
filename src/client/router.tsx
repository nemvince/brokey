import { useEffect, useState } from "react";

type Listener = (path: string) => void;

const listeners = new Set<Listener>();

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  for (const listener of listeners) listener(path);
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const listener: Listener = (path) => setPathname(path);
    listeners.add(listener);
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return pathname;
}

export function Link(props: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={props.href}
      className={props.className}
      onClick={(event) => {
        event.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
