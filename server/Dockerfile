FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir "yt-dlp[default]>=2026.3.0" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY sql ./sql
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
# Prefer Node for YouTube n-challenge solving (image already has node); avoids “only storyboards” / format-not-available when EJS runs but no JS runtime works.
ENV YTDLP_JS_RUNTIMES=node

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
