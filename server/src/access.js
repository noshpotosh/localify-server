export async function userCanAccessTrack(sql, userId, trackId) {
  const rows = await sql`
    SELECT pt.id
    FROM playlist_tracks pt
    INNER JOIN playlists p ON p.id = pt.playlist_id
    WHERE p.user_id = ${userId}
      AND p.enabled = true
      AND pt.track_id = ${trackId}
    LIMIT 1
  `;
  return rows.length > 0;
}
