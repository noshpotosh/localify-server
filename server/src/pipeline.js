import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { getSql } from "./db.js";
import { getConfig } from "./config.js";
import {
  YtdlpError,
  flatPlaylistEntries,
  fetchVideoMetadata,
  downloadAudioMp3,
} from "./ytdlp.js";

const JOB_PENDING = "pending";
const JOB_RUNNING = "running";
const JOB_DONE = "done";
const JOB_FAILED = "failed";

export function safeFilename(title, artist, videoId) {
  const base = artist ? `${title} - ${artist}` : title;
  let out = "";
  for (const c of base) {
    if (/[a-zA-Z0-9]/.test(c) || " -_.".includes(c)) out += c;
    else out += "_";
  }
  out = out.trim();
  if (!out) out = videoId;
  if (!out.toLowerCase().endsWith(".mp3")) out += ".mp3";
  return out.slice(0, 240);
}

function nowUtc() {
  return new Date();
}

export async function playlistsDueForPoll(sql) {
  const rows = await sql`
    SELECT * FROM playlists WHERE enabled = true
  `;
  const now = nowUtc();
  const due = [];
  for (const pl of rows) {
    if (!pl.last_polled_at) {
      due.push(pl);
      continue;
    }
    const last = new Date(pl.last_polled_at);
    const intervalMs = Math.max(60, pl.poll_interval_seconds) * 1000;
    if (now.getTime() - last.getTime() >= intervalMs) due.push(pl);
  }
  return due;
}

export async function pollSinglePlaylist(sql, playlist) {
  const { downloadJobMaxAttempts } = getConfig();
  const now = nowUtc();
  const { entries, playlistTitle } = await flatPlaylistEntries(playlist.youtube_playlist_id);
  if (playlistTitle) {
    await sql`UPDATE playlists SET title = ${playlistTitle} WHERE id = ${playlist.id}`;
  }

  await sql.begin(async (tx) => {
    for (let position = 0; position < entries.length; position++) {
      const { id: vid, title } = entries[position];

      const existingTrack = await tx`SELECT * FROM tracks WHERE youtube_video_id = ${vid}`;
      if (!existingTrack.length) {
        await tx`
          INSERT INTO tracks (youtube_video_id, title, metadata_fetched_at)
          VALUES (${vid}, ${title}, ${now})
        `;
      } else {
        await tx`
          UPDATE tracks SET title = ${title || existingTrack[0].title} WHERE youtube_video_id = ${vid}
        `;
      }

      const link = await tx`
        SELECT id FROM playlist_tracks
        WHERE playlist_id = ${playlist.id} AND track_id = ${vid}
      `;
      if (!link.length) {
        const ptid = randomUUID();
        await tx`
          INSERT INTO playlist_tracks (id, playlist_id, track_id, position)
          VALUES (${ptid}, ${playlist.id}, ${vid}, ${position})
        `;
      } else {
        await tx`
          UPDATE playlist_tracks SET position = ${position}
          WHERE playlist_id = ${playlist.id} AND track_id = ${vid}
        `;
      }

      const mf = await tx`SELECT * FROM media_files WHERE track_id = ${vid}`;
      const media = mf[0];
      if (!media || !media.ready_at) {
        const jobs = await tx`SELECT * FROM download_jobs WHERE track_id = ${vid}`;
        const job = jobs[0];
        if (!job) {
          const jid = randomUUID();
          await tx`
            INSERT INTO download_jobs (id, track_id, status, attempts, created_at, updated_at)
            VALUES (${jid}, ${vid}, ${JOB_PENDING}, 0, ${now}, ${now})
          `;
        } else if (job.status === JOB_FAILED && job.attempts < downloadJobMaxAttempts) {
          await tx`
            UPDATE download_jobs SET status = ${JOB_PENDING}, last_error = NULL, updated_at = ${now}
            WHERE track_id = ${vid}
          `;
        }
      }
    }

    await tx`
      UPDATE playlists SET last_polled_at = ${now}, last_error = NULL WHERE id = ${playlist.id}
    `;
  });

  for (const { id: vid } of entries) {
    const trFull = await sql`SELECT * FROM tracks WHERE youtube_video_id = ${vid}`;
    const t = trFull[0];
    if (!t) continue;
    const metaStale =
      !t.metadata_fetched_at ||
      (nowUtc().getTime() - new Date(t.metadata_fetched_at).getTime()) / 1000 > 86400;
    if (!metaStale) continue;
    try {
      const meta = await fetchVideoMetadata(vid);
      const n = nowUtc();
      await sql`
        UPDATE tracks SET
          title = ${meta.title || t.title},
          artist = ${meta.artist},
          album = ${meta.album},
          duration_seconds = ${meta.duration},
          thumbnail_url = ${meta.thumbnail},
          metadata_fetched_at = ${n}
        WHERE youtube_video_id = ${vid}
      `;
    } catch (e) {
      if (!(e instanceof YtdlpError)) throw e;
    }
  }
}

