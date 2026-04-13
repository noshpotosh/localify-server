function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getConfig() {
  return {
    databaseUrl: process.env.DATABASE_URL || "postgres://localify:localify@localhost:5432/localify",
    mediaDir: process.env.MEDIA_DIR || "/data/media",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8000",
    downloadSigningSecret:
      process.env.DOWNLOAD_SIGNING_SECRET || "change-me-in-production-use-long-random-secret",
    signedUrlTtlSeconds: intEnv("SIGNED_URL_TTL_SECONDS", 3600),
    maxConcurrentDownloads: intEnv("MAX_CONCURRENT_DOWNLOADS", 2),
    downloadJobMaxAttempts: intEnv("DOWNLOAD_JOB_MAX_ATTEMPTS", 5),
    defaultPollIntervalSeconds: intEnv("DEFAULT_POLL_INTERVAL_SECONDS", 3600),
    logLevel: process.env.LOG_LEVEL || "info",
    ytdlpPath: process.env.YTDLP_PATH || "yt-dlp",
    /** Netscape-format cookies.txt; see yt-dlp wiki “Exporting YouTube cookies”. */
    ytdlpCookiesFile: process.env.YTDLP_COOKIES_FILE || null,
    /** e.g. `chrome` — local dev only; not usable in typical Docker images. */
    ytdlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || null,
    ffmpegLocation: process.env.FFMPEG_LOCATION || null,
    port: intEnv("PORT", 8000),
    host: process.env.HOST || "0.0.0.0",
  };
}
