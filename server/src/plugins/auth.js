import { hashToken } from "../authUtils.js";

export async function requireUser(request, reply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return reply.code(401).header("WWW-Authenticate", "Bearer").send({
      detail: "Missing or invalid Authorization header",
    });
  }
  const raw = auth.slice(7).trim();
  if (!raw) {
    return reply.code(401).header("WWW-Authenticate", "Bearer").send({ detail: "Missing token" });
  }
  const th = hashToken(raw);
  const sql = request.server.sql;
  const tok = await sql`
    SELECT user_id FROM api_tokens WHERE token_hash = ${th}
  `;
  if (!tok.length) {
    return reply.code(401).header("WWW-Authenticate", "Bearer").send({ detail: "Invalid token" });
  }
  const users = await sql`SELECT * FROM users WHERE id = ${tok[0].user_id}`;
  if (!users.length) {
    return reply.code(401).send({ detail: "User not found" });
  }
  request.user = users[0];
}
