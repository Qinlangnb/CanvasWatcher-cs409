import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, brokerRequest } from "../api";
import { PUBLIC_BASE_PATH } from "../../publicPath";
import { UnavailableButton } from "../preview";
import { Badge, Dialog, Spinner } from "../ui";
import {
  brokerInstallCommand,
  brokerMessage,
  brokerReady,
  brokerSite,
  SOURCE_TYPE_LABELS,
  TERMINAL_STATES,
  type BrokerTicket,
  type SourceType,
} from "./model";
import { brokerApi, invalidateSources, useBrokerConfig, useBrokerHealth, useSourcesLocked } from "./queries";

/** The launcher the installer registers (auth-broker/README.md). */
export const BROKER_LAUNCH_URI = "academicwatcher://start";
const LAUNCH_WAIT_MS = 60_000;
const LAUNCH_POLL_MS = 1_500;
const STATUS_POLL_MS = 1_000;

/** Where the desktop broker is and whether it is ready right now. */
export function useBroker() {
  const config = useBrokerConfig();
  const url = config.data?.broker_url;
  const health = useBrokerHealth(url);
  const running = !health.isError && brokerReady(health.data);
  const site = running ? brokerSite(health.data, window.location, PUBLIC_BASE_PATH) : "unknown";
  // A broker registered for another site would take the ticket and then fail to claim it.
  return { url, health, running, site, ready: running && site !== "other" };
}

