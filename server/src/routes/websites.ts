import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { SourceConnection } from "../generated/prisma/client.js";
import type { SourceType } from "../generated/prisma/enums.js";
import { HttpError } from "../http/errors.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import { discoverCourses, listAssignments, mapAssignment, mapCourse, PRAIRIELEARN_NOTE, taskProviderFacts, unmapCourse } from "../sources/provider/service.js";
import type { Services } from "../services.js";
import { pendingResources, saveWebsite, signOutWebsite, websiteConfig, websiteInput } from "../sources/website/service.js";
import { presentSource } from "./sources.js";

const sourceNotFound = () => new HttpError(404, "SOURCE_NOT_FOUND", "That source could not be found.");
const digits = z.string().regex(/^\d{1,20}$/, "Use the numeric id.");

const credentialInput = z.object({
  username: z.string().trim().min(1, "Enter the website username.").max(256),
  password: z.string().min(1, "Enter the website password.").max(512),
});
const courseMapping = z.object({
  provider_course_id: digits,
  course_id: z.number().int().positive(),
  course_code: z.string().trim().max(60).optional(),
  name: z.string().trim().max(200).optional(),
});
const taskMapping = z.object({ provider_course_id: digits, assignment_id: digits, task_id: z.number().int().positive().nullable() });

/**
 * Course websites (add, edit, test, credential, pending resources) and Gradescope / PrairieLearn
 * (course discovery and mapping, task mapping). Mounted at /api/sources before the generic routes.
 */
export function websiteSourcesRouter(db: Db, services: Services): Router {
  const router = Router();

  const ownerOnly = (locals: Express.Locals) => {
    const { user } = currentAuth(locals);
    if (isPreview(user)) throw previewUnavailable();
    return user.id;
  };
  const load = async (userId: string, id: string, types: SourceType[]): Promise<SourceConnection> => {
    if (!z.uuid().safeParse(id).success) throw sourceNotFound();
    const source = await db.sourceConnection.findFirst({ where: { id, userId, type: { in: types } } });
    if (!source) throw sourceNotFound();
    return source;
  };
  const withSession = (id: string) => db.sourceConnection.findUniqueOrThrow({ where: { id }, include: { providerSession: true } });

  // --- Course websites ---

  /** Verifies without saving anything ("Test connection"); `connection_id` tests an edit. */
  router.post("/website/test", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const body = websiteInput.parse(req.body ?? {});
    const connectionId = typeof req.query.connection_id === "string" ? req.query.connection_id : undefined;
    if (connectionId) await load(userId, connectionId, ["WEBSITE"]);
    const outcome = await saveWebsite(db, services, userId, body, { connectionId, testOnly: true });
    res.json(outcome.verification ?? { verified: false, message: "Nothing to verify.", public_only: false });
  });

  router.post("/website", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const outcome = await saveWebsite(db, services, userId, websiteInput.parse(req.body ?? {}));
    res.status(201).json({ source: presentSource(await withSession((outcome.source as SourceConnection).id)), verification: outcome.verification });
  });

  router.put("/website/:id", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["WEBSITE"]);
    const outcome = await saveWebsite(db, services, userId, websiteInput.parse(req.body ?? {}), { connectionId: source.id });
    res.json({ source: presentSource(await withSession(source.id)), verification: outcome.verification });
  });

  /** The website's form values, credential status and pending resources (never the password). */
  router.get("/:id/website", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const source = await load(userId, req.params.id, ["WEBSITE"]);
    const [credential, course, pending] = await Promise.all([
      db.websiteCredential.findUnique({ where: { connectionId: source.id } }),
      source.courseId ? db.course.findFirst({ where: { id: source.courseId, userId } }) : null,
      pendingResources(db, userId, source.id),
    ]);
    res.json({
      config: websiteConfig(source.config),
      course: course
        ? { id: course.id, code: course.courseCode, name: course.name, term: course.termName, owned: course.ownerSourceId === source.id }
        : null,
      credential: credential
        ? {
            username: credential.username,
            state: credential.passwordCiphertext ? credential.state : "MISSING",
            present: Boolean(credential.passwordCiphertext),
            last_error_code: credential.lastErrorCode,
            verified_at: credential.verifiedAt?.toISOString() ?? null,
          }
        : null,
      pending,
    });
  });

  /** Signs in again with a new password; on success the pending resources are retried right away. */
  router.post("/:id/website/credential", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["WEBSITE"]);
    const body = credentialInput.parse(req.body ?? {});
    const config = websiteConfig(source.config);
    if (config.authentication_method !== "ntlm") throw new HttpError(409, "WEBSITE_PUBLIC", "This website is public; it has no password.");
    const outcome = await saveWebsite(
      db,
      services,
      userId,
      { base_url: source.baseUrl, authentication_method: "ntlm", protected_path_prefix: config.protected_path_prefix, probe_url: config.probe_url, ntlm: body },
      { connectionId: source.id },
    );
    let retried = null;
    if (outcome.verification?.verified) {
      const fresh = await db.sourceConnection.findUniqueOrThrow({ where: { id: source.id } });
      if (fresh.enabled) retried = await services.sourceSyncs.run(fresh).catch(() => null);
    }
    res.json({ source: presentSource(await withSession(source.id)), verification: outcome.verification, sync: retried });
  });

  router.delete("/:id/website/credential", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["WEBSITE"]);
    await signOutWebsite(db, userId, source.id);
    res.status(204).end();
  });

  // --- Gradescope / PrairieLearn ---

  router.get("/:id/provider-courses", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["GRADESCOPE", "PRAIRIELEARN"]);
    res.json(await discoverCourses(db, services, source));
  });

  router.get("/:id/course-mappings", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const source = await load(userId, req.params.id, ["GRADESCOPE", "PRAIRIELEARN"]);
    const rows = await db.providerCourseMap.findMany({ where: { sourceId: source.id }, orderBy: { id: "asc" } });
    res.json({
      note: source.type === "PRAIRIELEARN" ? PRAIRIELEARN_NOTE : null,
      mappings: rows.map((row) => ({ provider_course_id: row.providerCourseId, course_id: row.courseId, course_code: row.courseCode, name: row.name })),
    });
  });

  router.post("/:id/course-mappings", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["GRADESCOPE", "PRAIRIELEARN"]);
    res.status(201).json(await mapCourse(db, source, courseMapping.parse(req.body ?? {})));
  });

  router.delete("/:id/course-mappings/:providerCourseId", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["GRADESCOPE", "PRAIRIELEARN"]);
    await unmapCourse(db, source, digits.parse(req.params.providerCourseId));
    res.status(204).end();
  });

  /** Assignments of the linked courses; `?pending=1` only those waiting for a task choice. */
  router.get("/:id/assignments", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const source = await load(userId, req.params.id, ["GRADESCOPE"]);
    res.json(await listAssignments(db, source, req.query.pending === "1"));
  });

  router.post("/:id/task-mappings", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id, ["GRADESCOPE"]);
    res.json(await mapAssignment(db, source, taskMapping.parse(req.body ?? {})));
  });

  return router;
}

/** GET /api/tasks/:id/provider-facts: what Canvas and Gradescope each say about one task. */
export function taskFactsRouter(db: Db): Router {
  const router = Router();
  router.get("/:id/provider-facts", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");
    res.json(await taskProviderFacts(db, userId, id));
  });
  return router;
}
