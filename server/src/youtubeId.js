const YOUTUBE_PLAYLIST_URL_RE =
  /(?:youtube\.com\/(?:playlist\?|.*[&?]list=)|youtu\.be\/.*\?list=)([a-zA-Z0-9_-]+)/i;
const PLAYLIST_ID_ONLY_RE = /^[a-zA-Z0-9_-]{10,}$/;

export function parsePlaylistId(urlOrId) {
  const s = urlOrId.trim();
  const m = YOUTUBE_PLAYLIST_URL_RE.exec(s);
  if (m) return m[1];
  if (PLAYLIST_ID_ONLY_RE.test(s)) return s;
  throw new Error("Could not parse a YouTube playlist ID from input");
}
