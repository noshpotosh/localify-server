import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";

export default async function healthRoutes(fastify) {
  fastify.get("/", async () => ({
    service: "localify-api",
    health: "/health",
    note: "JSON API under /v1/… (e.g. POST /v1/auth/bootstrap).",
  }));

  /** Liveness + DB + media dir (single probe for small deployments). */
  fastify.get("/health", async (request, reply) => {
    const { mediaDir } = getConfig();
    const sql = fastify.sql;
    try {
      await sql`SELECT 1`;
    } catch (e) {
      request.log.error(e);
      return reply.code(503).send({ status: "not_ready", reason: "database" });
    }
    const media = path.resolve(mediaDir);
    try {
      if (!fs.existsSync(media)) fs.mkdirSync(media, { recursive: true });
    } catch (e) {
      request.log.error(e);
      return reply.code(503).send({ status: "not_ready", reason: "media_dir" });
    }
    return { status: "ok" };
  });
}
