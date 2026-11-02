import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { AlertIcon, LogoMark } from "../icons";
import { EmptyState, PageHeader, usePageTitle } from "../ui";

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader title="Page not found" />
      <EmptyState icon={<AlertIcon size={28} />} title="There is nothing at this address" action={<Link to="/">Go to Home</Link>}>
        The link may be out of date, or the page may have moved.
      </EmptyState>
    </div>
  );
}

/** Shown when a page throws while rendering, instead of a blank screen. */
export function RouteErrorPage() {
  const error = useRouteError();
  usePageTitle("Something went wrong");
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error.";
  return (
    <div className="full-page-center">
      <main className="narrow-card stack" id="main">
        <p className="brand">
          <LogoMark />
          <span>CanvasWatcher</span>
        </p>
        <h1>Something went wrong</h1>
        <p className="muted">This page hit an unexpected error. Your data is safe; reloading usually fixes it.</p>
        <pre className="error-detail">{message}</pre>
        <div className="form-actions">
          <button type="button" className="button primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
          <Link className="button ghost" to="/" reloadDocument>
            Go to Home
          </Link>
        </div>
      </main>
    </div>
  );
}