/** Settings → Sources: whether the desktop broker runs, with Start and Check. */
export function AuthBrokerPanel() {
  const { url, health, ready, running, site } = useBroker();
  const locked = useSourcesLocked();
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert?: boolean } | null>(null);
  const attempt = useRef(0);

  // Stale launch attempts must not update the panel after it unmounts.
  useEffect(() => () => void (attempt.current += 1), []);

  const launch = async () => {
    const current = ++attempt.current;
    setLaunching(true);
    try {
      window.location.href = BROKER_LAUNCH_URI;
      setMessage({ text: "Confirm the browser prompt to open the installed local launcher. Waiting for the broker and callback connection…" });
      const deadline = Date.now() + LAUNCH_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
        if (attempt.current !== current) return;
        const result = await health.refetch();
        if (attempt.current !== current) return;
        if (!result.isError && brokerReady(result.data)) {
          setMessage({ text: "Broker and callback connection are ready." });
          return;
        }
      }
      setMessage({
        text: "Broker did not become ready. Confirm the browser prompt and make sure the local launcher is installed on this computer, then retry Start broker.",
      });
    } catch {
      if (attempt.current === current) setMessage({ text: "Unable to open the local launcher. Install it on this computer first (see auth-broker/README.md).", alert: true });
    } finally {
      if (attempt.current === current) setLaunching(false);
    }
  };

  return (
    <section className="broker-panel" aria-labelledby="broker-heading">
      <div className="broker-panel-head">
        <h3 id="broker-heading">
          Local Auth Broker · <span className={ready ? "broker-running" : "broker-stopped"}>{ready ? "Running" : running ? "Set up for another site" : "Not running"}</span>
        </h3>
        <span className={`status-dot ${ready ? "ok" : "warn"}`} aria-hidden="true" />
      </div>
      {ready ? (
        <p className="muted">Browser sign-in is available. Passwords and MFA stay on the official sign-in pages.</p>
      ) : running ? (
        <p className="muted">
          The broker on this computer hands sessions to {health.data?.backend ?? "another site"}, not to this site, so sign-in here would fail.
        </p>
      ) : (
        <p className="muted">
          Browser-based sign-in is unavailable. The broker must run on this computer, outside Docker. If it is running, it may not be
          registered for this site.
        </p>
      )}
      {running && site !== "this" ? <BrokerReinstall outdated={site === "unknown"} version={health.data?.version} /> : null}
      {message ? (
        <p className={message.alert ? "form-error" : "inline-note"} role={message.alert ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      <div className="form-actions">
        {locked ? (
          <UnavailableButton className="button secondary">Start broker</UnavailableButton>
        ) : (
          <button type="button" className="button secondary" onClick={() => void launch()} disabled={!url || launching || ready}>
            {launching ? <Spinner size={16} /> : null}
            {launching ? "Starting broker…" : "Start broker"}
          </button>
        )}
        <button type="button" className="button ghost" onClick={() => void health.refetch()} disabled={!url || health.isFetching}>
          {health.isFetching ? <Spinner size={16} /> : null}
          Check broker
        </button>
      </div>
      <BrowserSignIn provider="all" credentialId="all" clearAll />
    </section>
  );
}

type Operation = "login" | "clear" | "clear_all";

/**
 * "Sign in with Browser" for one source, or "Clear all broker sessions" with `clearAll`. The page asks the
 * server for a challenge, hands its ticket to the broker and polls the server until the sign-in ends.
 */
export function BrowserSignIn({
  provider,
  credentialId,
  clearAll = false,
  onAuthenticated,
}: {
  provider: SourceType | "all";
  credentialId: string;
  clearAll?: boolean;
  onAuthenticated?: () => void;
}) {
  const client = useQueryClient();
  const { url, ready } = useBroker();
  const locked = useSourcesLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Operation | null>(null);
  const ticket = useRef<BrokerTicket | null>(null);
  const operation = useRef<Operation>("login");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onAuthenticated);
  done.current = onAuthenticated;
  const label = provider === "all" ? "" : SOURCE_TYPE_LABELS[provider];

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const cancel = async (quiet = false) => {
    const current = ticket.current;
    ticket.current = null;
    stopPolling();
    setBusy(false);
    if (!current) return;
    const identity = { challenge_id: current.challenge_id, instance_id: current.instance_id, provider: current.provider };
    await Promise.allSettled([
      brokerApi.cancel({ ...identity, control_token: current.control_token }),
      url ? brokerRequest(`${url}/cancel`, { method: "POST", body: { ...identity, one_time_token: current.one_time_token }, timeoutMs: 2_500 }) : null,
    ]);
    if (!quiet) setMessage("Sign-in cancelled.");
  };

  // A sign-in in progress is cancelled when this control goes away or the broker address changes.
  useEffect(() => () => void cancel(true), [url]);

  const poll = (current: BrokerTicket) => {
    timer.current = setTimeout(async () => {
      if (ticket.current !== current) return;
      try {
        const status = await brokerApi.status({
          challenge_id: current.challenge_id,
          instance_id: current.instance_id,
          provider: current.provider,
          control_token: current.control_token,
        });
        if (ticket.current !== current) return;
        if (!TERMINAL_STATES.has(status.state)) {
          poll(current);
          return;
        }
        ticket.current = null;
        setBusy(false);
        const cleared = operation.current === "login" ? "Browser session updated." : "Browser session cleared.";
        setMessage(status.state === "AUTHENTICATED" ? cleared : brokerMessage(status.reason ?? status.state));
        invalidateSources(client);
        if (status.state === "AUTHENTICATED") done.current?.();
      } catch {
        if (ticket.current === current) setMessage("Unable to check sign-in. You can cancel and retry.");
        if (ticket.current === current) poll(current);
      }
    }, STATUS_POLL_MS);
  };

  const start = async (kind: Operation) => {
    operation.current = kind;
    setConfirming(null);
    if (!url) return;
    await cancel(true);
    setBusy(true);
    setMessage(null);
    try {
      const created = await brokerApi.challenge({ provider: clearAll ? "all" : provider, credential_id: credentialId, operation: kind });
      ticket.current = created;
      await brokerRequest(`${url}/login`, {
        method: "POST",
        body: { challenge_id: created.challenge_id, instance_id: created.instance_id, provider: created.provider, one_time_token: created.one_time_token },
        timeoutMs: 10_000,
      });
      setMessage(kind === "login" ? "Complete sign-in in the browser window. CanvasWatcher never receives your password." : "Clearing dedicated browser sessions…");
      poll(created);
    } catch (error) {
      await cancel(true);
      // The broker's own codes say why it refused (another site, busy, too old); the rest is generic.
      const code = error instanceof ApiError && error.code !== "AUTH_BROKER_ERROR" ? error.code : null;
      setMessage(code ? brokerMessage(code) : "Browser sign-in could not start. Check the Local Auth Broker and retry.");
    }
  };

  const confirmText =
    confirming === "clear_all"
      ? "Clear all dedicated broker profiles for CanvasWatcher? Academic data and API tokens remain."
      : `Clear the dedicated ${label} browser profile and session? Course data will remain.`;

  if (locked) {
    return (
      <div className="form-actions">
        {clearAll ? null : <UnavailableButton className="button primary">Sign in with Browser</UnavailableButton>}
        <UnavailableButton className="button danger-ghost">{clearAll ? "Clear all broker sessions" : `Clear ${label} browser session`}</UnavailableButton>
      </div>
    );
  }

  return (
    <div className="browser-signin">
      <div className="form-actions">
        {clearAll ? null : (
          <button type="button" className="button primary" disabled={!ready || busy} onClick={() => void start("login")}>
            {busy ? <Spinner size={16} /> : null}
            Sign in with Browser
          </button>
        )}
        <button type="button" className="button danger-ghost" disabled={!ready || busy} onClick={() => setConfirming(clearAll ? "clear_all" : "clear")}>
          {clearAll ? "Clear all broker sessions" : `Clear ${label} browser session`}
        </button>
        {busy ? (
          <button type="button" className="button ghost" onClick={() => void cancel()}>
            Cancel sign-in
          </button>
        ) : null}
      </div>
      {!ready && !clearAll ? <p className="inline-note">Use Start broker in the Local Auth Broker panel, then retry sign-in.</p> : null}
      {message ? (
        <p className="inline-note" role="status">
          {message}
        </p>
      ) : null}
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === "clear_all" ? "Clear all broker sessions?" : `Clear the ${label} browser session?`}
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setConfirming(null)}>
              Keep it
            </button>
            <button type="button" className="button danger" onClick={() => confirming && void start(confirming)}>
              Clear
            </button>
          </>
        }
      >
        <p>{confirmText}</p>
      </Dialog>
    </div>
  );
}

/**
 * How to point the broker at this site: stop it, then register it again with this site's address. Shown
 * when the broker serves another site, or is too old (before 0.8.0) to say which site it serves.
 */
function BrokerReinstall({ outdated, version }: { outdated: boolean; version?: string }) {
  const command = brokerInstallCommand(window.location, PUBLIC_BASE_PATH);
  return (
    <div className="broker-reinstall">
      <p className="inline-note">
        {outdated
          ? `This broker${version ? ` (version ${version})` : ""} is older than 0.8.0 and can't tell which site it serves. If sign-in fails, update it from auth-broker/ in this release and register it for this site:`
          : "Register it for this site with the broker's Python (the one in its .venv):"}
      </p>
      <pre className="broker-command">
        <code>{command}</code>
      </pre>
    </div>
  );
}

/** A small "Running / Not running" badge for places without the whole panel. */
export function BrokerBadge() {
  const { ready } = useBroker();
  return <Badge tone={ready ? "success" : "warning"}>{ready ? "Broker running" : "Broker not running"}</Badge>;
}
