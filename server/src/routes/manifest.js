import { requireUser } from "../plugins/auth.js";
import { getConfig } from "../config.js";
import { signDownloadUrl } from "../signing.js";
import { safeFilename } from "../pipeline.js";

export default async function manifestRoutes(fastify) {
  fastify.get(
    "/v1/manifest",
    { preHandler: requireUser },
    async (request) => {
      const { publicBaseUrl } = getConfig();
      const sql = fastify.sql;
      const userId = request.user.id;

      const [plCounts] = await sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE enabled = true)::int AS enabled_count
        FROM playlists
        WHERE user_id = ${userId}
      `;
      const playlists_total = plCounts?.total ?? 0;
      const playlists_enabled = plCounts?.enabled_count ?? 0;

      const idRows = await sql`
        SELECT DISTINCT pt.track_id
        FROM playlist_tracks pt
        INNER JOIN playlists p ON p.id = pt.playlist_id
        WHERE p.user_id = ${userId} AND p.enabled = true
      `;
      const ids = idRows.map((r) => r.track_id);
      if (!ids.length) {
        return {
          uid: String(userId),
          files: [],
          playlists_total,
          playlists_enabled,
        };
      }

      const tracks = await sql`
        SELECT * FROM tracks
        WHERE youtube_video_id IN ${sql(ids)}
        ORDER BY title ASC
      `;

      const base = publicBaseUrl.replace(/\/+$/, "");
      const files = [];
      for (const t of tracks) {
        const token = signDownloadUrl(userId, t.youtube_video_id);
        const enc = encodeURIComponent(token);
        const url = `${base}/v1/tracks/${t.youtube_video_id}/audio?token=${enc}`;
        const mf = await sql`SELECT ready_at FROM media_files WHERE track_id = ${t.youtube_video_id}`;
        const m = mf[0];
        const updatedAt = m?.ready_at ?? t.metadata_fetched_at;
        files.push({
          id: t.youtube_video_id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          filename: safeFilename(t.title, t.artist, t.youtube_video_id),
          download_url: url,
          updated_at: updatedAt,
        });
      }

      return {
        uid: String(userId),
        files,
        playlists_total,
        playlists_enabled,
      };
    }
  );
}
