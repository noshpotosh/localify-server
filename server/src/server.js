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

  const cfg = getConfig();
  fastify.log.info(
    {
      schedulerTickSeconds: cfg.schedulerTickSeconds,
      defaultPollIntervalSeconds: cfg.defaultPollIntervalSeconds,
    },
    "scheduler started (playlist polls only when due per playlist poll_interval_seconds; see logs when work runs)"
  );

  const tick = async () => {
    try {
      const pr = await runDuePolls();
      if (pr.playlistsDue > 0 || pr.playlistsPollFailed > 0) {
        fastify.log.info(pr, "playlist poll cycle");
      }
    } catch (e) {
      fastify.log.error(e, "scheduler poll tick");
    }
    const n = getConfig().maxConcurrentDownloads;
    const downloadResults = await Promise.all(
      Array.from({ length: n }, async () => {
        try {
          return await processOneDownload();
        } catch (e) {
          fastify.log.error(e, "scheduler download");
          return false;
        }
      })
    );
    const downloadAttempts = downloadResults.filter(Boolean).length;
    if (downloadAttempts > 0) {
      fastify.log.info({ downloadJobsAttempted: downloadAttempts }, "download worker cycle");
    }
  };

  timer = setInterval(tick, getConfig().schedulerTickSeconds * 1000);
  void tick();

  return fastify;
}

const config = getConfig();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
