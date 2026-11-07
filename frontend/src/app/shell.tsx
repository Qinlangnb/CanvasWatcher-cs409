import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router";
import { isApiError } from "./api";
import { DemoBanner } from "./demo";
import { timeAgo } from "./format";
import { BellIcon, BookIcon, CalendarIcon, FolderIcon, GearIcon, LogoMark, SunIcon, SyncIcon } from "./icons";
import { useConnection, useMe, useSync, useUnreadCount } from "./queries";
import { TaskEditorProvider } from "./tasks";
import { useToast } from "./toast";
import type { SyncRun } from "./types";
import { Alert, Spinner, useFocusHeading } from "./ui";

/** Re-renders every `intervalMs` so relative times ("5 minutes ago") stay true. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function FullPageLoader({ label = "Loading CanvasWatcher" }: { label?: string }) {
  return (
    <div className="full-page-center">
      <Spinner size={28} label={label} />
    </div>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="full-page-center">
      <div className="narrow-card">
        <Alert title="CanvasWatcher could not load">{message}</Alert>
        <button type="button" className="button primary" onClick={retry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** Pages that need an account. Visitors are sent to sign in and brought back afterwards. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageLoader />;
  if (me.data) return <Outlet />;
  if (me.data === null || isApiError(me.error, 401)) {
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }
  return <LoadError message={me.error?.message ?? "Unknown error."} retry={() => void me.refetch()} />;
}

/** Where RequireAuth was sending the visitor, if it is a path inside the app. */
function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : "/";
}

/** Sign-in and sign-up pages; a signed-in user (including one who just signed in) goes on to the app. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageLoader />;
  if (me.data) return <Navigate to={returnPath(location.state)} replace />;
  return <>{children}</>;
}

const NAV = [
  { to: "/", label: "Today", icon: SunIcon, end: true },
  { to: "/calendar", label: "Calendar", icon: CalendarIcon, end: false },
  { to: "/courses", label: "Courses", icon: BookIcon, end: false },
  { to: "/changes", label: "Changes", icon: BellIcon, end: false },
  { to: "/files", label: "Files", icon: FolderIcon, end: false },
  { to: "/settings", label: "Settings", icon: GearIcon, end: false },
];

/** Phones get five tabs; Settings moves to the top bar. */
const TABS = NAV.filter((item) => item.to !== "/settings");

function syncMessage(run: SyncRun): { text: string; tone: "success" | "error" | "info" } {
  const changes = run.changes_detected === 1 ? "1 change" : `${run.changes_detected} changes`;
  if (run.status === "succeeded") return { text: `Sync finished: ${changes} found.`, tone: "success" };
  if (run.status === "partial") return { text: `Sync finished with gaps: ${changes} found. ${run.error ?? ""}`, tone: "info" };
  return { text: run.error ?? "The sync failed.", tone: "error" };
}

function SyncControl({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const connection = useConnection();
  const now = useNow(30_000);
  // Both copies (sidebar and phone top bar) are always mounted; only the sidebar one reports.
  const sync = useSync(
    compact
      ? undefined
      : (run) => {
          const message = syncMessage(run);
          toast(message.text, message.tone);
        },
  );
  const rejected = connection.data?.status === "token_rejected";
  const lastSynced = connection.data?.last_synced_at ?? null;
  const status = sync.running ? "Syncing with Canvas…" : rejected ? "Canvas needs reconnecting" : `Synced ${timeAgo(lastSynced, now)}`;

  const start = () =>
    sync.start.mutate(undefined, {
      onError: (error) => toast(error.message, "error"),
    });

  if (compact) {
    return (
      <button
        type="button"
        className="icon-button"
        onClick={start}
        disabled={sync.running || rejected}
        aria-label={sync.running ? "Syncing with Canvas" : `Sync now. ${status}`}
        title={status}
      >
        <SyncIcon className={sync.running ? "spin" : undefined} />
      </button>
    );
  }
  return (
    <div className="sync-panel">
      <p className="sync-status">
        <span className={`status-dot ${sync.running ? "busy" : rejected ? "bad" : "ok"}`} aria-hidden="true" />
        {status}
      </p>
      <button type="button" className="button secondary full" onClick={start} disabled={sync.running || rejected}>
        <SyncIcon size={18} className={sync.running ? "spin" : undefined} />
        {sync.running ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}

function NavBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="nav-badge">
      {count > 99 ? "99+" : count}
      <span className="visually-hidden"> unread</span>
    </span>
  );
}

/** Sidebar on wide screens; top bar plus bottom tab bar on phones. Requires a Canvas connection. */
export function AppShell() {
  const me = useMe();
  const connection = useConnection();
  const unread = useUnreadCount(Boolean(connection.data));
  const location = useLocation();
  useFocusHeading(location.pathname);

  if (connection.isPending) return <FullPageLoader />;
  if (connection.data === null) return <Navigate to="/welcome" replace />;
  if (connection.isError) return <LoadError message={connection.error.message} retry={() => void connection.refetch()} />;

  const unreadCount = unread.data?.count;
  const rejected = connection.data.status === "token_rejected";

  return (
    <TaskEditorProvider>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <aside className="sidebar" aria-label="CanvasWatcher">
          <Link to="/" className="brand">
            <LogoMark />
            <span>CanvasWatcher</span>
          </Link>
          <nav aria-label="Main">
            <ul className="side-nav">
              {NAV.map(({ to, label, icon: NavIcon, end }) => (
                <li key={to}>
                  <NavLink to={to} end={end} className="side-nav-link">
                    <NavIcon />
                    <span>{label}</span>
                    {to === "/changes" ? <NavBadge count={unreadCount} /> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sidebar-footer">
            <SyncControl />
            <p className="signed-in-as">
              Signed in as <strong>{me.data?.username}</strong>
            </p>
          </div>
        </aside>

        <header className="topbar">
          <Link to="/" className="brand">
            <LogoMark size={26} />
            <span>CanvasWatcher</span>
          </Link>
          <div className="topbar-actions">
            <SyncControl compact />
            <NavLink to="/settings" className="icon-button topbar-settings" aria-label="Settings">
              <GearIcon />
            </NavLink>
          </div>
        </header>

        <main id="main" className="main" tabIndex={-1}>
          <DemoBanner />
          {rejected ? (
            <div className="banner">
              <Alert
                tone="warning"
                title="Canvas stopped accepting your access token"
                action={
                  <Link className="button small primary" to="/settings#canvas">
                    Reconnect
                  </Link>
                }
              >
                Your courses are not updating. Create a new token in Canvas and reconnect.
              </Alert>
            </div>
          ) : null}
          <Outlet />
        </main>

        <nav className="tabbar" aria-label="Main">
          <ul>
            {TABS.map(({ to, label, icon: NavIcon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className="tabbar-link">
                  <span className="tabbar-icon">
                    <NavIcon size={22} />
                    {to === "/changes" && unreadCount ? <span className="tabbar-dot" aria-hidden="true" /> : null}
                  </span>
                  <span>{label}</span>
                  {to === "/changes" && unreadCount ? <span className="visually-hidden">, {unreadCount} unread</span> : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </TaskEditorProvider>
  );
}
