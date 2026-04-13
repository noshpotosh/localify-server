import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";

let cookiesMissingLogged = false;
let noCookiesHintLogged = false;
/** Path after materializing YTDLP_COOKIES_B64 (lazy). */
let materializedCookiesPath = null;
/** Skip re-validating same path + mtime. */
let cookiesValidatedKey = null;

/**
 * Netscape cookies must be UTF-8 for yt-dlp. Some exports are UTF-16 (Windows "Unicode") or UTF-16 + BOM.
 */
function normalizeCookieBytesToUtf8(buf) {
  if (!buf.length) return buf;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = new TextDecoder("utf-16le").decode(buf).replace(/^\ufeff/, "");
    return Buffer.from(text, "utf-8");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = new TextDecoder("utf-16be").decode(buf).replace(/^\ufeff/, "");
    return Buffer.from(text, "utf-8");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return buf;
  } catch {
    if (buf.length >= 2 && buf.length % 2 === 0) {
      const text = new TextDecoder("utf-16le", { fatal: false }).decode(buf).replace(/^\ufeff/, "");
      const head = text.slice(0, 512);
      if (/^[\s\r\n]*(# Netscape HTTP Cookie File|# HTTP Cookie File)/m.test(head)) {
        return Buffer.from(text, "utf-8");
      }
    }
    throw new Error(
      "Cookie bytes are not UTF-8 and do not look like UTF-16 Netscape cookies. " +
        "Save cookies.txt as UTF-8 (or UTF-16 with BOM), or use a Render Secret File with raw UTF-8 text."
    );
  }
}

/**
 * yt-dlp expects UTF-8 Netscape cookies.txt. Binary (e.g. Chrome SQLite "Cookies") causes
 * Python 'utf-8' codec can't decode byte… when Render mounts the wrong file type.
 */
function assertValidNetscapeCookiesFile(cookiePath) {
  const buf = readFileSync(cookiePath);
  if (!buf.length) {
    throw new Error(`Cookies file is empty: ${cookiePath}`);
  }
  if (buf.length >= 15 && buf.toString("ascii", 0, 15) === "SQLite format 3") {
    throw new Error(
      `Cookies file at ${cookiePath} is a Chrome SQLite database, not Netscape cookies.txt. ` +
        `Export a text cookies file per https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp`
    );
  }
  const maxScan = Math.min(buf.length, 2 * 1024 * 1024);
  const scan = buf.subarray(0, maxScan);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(scan);
  } catch {
    throw new Error(
      `Cookies file at ${cookiePath} is not valid UTF-8 (binary or wrong encoding). ` +
        `Re-export as UTF-8 plain text; do not upload Chrome's SQLite Cookies file or a .zip.`
    );
  }
  const preview = scan.toString("utf-8").replace(/^\ufeff/, "").slice(0, 1024);
  if (!/^[\s\r\n]*(# Netscape HTTP Cookie File|# HTTP Cookie File)/m.test(preview)) {
    throw new Error(
      `Cookies file at ${cookiePath} does not look like Netscape format (expected "# Netscape HTTP Cookie File" or "# HTTP Cookie File" near the top).`
    );
  }
}

function cookiesFileForYtdlp() {
  const { ytdlpCookiesFile, ytdlpCookiesB64 } = getConfig();
  let candidate = null;

  if (ytdlpCookiesFile) {
    if (existsSync(ytdlpCookiesFile)) {
      candidate = ytdlpCookiesFile;
    } else {
      if (!cookiesMissingLogged) {
        cookiesMissingLogged = true;
        console.warn(
          `[ytdlp] YTDLP_COOKIES_FILE is "${ytdlpCookiesFile}" but that path does not exist here. ` +
            `On Render, secret files are usually at /etc/secrets/<filename> (match the upload name exactly). ` +
            `While this var is set, YTDLP_COOKIES_B64 is ignored — remove or fix COOKIES_FILE, or unset COOKIES_FILE to use B64 only.`
        );
      }
      return null;
    }
  } else if (ytdlpCookiesB64) {
    try {
      if (!materializedCookiesPath) {
        materializedCookiesPath = path.join("/tmp", "localify-ytdlp-cookies.txt");
        const b64 = ytdlpCookiesB64.replace(/\s+/g, "");
        const raw = Buffer.from(b64, "base64");
        if (!raw.length) {
          throw new Error("YTDLP_COOKIES_B64 decoded to empty buffer (check the secret value)");
        }
        const utf8 = normalizeCookieBytesToUtf8(raw);
        writeFileSync(materializedCookiesPath, utf8, { mode: 0o600 });
      }
      candidate = materializedCookiesPath;
    } catch (e) {
      console.error("[ytdlp] YTDLP_COOKIES_B64 could not be decoded or written:", e.message);
      materializedCookiesPath = null;
      return null;
    }
  }

  if (!candidate) return null;

  const st = statSync(candidate);
  const key = `${candidate}\0${st.mtimeMs}`;
  if (cookiesValidatedKey !== key) {
    assertValidNetscapeCookiesFile(candidate);
    cookiesValidatedKey = key;
  }
  return candidate;
}

/** Global yt-dlp flags: ffmpeg path, then YouTube auth cookies if configured. */
function ytdlpPrelude() {
  const { ffmpegLocation, ytdlpCookiesFromBrowser } = getConfig();
  const out = [];
  if (ffmpegLocation) {
    out.push("--ffmpeg-location", ffmpegLocation);
  }
  const cookiePath = cookiesFileForYtdlp();
  if (cookiePath) {
    out.push("--cookies", cookiePath);
  } else if (ytdlpCookiesFromBrowser) {
    out.push("--cookies-from-browser", ytdlpCookiesFromBrowser);
  } else if (process.env.NODE_ENV === "production" && !noCookiesHintLogged) {
    noCookiesHintLogged = true;
    console.warn(
      "[ytdlp] No YouTube cookies configured (YTDLP_COOKIES_FILE, YTDLP_COOKIES_B64, or YTDLP_COOKIES_FROM_BROWSER). " +
        "Datacenter IPs often get “Sign in to confirm you’re not a bot”; export cookies per " +
        "https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
    );
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
