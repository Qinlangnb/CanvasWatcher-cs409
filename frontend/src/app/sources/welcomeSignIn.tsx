import { useState } from "react";
import { AuthBrokerPanel, BrowserSignIn } from "./broker";
import { AdvancedCanvasImport } from "./canvasCard";
import { useSources } from "./queries";
import { CanvasSourceForm } from "./settingsSources";

/**
 * First-run alternative to a PAT: add the Canvas address, then sign in through the desktop Auth Broker
 * (or paste a browser session). The welcome page moves on once Canvas is connected.
 */
export function WelcomeBrowserSignIn({ onConnected }: { onConnected: () => void }) {
  const sources = useSources();
  const [advanced, setAdvanced] = useState(false);
  const canvas = sources.data?.find((source) => source.source_type === "canvas");
  return (
    <details className="welcome-browser-signin">
      <summary>Sign in with your browser instead</summary>
      <div className="stack">
        {canvas ? (
          <>
            <p className="muted">
              Canvas address: <strong>{canvas.base_url}</strong>
            </p>
            <AuthBrokerPanel />
            <BrowserSignIn provider="canvas" credentialId={canvas.id} onAuthenticated={onConnected} />
            <AdvancedCanvasImport open={advanced} onToggle={setAdvanced} baseUrl={canvas.base_url} />
          </>
        ) : (
          <>
            <p className="muted">First tell CanvasWatcher which Canvas site you use.</p>
            <CanvasSourceForm onDone={() => void sources.refetch()} stay />
          </>
        )}
      </div>
    </details>
  );
}
