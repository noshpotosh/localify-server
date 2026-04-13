import { randomUUID } from "node:crypto";
import { requireUser } from "../plugins/auth.js";
import { getConfig } from "../config.js";
import { parsePlaylistId } from "../youtubeId.js";
import { fetchPlaylistTitleQuick } from "../ytdlp.js";
import { trySyncPlaylist, drainDownloadQueue } from "../pipeline.js";

function kickInitialSyncAndDrain(playlistId, log) {
  void (async () => {
    try {
      const sync = await trySyncPlaylist(playlistId);
      if (!sync.ok && sync.reason !== "not_found") {
        log.warn({ playlistId, sync }, "initial playlist sync failed");
      }
      const d = await drainDownloadQueue();
      log.info({ playlistId, downloadJobsAttempted: d.jobsAttempted }, "initial playlist: download drain finished");
    } catch (e) {
      log.error(e, "initial playlist sync/drain");
    }
  })();
}

export default async function playlistsRoutes(fastify) {
  fastify.post(
    "/v1/playlists",
    { preHandler: requireUser },
    async (request, reply) => {
      const { defaultPollIntervalSeconds } = getConfig();
      const body = request.body || {};
      const urlOrId = body.url_or_id;
      if (!urlOrId || typeof urlOrId !== "string") {
        return reply.code(400).send({ detail: "url_or_id required" });
      }
      let ytid;
      try {
        ytid = parsePlaylistId(urlOrId);
      } catch (e) {
        if (e && e.code === "VIDEO_ONLY" && e.message) {
          return reply.code(400).send({ detail: e.message });
        }
        return reply.code(400).send({ detail: "Invalid playlist URL or ID" });
      }
      const userId = request.user.id;
      const sql = fastify.sql;
      const dup = await sql`
        SELECT id FROM playlists WHERE user_id = ${userId} AND youtube_playlist_id = ${ytid}
      `;
      if (dup.length) {
        return reply.code(409).send({ detail: "Playlist already added" });
      }
      const interval = body.poll_interval_seconds ?? defaultPollIntervalSeconds;
      if (interval < 60 || interval > 86400 * 7) {
        return reply.code(422).send({ detail: "poll_interval_seconds out of range" });
      }
      const pid = randomUUID();
      const createdAt = new Date();
      const ins = await sql`
        INSERT INTO playlists (id, created_at, user_id, youtube_playlist_id, title, poll_interval_seconds, enabled)
        VALUES (${pid}, ${createdAt}, ${userId}, ${ytid}, NULL, ${interval}, true)
        RETURNING *
      `;
      let row = ins[0];
      try {
        const fetchedTitle = await fetchPlaylistTitleQuick(ytid);
        if (fetchedTitle) {
          const upd = await sql`
            UPDATE playlists SET title = ${fetchedTitle}
            WHERE id = ${pid} AND user_id = ${userId}
            RETURNING *
          `;
          if (upd.length) row = upd[0];
        }
      } catch (e) {
        request.log.warn({ err: String(e) }, "playlist title fetch after create");
      }
      kickInitialSyncAndDrain(pid, request.log);
      reply.code(201);
      return playlistOut(row);
    }
  );

  fastify.post(
    "/v1/playlists/:playlistId/refresh",
    { preHandler: requireUser },
    async (request, reply) => {
      const { playlistId } = request.params;
      const userId = request.user.id;
      const sql = fastify.sql;
      const own = await sql`
        SELECT id FROM playlists WHERE id = ${playlistId} AND user_id = ${userId}
      `;
      if (!own.length) {
        return reply.code(404).send({ detail: "Playlist not found" });
      }
      const sync = await trySyncPlaylist(playlistId);
      if (!sync.ok) {
        if (sync.reason === "not_found") {
          return reply.code(404).send({ detail: "Playlist not found" });
        }
        return reply.code(502).send({
          detail: "Could not sync playlist from YouTube",
          error: sync.error?.slice(0, 2000),
        });
      }
      const pendingRows = await sql`
        SELECT COUNT(*)::int AS n FROM download_jobs WHERE status = 'pending'
      `;
      const pendingBefore = pendingRows[0]?.n ?? 0;
      request.log.info(
        { playlistId, pendingDownloadJobs: pendingBefore },
        "playlist refresh: running download drain (awaited in this request)"
      );
      let drain = { jobsAttempted: 0 };
      try {
        drain = await drainDownloadQueue();
      } catch (e) {
        request.log.error(e, "playlist refresh: download drain threw");
        return reply.code(500).send({
          detail: "Download worker failed after sync",
          error: String(e).slice(0, 2000),
        });
      }
      request.log.info(
        { playlistId, downloadJobsAttempted: drain.jobsAttempted, pendingBefore },
        "playlist refresh: download drain finished"
      );
      return { ok: true, download_jobs_attempted: drain.jobsAttempted };
    }
  );

  fastify.get(
    "/v1/playlists",
    { preHandler: requireUser },
    async (request) => {
      const rows = await fastify.sql`
        SELECT * FROM playlists
        WHERE user_id = ${request.user.id}
        ORDER BY created_at DESC
      `;
      return rows.map(playlistOut);
    }
  );

  fastify.get(
    "/v1/playlists/:playlistId/tracks",
    { preHandler: requireUser },
    async (request, reply) => {
      const { playlistId } = request.params;
      const userId = request.user.id;
      const sql = fastify.sql;
      const plRows = await sql`
        SELECT id FROM playlists WHERE id = ${playlistId} AND user_id = ${userId}
      `;
      if (!plRows.length) {
        return reply.code(404).send({ detail: "Playlist not found" });
      }
      const rows = await sql`
        SELECT pt.position,
               t.youtube_video_id,
               t.title,
               t.artist,
               t.album,
               t.metadata_fetched_at,
               mf.ready_at
        FROM playlist_tracks pt
        INNER JOIN tracks t ON t.youtube_video_id = pt.track_id
        LEFT JOIN media_files mf ON mf.track_id = t.youtube_video_id
        WHERE pt.playlist_id = ${playlistId}
        ORDER BY pt.position ASC, pt.id ASC
      `;
      return {
        tracks: rows.map((r) => ({
          id: r.youtube_video_id,
          title: r.title,
          artist: r.artist,
          album: r.album,
          position: r.position,
          metadata_fetched_at: r.metadata_fetched_at,
          ready_at: r.ready_at,
        })),
      };
    }
  );

  fastify.patch(
    "/v1/playlists/:playlistId",
    { preHandler: requireUser },
    async (request, reply) => {
      const { playlistId } = request.params;
      const body = request.body || {};
      const sql = fastify.sql;
      const rows = await sql`
        SELECT * FROM playlists WHERE id = ${playlistId} AND user_id = ${request.user.id}
      `;
      if (!rows.length) {
        return reply.code(404).send({ detail: "Playlist not found" });
      }
      const pl = rows[0];
      let pollInterval = pl.poll_interval_seconds;
      let enabled = pl.enabled;
      if (body.poll_interval_seconds != null) {
        const v = body.poll_interval_seconds;
        if (v < 60 || v > 86400 * 7) {
          return reply.code(422).send({ detail: "poll_interval_seconds out of range" });
        }
        pollInterval = v;
      }
      if (body.enabled != null) enabled = body.enabled;
      const upd = await sql`
        UPDATE playlists SET poll_interval_seconds = ${pollInterval}, enabled = ${enabled}
        WHERE id = ${playlistId} AND user_id = ${request.user.id}
        RETURNING *
      `;
      return playlistOut(upd[0]);
    }
  );

  fastify.delete(
    "/v1/playlists/:playlistId",
    { preHandler: requireUser },
    async (request, reply) => {
      const { playlistId } = request.params;
      const sql = fastify.sql;
      const del = await sql`
        DELETE FROM playlists WHERE id = ${playlistId} AND user_id = ${request.user.id}
        RETURNING id
      `;
      if (!del.length) {
        return reply.code(404).send({ detail: "Playlist not found" });
      }
      return reply.code(204).send();
    }
  );
}

function playlistOut(pl) {
  return {
    id: pl.id,
    youtube_playlist_id: pl.youtube_playlist_id,
    title: pl.title,
    poll_interval_seconds: pl.poll_interval_seconds,
    enabled: pl.enabled,
    last_polled_at: pl.last_polled_at,
    last_error: pl.last_error,
  };
}
