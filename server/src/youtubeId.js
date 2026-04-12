/** Bare playlist IDs (PL…, OL…, UU…, etc.) are typically at least this long. */
const PLAYLIST_ID_RE = /^[a-zA-Z0-9_-]{10,}$/;

function isYoutubeHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
}

function playlistIdFromSearchParams(searchParams) {
  const raw = searchParams.get("list");
  if (!raw) return null;
  const id = raw.trim();
  return PLAYLIST_ID_RE.test(id) ? id : null;
}

/**
 * @returns {"video_only" | null}
 */
function detectVideoOnlyNoPlaylist(trimmed) {
  const candidates = [trimmed, `https://${trimmed}`];
  for (const probe of candidates) {
    let u;
    try {
      u = new URL(probe);
    } catch {
      continue;
    }
    if (!isYoutubeHost(u.hostname)) continue;
    if (playlistIdFromSearchParams(u.searchParams)) return null;
    const v = u.searchParams.get("v");
    const path = u.pathname.toLowerCase();
    if (v || path === "/watch" || path.startsWith("/watch/") || path.startsWith("/shorts/")) {
      return "video_only";
    }
    if (u.hostname === "youtu.be" && u.pathname.length > 1) {
      return "video_only";
    }
  }
  return null;
}

/**
 * Extract a YouTube playlist ID from a bare ID or a full YouTube URL.
 * Supports playlist URLs, watch URLs with `list=`, and youtu.be links with `?list=`.
 */
export function parsePlaylistId(urlOrId) {
  const s = urlOrId.trim();
  if (!s) {
    throw new Error("Could not parse a YouTube playlist ID from input");
  }
  if (PLAYLIST_ID_RE.test(s)) {
    return s;
  }

  const urlCandidates = /^https?:\/\//i.test(s) ? [s] : [`https://${s}`];
  for (const probe of urlCandidates) {
    let u;
    try {
      u = new URL(probe);
    } catch {
      continue;
    }
    if (!isYoutubeHost(u.hostname)) {
      continue;
    }
    const fromList = playlistIdFromSearchParams(u.searchParams);
    if (fromList) {
      return fromList;
    }
  }

  if (detectVideoOnlyNoPlaylist(s) === "video_only") {
    const err = new Error(
      "That link is a video, not a playlist. Use a playlist URL or ID, or a watch URL that includes list=…"
    );
    err.code = "VIDEO_ONLY";
    throw err;
  }

  throw new Error("Could not parse a YouTube playlist ID from input");
}
