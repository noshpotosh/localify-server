import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hashToken } from "../authUtils.js";
import { verifyDownloadToken } from "../signing.js";
import { userCanAccessTrack } from "../access.js";
import { safeFilename } from "../pipeline.js";

export default async function tracksRoutes(fastify) {
  fastify.get("/v1/tracks/:trackId/audio", async (request, reply) => {
    const { trackId } = request.params;
    const tokenQ = request.query.token;
    const auth = request.headers.authorization;
    const sql = fastify.sql;

    let userId = null;
    if (tokenQ) {
      const token = typeof tokenQ === "string" ? tokenQ : tokenQ[0];
      const verified = verifyDownloadToken(decodeURIComponent(token));
      if (!verified) {
        return reply.code(401).send({ detail: "Invalid or expired token" });
      }
      if (verified.trackId !== trackId) {
        return reply.code(403).send({ detail: "Token does not match track" });
      }
      userId = verified.userId;
    } else if (auth?.startsWith("Bearer ")) {
      const raw = auth.slice(7).trim();
      const th = hashToken(raw);
      const tok = await sql`SELECT user_id FROM api_tokens WHERE token_hash = ${th}`;
      if (!tok.length) {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send({ detail: "Invalid token" });
      }
      userId = String(tok[0].user_id);
    } else {
      return reply.code(401).send({ detail: "Provide token query param or Bearer authorization" });
    }

    if (!(await userCanAccessTrack(sql, userId, trackId))) {
      return reply.code(403).send({ detail: "Not allowed for this track" });
    }

    const mfRows = await sql`SELECT * FROM media_files WHERE track_id = ${trackId}`;
    const mf = mfRows[0];
    if (!mf || !mf.ready_at) {
      return reply.code(404).send({ detail: "Audio not ready yet" });
    }

    const filePath = mf.storage_path;
    if (!path.isAbsolute(filePath)) {
      return reply.code(404).send({ detail: "File missing on server" });
    }
    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) throw new Error("not file");
    } catch {
      return reply.code(404).send({ detail: "File missing on server" });
    }

    const trRows = await sql`SELECT * FROM tracks WHERE youtube_video_id = ${trackId}`;
    const tr = trRows[0];
    const filename = safeFilename(tr?.title ?? trackId, tr?.artist ?? null, trackId);

    reply.header("Content-Type", "audio/mpeg");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    return reply.send(createReadStream(filePath));
  });
}
