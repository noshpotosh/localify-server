import { randomUUID } from "node:crypto";
import { newApiToken, hashToken } from "../authUtils.js";

export default async function authRoutes(fastify) {
  fastify.post(
    "/v1/auth/bootstrap",
    async (request, reply) => {
      const body = request.body || {};
      const installationId = String(body.installation_id || "").trim();
      if (installationId.length < 8 || installationId.length > 128) {
        return reply.code(422).send({ detail: "installation_id must be 8–128 characters" });
      }
      const sql = fastify.sql;
      let rows = await sql`SELECT * FROM users WHERE installation_id = ${installationId}`;
      let userId;
      if (!rows.length) {
        const uid = randomUUID();
        const now = new Date();
        const ins = await sql`
          INSERT INTO users (id, installation_id, email, password_hash, created_at)
          VALUES (${uid}, ${installationId}, NULL, NULL, ${now})
          RETURNING id
        `;
        userId = ins[0].id;
      } else {
        userId = rows[0].id;
      }
      await sql`DELETE FROM api_tokens WHERE user_id = ${userId}`;
      const raw = newApiToken();
      const tokId = randomUUID();
      const tokNow = new Date();
      await sql`
        INSERT INTO api_tokens (id, user_id, token_hash, created_at)
        VALUES (${tokId}, ${userId}, ${hashToken(raw)}, ${tokNow})
      `;
      return { access_token: raw, token_type: "bearer" };
    }
  );
}
