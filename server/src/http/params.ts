import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Parses a numeric route id; anything else is treated as a missing resource. */
export function idParam(value: string | undefined, notFound: HttpError): number {
  const id = Number(value);
  if (!/^\d{1,10}$/.test(value ?? "") || !Number.isSafeInteger(id) || id < 1 || id > 2 ** 31 - 1) throw notFound;
  return id;
}

/** Parses query parameters; a bad value is a 400 naming the first problem. */
export function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const parsed = schema.safeParse(query);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const name = issue?.path.join(".") || "query";
  throw new HttpError(400, "INVALID_QUERY", `Invalid ${name} parameter: ${issue?.message ?? "unexpected value"}.`);
}