export async function markPlaylistPollError(playlistId, message) {
  const sql = getSql();
  await sql`
    UPDATE playlists SET last_error = ${message.slice(0, 2000)} WHERE id = ${playlistId}
  `;
}

export async function runDuePolls() {
  const sql = getSql();
  const due = await playlistsDueForPoll(sql);
  let polled = 0;
  let failed = 0;
  for (const pl of due) {
    const rows = await sql`SELECT * FROM playlists WHERE id = ${pl.id}`;
    const p = rows[0];
    if (!p || !p.enabled) continue;
    try {
      await pollSinglePlaylist(sql, p);
      polled += 1;
    } catch (e) {
      failed += 1;
      console.error("poll playlist", pl.id, e);
      await markPlaylistPollError(pl.id, String(e));
    }
  }
  return { playlistsDue: due.length, playlistsPolled: polled, playlistsPollFailed: failed };
}

export async function processOneDownload() {
  const sql = getSql();
  const { mediaDir, downloadJobMaxAttempts } = getConfig();

  const claimed = await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT * FROM download_jobs
      WHERE status = ${JOB_PENDING}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return null;
    const job = rows[0];
    const now = nowUtc();
    await tx`
      UPDATE download_jobs
      SET status = ${JOB_RUNNING}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = ${job.id}
    `;
    return { jobId: job.id, trackId: job.track_id };
  });

  if (!claimed) return false;

  const { jobId, trackId } = claimed;

  try {
    const filePath = await downloadAudioMp3(trackId, mediaDir);
    const size = fs.statSync(filePath).size;
    const abs = path.resolve(filePath);
    const now = nowUtc();

    await sql.begin(async (tx) => {
      const mf = await tx`SELECT * FROM media_files WHERE track_id = ${trackId}`;
      if (!mf.length) {
        const mfid = randomUUID();
        await tx`
          INSERT INTO media_files (id, track_id, storage_path, format, byte_size, ready_at, error_message)
          VALUES (${mfid}, ${trackId}, ${abs}, ${"mp3"}, ${size}, ${now}, NULL)
        `;
      } else {
        await tx`
          UPDATE media_files SET storage_path = ${abs}, byte_size = ${size}, ready_at = ${now}, error_message = NULL
          WHERE track_id = ${trackId}
        `;
      }
      await tx`
        UPDATE download_jobs SET status = ${JOB_DONE}, last_error = NULL, updated_at = ${now}
        WHERE id = ${jobId}
      `;
    });
  } catch (e) {
    const now = nowUtc();
    const isYtdlp = e instanceof YtdlpError;
    if (isYtdlp) console.warn("download failed", trackId, e.message);
    else console.error("download", trackId, e);

    await sql.begin(async (tx) => {
      const jobs = await tx`SELECT * FROM download_jobs WHERE id = ${jobId}`;
      const j = jobs[0];
      if (!j) return;
      const failPerm = j.attempts >= downloadJobMaxAttempts;
      await tx`
        UPDATE download_jobs SET
          status = ${failPerm ? JOB_FAILED : JOB_PENDING},
          last_error = ${String(e).slice(0, 2000)},
          updated_at = ${now}
        WHERE id = ${jobId}
      `;
    });
  }

  return true;
}
