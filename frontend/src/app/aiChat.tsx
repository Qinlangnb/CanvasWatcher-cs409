// AI Chat: the launcher, shown when AI is available to this account. The drawer itself (with the
// Markdown and math renderer) is loaded the first time it is opened, to keep it out of the main bundle.
import { Suspense, lazy, useState } from "react";
import { useAiStatus } from "./queries";
import { Spinner } from "./ui";

const AiChatDrawer = lazy(() => import("./aiChatDrawer"));

export function AiChat() {
  const status = useAiStatus();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!status.data?.enabled) return null;
  return (
    <>
      <button
        type="button"
        className="ai-launcher"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label="Open AI Chat"
        title="AI Chat"
      >
        <span aria-hidden="true">✦</span>
      </button>
      {loaded ? (
        <Suspense
          fallback={
            <div className="ai-loading" role="status">
              <Spinner size={16} />
              Loading AI Chat…
            </div>
          }
        >
          <AiChatDrawer open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
