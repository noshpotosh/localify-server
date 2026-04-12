-- Localify API schema (matches prior Python/Alembic final state). Applied only on empty DB.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id VARCHAR(128) UNIQUE,
  email VARCHAR(320) UNIQUE,
  password_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  label VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_api_tokens_user_id ON api_tokens (user_id);

CREATE TABLE tracks (
  youtube_video_id VARCHAR(32) PRIMARY KEY,
  title VARCHAR(1024) NOT NULL DEFAULT '',
  artist VARCHAR(512),
  album VARCHAR(512),
  duration_seconds INT,
  thumbnail_url TEXT,
  metadata_fetched_at TIMESTAMPTZ
);

CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  youtube_playlist_id VARCHAR(64) NOT NULL,
  title VARCHAR(512),
  poll_interval_seconds INT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_polled_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT uq_user_playlist_yt UNIQUE (user_id, youtube_playlist_id)
);

CREATE INDEX ix_playlists_user_id ON playlists (user_id);
CREATE INDEX ix_playlists_youtube_playlist_id ON playlists (youtube_playlist_id);

CREATE TABLE playlist_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  track_id VARCHAR(32) NOT NULL REFERENCES tracks (youtube_video_id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_playlist_track UNIQUE (playlist_id, track_id)
);

CREATE INDEX ix_playlist_tracks_playlist_id ON playlist_tracks (playlist_id);

CREATE TABLE media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id VARCHAR(32) NOT NULL UNIQUE REFERENCES tracks (youtube_video_id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  format VARCHAR(16) NOT NULL DEFAULT 'mp3',
  byte_size BIGINT,
  ready_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE TABLE download_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id VARCHAR(32) NOT NULL UNIQUE REFERENCES tracks (youtube_video_id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
