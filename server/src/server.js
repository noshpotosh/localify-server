import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { getSql, closeDb } from "./db.js";
import { runDuePolls, processOneDownload } from "./pipeline.js";

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

  let timer;
  fastify.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await closeDb();
  });

  await fastify.ready();

  const tick = async () => {
    try {
      await runDuePolls();
    } catch (e) {
      fastify.log.error(e, "scheduler poll tick");
    }
    const n = getConfig().maxConcurrentDownloads;
    await Promise.all(
      Array.from({ length: n }, async () => {
        try {
          await processOneDownload();
        } catch (e) {
          fastify.log.error(e, "scheduler download");
        }
      })
    );
  };

  timer = setInterval(tick, getConfig().schedulerTickSeconds * 1000);
  void tick();

  return fastify;
}

const config = getConfig();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
