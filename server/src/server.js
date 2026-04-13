import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { getSql, closeDb } from "./db.js";

import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import playlistsRoutes from "./routes/playlists.js";
import manifestRoutes from "./routes/manifest.js";
import tracksRoutes from "./routes/tracks.js";

async function buildServer() {
  const config = getConfig();
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
    },
    requestIdHeader: "x-request-id",
    genReqId: (req) => req.headers["x-request-id"] || randomUUID(),
  });

  fastify.decorate("sql", getSql());

  fastify.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-ID", request.id);
  });

  await fastify.register(healthRoutes);
  await fastify.register(authRoutes);
  await fastify.register(playlistsRoutes);
  await fastify.register(manifestRoutes);
  await fastify.register(tracksRoutes);

  fastify.addHook("onClose", async () => {
    await closeDb();
  });

  await fastify.ready();

  fastify.log.info(
    {
      defaultPollIntervalSeconds: getConfig().defaultPollIntervalSeconds,
      maxConcurrentDownloads: getConfig().maxConcurrentDownloads,
    },
    "API ready (playlist sync and downloads run on POST /v1/playlists/:id/refresh or immediately after adding a playlist)"
  );

  return fastify;
}

const config = getConfig();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
