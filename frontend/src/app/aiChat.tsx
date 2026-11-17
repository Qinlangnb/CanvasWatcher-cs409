// AI Chat: a drawer that answers questions about the student's courses. The model reads tasks,
// scores, syllabi, the calendar and Canvas changes through the API's read-only tools. The
// conversation lives in this browser tab (sessionStorage) and is sent whole with each message.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useLocation } from "react-router";
import remarkGfm from "remark-gfm";
import { CloseIcon } from "./icons";
import { useAiChat, useAiStatus, useMe } from "./queries";
import type { ChatMessage } from "./types";
import { Alert, Spinner } from "./ui";

/** Messages sent per turn; older ones stay on screen but the model no longer sees them. */
const SENT_MESSAGES = 20;
const MAX_CHARS = 8000;

const SUGGESTIONS = [
  "What's due this week, and what should I start first?",
  "How is the grade calculated in my courses?",
  "What changed in Canvas recently?",
];

const storageKey = (userId: string) => `canvaswatcher.ai-chat.${userId}`;

function loadHistory(userId: string | undefined): ChatMessage[] {
  if (!userId) return [];
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((row): row is ChatMessage => (row?.role === "user" || row?.role === "assistant") && typeof row.content === "string")
      : [];
  } catch {
    return [];
  }
}

function saveHistory(userId: string | undefined, messages: ChatMessage[]): void {
  if (!userId) return;
  try {
    sessionStorage.setItem(storageKey(userId), JSON.stringify(messages.slice(-60)));
  } catch {
    // Storage full or blocked: the conversation still works until the tab closes.
  }
}

/** Links open in a new tab; images and raw HTML are never rendered. */
const markdown: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="ai-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

function Reply({ text }: { text: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown} skipHtml disallowedElements={["img"]} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function courseFromPath(path: string): number | null {
  const match = /^\/courses\/(\d+)/.exec(path);
  return match ? Number(match[1]) : null;
}

export function AiChat() {
  const status = useAiStatus();
  const me = useMe();
  const userId = me.data?.id;
  const location = useLocation();
  const chat = useAiChat();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => setMessages(loadHistory(userId)), [userId]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages, chat.isPending, open]);

  if (!status.data?.enabled) return null;

  const send = (text: string) => {
    const content = text.trim().slice(0, MAX_CHARS);
    if (!content || chat.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    saveHistory(userId, next);
    setDraft("");
    ask(next);
  };

  const ask = (conversation: ChatMessage[]) =>
    chat.mutate(
      { messages: conversation.slice(-SENT_MESSAGES), page: { path: location.pathname, course_id: courseFromPath(location.pathname) } },
      {
        onSuccess: (reply) => {
          const withReply: ChatMessage[] = [...conversation, { role: "assistant", content: reply.message }];
          setMessages(withReply);
          saveHistory(userId, withReply);
        },
      },
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };

  const restart = () => {
    chat.reset();
    setMessages([]);
    saveHistory(userId, []);
    input.current?.focus();
  };

  const lastIsUser = messages[messages.length - 1]?.role === "user";

  return (
    <>
      <button type="button" className="ai-launcher" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Open AI Chat" title="AI Chat">
        <span aria-hidden="true">✦</span>
      </button>
      <dialog
        ref={dialog}
        className="ai-drawer"
        aria-labelledby="ai-chat-title"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === dialog.current) setOpen(false);
        }}
      >
        <div className="ai-drawer-inner">
          <header className="ai-header">
            <h2 id="ai-chat-title">AI Chat</h2>
            <button type="button" className="button small ghost" onClick={restart} disabled={messages.length === 0 && !chat.isError}>
              New chat
            </button>
            <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close AI Chat">
              <CloseIcon />
            </button>
          </header>

          <div className="ai-messages" ref={list} aria-live="polite">
            {messages.length === 0 ? (
              <div className="ai-empty">
                <p className="ai-empty-title">What do you need to know?</p>
                <p className="muted">
                  Ask about due dates, scores, grading rules from the syllabus, your calendar or recent changes. Answers come from your
                  courses in CanvasWatcher.
                </p>
                <div className="ai-suggestions">
                  {SUGGESTIONS.map((text) => (
                    <button key={text} type="button" className="button small secondary" onClick={() => send(text)}>
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {messages.map((message, index) => (
              <div key={index} className={`ai-message ai-${message.role}`}>
                <span className="visually-hidden">{message.role === "user" ? "You:" : "AI Chat:"}</span>
                {message.role === "user" ? <p>{message.content}</p> : <Reply text={message.content} />}
              </div>
            ))}
            {chat.isPending ? (
              <div className="ai-message ai-assistant ai-working">
                <Spinner size={16} />
                <span>Looking through your courses…</span>
              </div>
            ) : null}
            {chat.isError && lastIsUser ? (
              <Alert
                action={
                  <button type="button" className="button small secondary" onClick={() => ask(messages)}>
                    Try again
                  </button>
                }
              >
                {chat.error.message}
              </Alert>
            ) : null}
          </div>

          <form className="ai-compose" onSubmit={submit}>
            <label htmlFor="ai-chat-input" className="visually-hidden">
              Message AI Chat
            </label>
            <textarea
              id="ai-chat-input"
              ref={input}
              rows={2}
              value={draft}
              maxLength={MAX_CHARS}
              placeholder="Ask about your courses…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={chat.isPending}
            />
            <button type="submit" className="button primary" disabled={chat.isPending || !draft.trim()}>
              Send
            </button>
          </form>
          <p className="ai-disclaimer muted">AI can be wrong. Check important dates and grades in Canvas.</p>
        </div>
      </dialog>
    </>
  );
}
