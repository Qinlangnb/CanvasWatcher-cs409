// AI Chat conversations kept on the server: the browser only remembers the conversation id.
import type { Db } from "../db.js";
import type { AiConfirmation, Prisma } from "../generated/prisma/client.js";
import type { Evidence } from "./tools.js";

/** Messages the model sees per turn; older ones stay in the conversation but are not sent. */
export const HISTORY_MESSAGES = 20;
/** Messages a conversation shows when it is opened again. */
const SHOWN_MESSAGES = 200;

export type MessageKind = "message" | "confirmation" | "mutation_result";

export function presentConfirmation(row: AiConfirmation, now = new Date()) {
  // A pending one past its expiry reads as expired even before anyone tries it.
  const status = row.status === "PENDING" && row.expiresAt <= now ? "EXPIRED" : row.status;
  return {
    id: row.id,
    tool_name: row.toolName,
    summary: row.summary,
    details: row.details as unknown as { label: string; value: string }[],
    status: status.toLowerCase(),
    expires_at: row.expiresAt.toISOString(),
    /** Why a confirmed change could not be applied. */
    error: (row.result as { error?: string } | null)?.error ?? null,
  };
}

export type ConfirmationCard = ReturnType<typeof presentConfirmation>;

/** The user's conversation, or a new one when the id is missing, unknown or someone else's. */
export async function openConversation(db: Db, userId: string, id: string | null): Promise<string> {
  if (id) {
    const found = await db.aiConversation.findFirst({ where: { id, userId }, select: { id: true } });
    if (found) return found.id;
  }
  return (await db.aiConversation.create({ data: { userId }, select: { id: true } })).id;
}

export async function saveMessage(
  db: Db,
  conversationId: string,
  message: { role: "user" | "assistant"; content: string; kind?: MessageKind; toolName?: string | null; payload?: unknown },
): Promise<number> {
  const [row] = await db.$transaction([
    db.aiChatMessage.create({
      data: {
        conversationId,
        role: message.role,
        kind: message.kind ?? "message",
        content: message.content,
        toolName: message.toolName ?? null,
        ...(message.payload !== undefined ? { payload: message.payload as Prisma.InputJsonValue } : {}),
      },
      select: { id: true },
    }),
    // Keeps the conversation's updatedAt current for listing and cleanup.
    db.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
  ]);
  return row.id;
}

/** What the model is given: recent messages, with proposals and their outcome as short notes. */
export async function historyFor(db: Db, conversationId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db.aiChatMessage.findMany({
    where: { conversationId },
    orderBy: { id: "desc" },
    take: HISTORY_MESSAGES,
    select: { role: true, kind: true, content: true },
  });
  const history = rows.reverse().map((row) => ({
    role: row.role === "user" ? ("user" as const) : ("assistant" as const),
    content: row.kind === "message" ? row.content : `[${row.kind === "confirmation" ? "Proposed change" : "Outcome"}: ${row.content}]`,
  }));
  // Providers want the conversation to start with the student.
  while (history[0]?.role === "assistant") history.shift();
  return history;
}

export async function presentConversation(db: Db, userId: string, id: string) {
  const conversation = await db.aiConversation.findFirst({ where: { id, userId }, select: { id: true } });
  if (!conversation) return null;
  const [rows, confirmations] = await Promise.all([
    db.aiChatMessage.findMany({ where: { conversationId: id }, orderBy: { id: "desc" }, take: SHOWN_MESSAGES }),
    db.aiConfirmation.findMany({ where: { conversationId: id, userId } }),
  ]);
  const cards = new Map(confirmations.map((row) => [row.id, presentConfirmation(row)]));
  return {
    conversation_id: id,
    messages: rows.reverse().map((row) => {
      const payload = (row.payload ?? null) as { confirmation_id?: string; evidence?: Evidence[] } | null;
      return {
        id: row.id,
        role: row.role,
        kind: row.kind,
        content: row.content,
        tool_name: row.toolName,
        evidence: payload?.evidence ?? [],
        // Read fresh, so a card shows Applied or Expired after the fact.
        confirmation: payload?.confirmation_id ? (cards.get(payload.confirmation_id) ?? null) : null,
        created_at: row.createdAt.toISOString(),
      };
    }),
  };
}
