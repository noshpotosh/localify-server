import crypto from "node:crypto";
import { getConfig } from "./config.js";

function b64encode(buf) {
  return Buffer.from(buf).toString("base64url").replace(/=+$/, "");
}

function b64decode(s) {
  let pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return Buffer.from(s, "base64url");
}

export function signDownloadUrl(userId, trackId) {
  const { downloadSigningSecret, signedUrlTtlSeconds } = getConfig();
  const exp = Math.floor(Date.now() / 1000) + signedUrlTtlSeconds;
  const payload = JSON.stringify(
    { exp, t: trackId, u: String(userId) },
    ["exp", "t", "u"]
  );
  const body = b64encode(Buffer.from(payload, "utf8"));
  const sig = crypto
    .createHmac("sha256", downloadSigningSecret)
    .update(body, "ascii")
    .digest("hex");
  return `${body}.${sig}`;
}

export function verifyDownloadToken(token) {
  const { downloadSigningSecret } = getConfig();
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return null;
    const bodyB64 = token.slice(0, lastDot);
    const sigHex = token.slice(lastDot + 1);
    const expected = crypto
      .createHmac("sha256", downloadSigningSecret)
      .update(bodyB64, "ascii")
      .digest("hex");
    if (expected.length !== sigHex.length) return null;
    let expBuf;
    let sigBuf;
    try {
      expBuf = Buffer.from(expected, "hex");
      sigBuf = Buffer.from(sigHex, "hex");
    } catch {
      return null;
    }
    if (!crypto.timingSafeEqual(expBuf, sigBuf)) return null;
    const payload = JSON.parse(b64decode(bodyB64).toString("utf8"));
    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return { userId: String(payload.u), trackId: String(payload.t) };
  } catch {
    return null;
  }
}
