import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";

let cookiesMissingLogged = false;

/** Global yt-dlp flags: ffmpeg path, then YouTube auth cookies if configured. */
function ytdlpPrelude() {
  const { ffmpegLocation, ytdlpCookiesFile, ytdlpCookiesFromBrowser } = getConfig();
  const out = [];
  if (ffmpegLocation) {
    out.push("--ffmpeg-location", ffmpegLocation);
  }
  if (ytdlpCookiesFile) {
    if (existsSync(ytdlpCookiesFile)) {
      out.push("--cookies", ytdlpCookiesFile);
    } else if (!cookiesMissingLogged) {
      cookiesMissingLogged = true;
      console.warn(
        `[ytdlp] YTDLP_COOKIES_FILE is set but file not found: ${ytdlpCookiesFile}`
      );
    }
  } else if (ytdlpCookiesFromBrowser) {
    out.push("--cookies-from-browser", ytdlpCookiesFromBrowser);
  }
  return out;
}

export class YtdlpError extends Error {
  constructor(message) {
    super(message);
    this.name = "YtdlpError";
  }
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new YtdlpError(stderr.slice(-4000) || "yt-dlp failed"));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function runYtdlpJson(args, timeoutMs = 600_000) {
  const { ytdlpPath } = getConfig();
  const fullArgs = [...ytdlpPrelude(), ...args];
  const out = await runProcess(ytdlpPath, fullArgs, { timeoutMs });
  const text = out.trim();
  if (!text) return {};
  return JSON.parse(text);
}

/** Best-effort playlist display name from yt-dlp `-J` (esp. `--flat-playlist`, where `title` may be stripped). */
function playlistTitleFromYtdlpJson(data) {
  if (!data || typeof data !== "object") return null;
  const trim = (s) => (typeof s === "string" && s.trim() ? s.trim() : null);
  let t = trim(data.title);
  if (t) return t;
  t = trim(data.playlist_title);
  if (t) return t;
  const nested = data.playlist;
  if (nested && typeof nested === "object") {
    t = trim(nested.title);
    if (t) return t;
  }
  for (const e of data.entries || []) {
    if (!e || typeof e !== "object") continue;
    t = trim(e.playlist_title);
    if (t) return t;
  }
  return null;
}

const flatPlaylistJsonArgs = [
  "-J",
  "--flat-playlist",
  "--no-warnings",
  "--no-download",
  "--no-clean-info",
];

/**
 * @returns {{ entries: { id: string, title: string }[], playlistTitle: string | null }}
 */
export async function flatPlaylistEntries(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const data = await runYtdlpJson([...flatPlaylistJsonArgs, url], 300_000);
  const playlistTitle = playlistTitleFromYtdlpJson(data);
  const entries = data.entries || [];
  const out = [];
  for (const e of entries) {
    if (!e) continue;
    let vid = e.id || e.url;
    if (!vid) continue;
    if (typeof vid === "string" && vid.includes("youtube.com")) {
      const u = new URL(vid);
      const v = u.searchParams.get("v");
      vid = v || vid;
    }
    const title = (e.title || "Unknown").trim();
    out.push({ id: String(vid), title });
  }
  return { entries: out, playlistTitle };
}

/** Lightweight title fetch (minimal entries) for right-after `POST /v1/playlists`. */
export async function fetchPlaylistTitleQuick(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const data = await runYtdlpJson(
    [...flatPlaylistJsonArgs, "--playlist-end", "1", url],
    120_000
  );
  return playlistTitleFromYtdlpJson(data);
}

export async function fetchVideoMetadata(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await runYtdlpJson(
    ["-J", "--no-download", "--no-warnings", "--skip-download", url],
    120_000
  );
  const thumbs = data.thumbnails || [];
  let thumb = data.thumbnail;
  if (!thumb && thumbs.length) thumb = thumbs[thumbs.length - 1]?.url;
  const dur = data.duration;
  return {
    title: (data.title || "Unknown").trim(),
    artist: data.uploader || data.channel || data.artist || null,
    album: data.album || null,
    duration: dur != null ? parseInt(String(dur), 10) : null,
    thumbnail: thumb || null,
  };
}

export async function downloadAudioMp3(videoId, mediaDir) {
  const { ytdlpPath } = getConfig();
  await fs.mkdir(mediaDir, { recursive: true });
  const final = path.join(mediaDir, `${videoId}.mp3`);
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outTemplate = path.join(mediaDir, `${videoId}.%(ext)s`);
  const args = [
    ...ytdlpPrelude(),
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--embed-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "-o",
    outTemplate,
    "--no-playlist",
    "--no-warnings",
    watchUrl,
  ];
  await runProcess(ytdlpPath, args, { cwd: mediaDir, timeoutMs: 1_800_000 });
  try {
    await fs.access(final);
    return final;
  } catch {
    const dir = await fs.readdir(mediaDir);
    const mp3s = dir.filter((f) => f.startsWith(videoId) && f.endsWith(".mp3"));
    if (!mp3s.length) throw new YtdlpError("mp3 not found after download");
    const best = path.join(mediaDir, mp3s[0]);
    if (best !== final) await fs.rename(best, final);
    return final;
  }
}
