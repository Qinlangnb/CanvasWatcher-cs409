import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";

/**
 * An error the client can act on. The body is `{ detail, code }`: `detail` is a sentence
 * shown to the user as-is (the frontend's `api()` displays it), `code` is for client logic.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** A problem with one request body field; rendered like a validation error so forms can show it inline. */
export class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, "NOT_FOUND", "This address does not exist."));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (error instanceof HttpError) {
      res.set(error.headers).status(error.status).json({ detail: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      // Same shape as FastAPI validation errors, which the frontend already renders.
      const detail = error.issues.map((issue) => ({
        loc: ["body", ...issue.path.map(String)],
        msg: issue.message,
      }));
      res.status(422).json({ detail, code: "VALIDATION_ERROR" });
      return;
    }
    if (error instanceof FieldError) {
      res.status(422).json({ detail: [{ loc: ["body", error.field], msg: error.message }], code: "VALIDATION_ERROR" });
      return;
    }
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ detail: "The request body is not valid JSON.", code: "INVALID_JSON" });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ detail: "The request is too large.", code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    logger.error({ err: error, method: req.method, path: req.path }, "unhandled request error");
    res.status(500).json({
      detail: "Something went wrong on our side. Please try again.",
      code: "INTERNAL_ERROR",
    });
  };
}
