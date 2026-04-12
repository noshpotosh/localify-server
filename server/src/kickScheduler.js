/**
 * One-off scheduler run for ops / debugging.
 * Uses the same env as the API (DATABASE_URL, MEDIA_DIR, YTDLP_*, etc.).
 *
 * Run where downloads should land (e.g. same machine or `render ssh` into the service),
 * not from a random laptop against production DB — files would write locally.
 *
 * Usage:
 *   node src/kickScheduler.js           # poll due playlists once, then drain download jobs
 *   node src/kickScheduler.js poll      # only runDuePolls()
 *   node src/kickScheduler.js download  # only processOneDownload() until idle (capped)
 *
 * Optional: KICK_DOWNLOAD_MAX=500 (default 200) max download job attempts per invocation.
 */
import { runDuePolls, processOneDownload } from "./pipeline.js";
import { closeDb } from "./db.js";

const mode = (process.argv[2] || "all").toLowerCase();

if (!["poll", "download", "all"].includes(mode)) {
  console.error(`Unknown mode "${process.argv[2]}". Use: poll | download | all`);
  process.exit(2);
}

async function drainDownloads() {
  const max = Math.max(1, parseInt(process.env.KICK_DOWNLOAD_MAX || "200", 10) || 200);
  let jobsAttempted = 0;
  for (let i = 0; i < max; i += 1) {
    const ran = await processOneDownload();
    if (!ran) break;
    jobsAttempted += 1;
  }
  return { jobsAttempted, capped: jobsAttempted >= max };
}

async function main() {
  try {
    if (mode === "poll" || mode === "all") {
      const pr = await runDuePolls();
      console.log(JSON.stringify({ phase: "poll", ...pr }));
    }

    if (mode === "download" || mode === "all") {
      const dr = await drainDownloads();
      console.log(JSON.stringify({ phase: "download", ...dr }));
    }
  } finally {
    await closeDb();
  }
}

await main();
