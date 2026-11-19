// The AI Chat drawer. The conversation is kept on the server; this browser remembers only its id
// (localStorage, per account), so it comes back after a reload or on another tab. Changes the model
// proposes show as confirmation cards and happen only when the student confirms them.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import {
  useConversation,
  useResolveConfirmation,
  useSendChat,
  type Confirmation,
  type Evidence,
  type StoredMessage,
} from "./aiApi";
import { apiHref, isApiError } from "./api";
import { ChatMarkdown } from "./chatMarkdown";
import { CloseIcon } from "./icons";
import { useMe } from "./queries";
import { Alert, Badge, Spinner } from "./ui";

const MAX_CHARS = 8000;

const SUGGESTIONS = [
  "What's due this week, and what should I start first?",
  "How is the grade calculated in my courses?",
  "What changed in Canvas recently?",
];

const storageKey = (userId: string) => `canvaswatcher.ai-conversation.${userId}`;

function loadConversationId(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    const value = localStorage.getItem(storageKey(userId));
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function saveConversationId(userId: string | undefined, id: string | null): void {
  if (!userId) return;
  try {
    if (id) localStorage.setItem(storageKey(userId), id);
    else localStorage.removeItem(storageKey(userId));
  } catch {
    // Storage blocked: the conversation still works until the page is closed.
  }
}

function courseFromPath(path: string): number | null {
  const match = /^\/courses\/(\d+)/.exec(path);
  return match ? Number(match[1]) : null;
}

function EvidenceCards({ items, onNavigate }: { items: Evidence[]; onNavigate: () => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="ai-evidence" aria-label="Evidence">
      {items.map((item, index) => (
        <li key={`${item.route}-${index}`} className="ai-evidence-card">
          <span className="ai-evidence-label">Evidence</span>
          <span className="ai-evidence-title">{item.title}</span>
          {item.summary ? <span className="ai-evidence-summary muted">{item.summary}</span> : null}
          {item.route ? (
            item.route.startsWith("/api/") ? (
              <a className="ai-evidence-open" href={apiHref(item.route)} target="_blank" rel="noreferrer noopener">
                Open
              </a>
            ) : (
              <Link className="ai-evidence-open" to={item.route} onClick={onNavigate}>
                Open
              </Link>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABELS: Record<Confirmation["status"], { text: string; tone: "success" | "neutral" | "warning" | "danger" | "accent" }> = {
  pending: { text: "Waiting for you", tone: "accent" },
  applying: { text: "Applying", tone: "accent" },
  applied: { text: "Applied", tone: "success" },
  cancelled: { text: "Cancelled", tone: "neutral" },
  expired: { text: "Expired", tone: "warning" },
  failed: { text: "Not applied", tone: "danger" },
};

function ConfirmationCard({ confirmation, onResolved }: { confirmation: Confirmation; onResolved: () => Promise<unknown> }) {
  const resolve = useResolveConfirmation();
  const [problem, setProblem] = useState<string | null>(null);
  const expired = confirmation.status === "pending" && Date.parse(confirmation.expires_at) <= Date.now();
  const status = expired ? "expired" : confirmation.status;
  const label = STATUS_LABELS[status];
  const act = (action: "confirm" | "cancel") => {
    setProblem(null);
    resolve.mutate(
      { confirmation_id: confirmation.id, action },
      {
        onSuccess: () => void onResolved(),
        onError: (error) => {
          // Already decided elsewhere or expired: show the stored state.
          if (isApiError(error, 409) || isApiError(error, 410)) void onResolved();
          setProblem(error.message);
        },
      },
    );
  };
  return (
    <div className="ai-confirmation" role="group" aria-labelledby={`confirm-${confirmation.id}`}>
      <p className="ai-confirmation-eyebrow">Confirmation required</p>
      <p className="ai-confirmation-summary" id={`confirm-${confirmation.id}`}>
        {confirmation.summary}
      </p>
      <dl className="ai-confirmation-details">
        {confirmation.details.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
      </dl>
      {status === "pending" ? (
        <div className="ai-confirmation-actions">
          <button type="button" className="button small primary" disabled={resolve.isPending} onClick={() => act("confirm")}>
            {resolve.isPending && resolve.variables?.action === "confirm" ? <Spinner size={14} /> : null}
            Confirm
          </button>
          <button type="button" className="button small secondary" disabled={resolve.isPending} onClick={() => act("cancel")}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="ai-confirmation-status">
          <Badge tone={label.tone}>{label.text}</Badge>
          {confirmation.error ? <span className="muted"> {confirmation.error}</span> : null}
        </p>
      )}
      {problem ? <p className="field-error">{problem}</p> : null}
    </div>
  );
}

function MessageView({ message, onNavigate, onResolved }: { message: StoredMessage; onNavigate: () => void; onResolved: () => Promise<unknown> }) {
  if (message.kind === "confirmation") {
    return message.confirmation ? <ConfirmationCard confirmation={message.confirmation} onResolved={onResolved} /> : null;
  }
  if (message.kind === "mutation_result") {
    return <p className="ai-outcome muted">{message.content}</p>;
  }
  return (
    <div className={`ai-message ai-${message.role}`}>
      <span className="visually-hidden">{message.role === "user" ? "You:" : "AI Chat:"}</span>
      {message.role === "user" ? <p>{message.content}</p> : <ChatMarkdown text={message.content} />}
      {message.role === "assistant" ? <EvidenceCards items={message.evidence} onNavigate={onNavigate} /> : null}
    </div>
  );
}

export default function AiChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const userId = me.data?.id;
  const location = useLocation();
  const client = useQueryClient();
  const chat = useSendChat();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [conversationId, setConversationId] = useState<string | null>(() => loadConversationId(userId));
  const conversation = useConversation(conversationId);
  /** The message being sent, shown until the stored conversation includes it. */
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => setConversationId(loadConversationId(userId)), [userId]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const messages = conversation.data?.messages ?? [];

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, pending, chat.isPending, open]);

  const reload = (id: string | null) => client.invalidateQueries({ queryKey: ["ai-conversation", id] });

  const ask = (content: string) =>
    chat.mutate(
      { conversation_id: conversationId, message: content, page: { path: location.pathname, course_id: courseFromPath(location.pathname) } },
      {
        onSuccess: async (turn) => {
          if (turn.conversation_id !== conversationId) {
            saveConversationId(userId, turn.conversation_id);
            setConversationId(turn.conversation_id);
          }
          await reload(turn.conversation_id);
          setPending(null);
        },
      },
    );

  const send = (text: string) => {
    const content = text.trim().slice(0, MAX_CHARS);
    if (!content || chat.isPending) return;
    setPending(content);
    setDraft("");
    ask(content);
  };

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
    setPending(null);
    saveConversationId(userId, null);
    setConversationId(null);
    input.current?.focus();
  };

  const empty = messages.length === 0 && pending === null;

  return (
    <dialog
      ref={dialog}
      className="ai-drawer"
      aria-labelledby="ai-chat-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="ai-drawer-inner">
        <header className="ai-header">
          <h2 id="ai-chat-title">AI Chat</h2>
          <button type="button" className="button small ghost" onClick={restart} disabled={empty && !chat.isError}>
            New chat
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close AI Chat">
            <CloseIcon />
          </button>
        </header>

        <div className="ai-messages" ref={list} aria-live="polite">
          {conversation.isFetching && messages.length === 0 && conversationId ? <Spinner size={16} label="Loading the conversation" /> : null}
          {empty && !conversation.isFetching ? (
            <div className="ai-empty">
              <p className="ai-empty-title">What do you need to know?</p>
              <p className="muted">
                Ask about courses, tasks, files, changes, Today or your calendar. Answers come from your courses in CanvasWatcher, and
                changes always need your confirmation.
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
          {messages.map((message) => (
            <MessageView key={message.id} message={message} onNavigate={onClose} onResolved={() => reload(conversationId)} />
          ))}
          {pending !== null ? (
            <div className="ai-message ai-user">
              <span className="visually-hidden">You:</span>
              <p>{pending}</p>
            </div>
          ) : null}
          {chat.isPending ? (
            <div className="ai-message ai-assistant ai-working">
              <Spinner size={16} />
              <span>Working with your course data…</span>
            </div>
          ) : null}
          {chat.isError && pending !== null ? (
            <Alert
              action={
                <button type="button" className="button small secondary" onClick={() => ask(pending)}>
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
            aria-describedby="ai-chat-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={chat.isPending}
          />
          <button type="submit" className="button primary" disabled={chat.isPending || !draft.trim()}>
            Send
          </button>
        </form>
        <p className="ai-disclaimer muted" id="ai-chat-hint">
          Enter to send · Shift+Enter for a new line. AI can be wrong; check important dates and grades in Canvas.
        </p>
      </div>
    </dialog>
  );
}
