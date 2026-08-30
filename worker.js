const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_KEY = "google:default";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function callbackUrl(request) { return new URL("/oauth/callback", request.url).toString(); }
function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }

function extractDriveFileId(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value) && !value.includes("/")) return value;
  try {
    const u = new URL(value);
    const m = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    const id = u.searchParams.get("id");
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;
  } catch {}
  return null;
}

async function exchangeCode(request, env, code) {
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(request), grant_type: "authorization_code" }) });
  const text = await response.text();
  if (!response.ok) return { ok: false };
  return { ok: true, token: JSON.parse(text) };
}

async function refreshAccessToken(env, stored) {
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: stored.refresh_token, grant_type: "refresh_token" }) });
  const text = await response.text();
  if (!response.ok) return { ok: false };
  const token = JSON.parse(text);
  return { ok: true, access_token: token.access_token, expires_at: Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000 };
}

async function getGoogleAccessToken(env) {
  if (!env.OAUTH_TOKENS) return { ok: false, error: "OAUTH_TOKENS binding is not configured." };
  const raw = await env.OAUTH_TOKENS.get(TOKEN_KEY);
  if (!raw) return { ok: false, error: "Google authorization is not stored yet. Visit /oauth first." };
  const stored = JSON.parse(raw);
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at) return { ok: true, access_token: stored.access_token };
  if (!stored.refresh_token) return { ok: false, error: "Stored Google credentials have no refresh token." };
  const refreshed = await refreshAccessToken(env, stored);
  if (!refreshed.ok) return { ok: false, error: "Google access-token refresh failed." };
  await env.OAUTH_TOKENS.put(TOKEN_KEY, JSON.stringify({ refresh_token: stored.refresh_token, access_token: refreshed.access_token, expires_at: refreshed.expires_at }));
  return { ok: true, access_token: refreshed.access_token };
}

function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) return "image/avif";
  return null;
}

async function serveDriveImage(request, env, fileId) {
  const access = await getGoogleAccessToken(env);
  if (!access.ok) return json({ ok: false, error: access.error }, 401);

  const driveUrl = new URL(`${GOOGLE_DRIVE_API}/${encodeURIComponent(fileId)}`);
  driveUrl.searchParams.set("alt", "media");
  driveUrl.searchParams.set("supportsAllDrives", "true");
  const imageResponse = await fetch(driveUrl, { headers: { Authorization: `Bearer ${access.access_token}` } });

  if (!imageResponse.ok) {
    const googleError = await imageResponse.text();
    return json({ ok: false, stage: "drive_media", status: imageResponse.status, google_error: googleError }, imageResponse.status === 404 ? 404 : 502);
  }

  const declaredType = imageResponse.headers.get("Content-Type") || "";
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ ok: false, error: "Image exceeds 25 MB delivery limit." }, 413);
  const detectedType = sniffImageType(bytes);
  const contentType = detectedType || (declaredType.startsWith("image/") ? declaredType : "application/octet-stream");

  if (!contentType.startsWith("image/")) return json({ ok: false, error: "Drive file is not a recognized image.", content_type: declaredType }, 415);

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("CDN-Cache-Control", "public, max-age=86400");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", `"${fileId}-${bytes.byteLength}"`);

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}

function visionProxyUrl(request, fileId) {
  const direct = new URL(`/i/${encodeURIComponent(fileId)}.jpg`, request.url).toString();
  return `https://wsrv.nl/?url=${encodeURIComponent(direct)}&output=jpg&maxage=1d`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/oauth") {
      if (!env.GOOGLE_CLIENT_ID) return new Response("Missing GOOGLE_CLIENT_ID.", { status: 500 });
      const auth = new URL(GOOGLE_AUTH_URL);
      auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      auth.searchParams.set("redirect_uri", callbackUrl(request));
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", SCOPES);
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      return Response.redirect(auth.toString(), 302);
    }

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) return new Response(`Google OAuth error: ${error}`, { status: 400 });
      if (!code) return new Response("Missing Google authorization code.", { status: 400 });
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return new Response("OAuth configuration is incomplete.", { status: 500 });
      if (!env.OAUTH_TOKENS) return new Response("OAuth works, but OAUTH_TOKENS storage is not configured yet.", { status: 500 });
      const exchanged = await exchangeCode(request, env, code);
      if (!exchanged.ok) return new Response("Google token exchange failed.", { status: 502 });
      const token = exchanged.token;
      if (!token.refresh_token) return new Response("Google authorization succeeded, but no refresh token was returned.", { status: 502 });
      const expiresIn = Number(token.expires_in || 3600);
      await env.OAUTH_TOKENS.put(TOKEN_KEY, JSON.stringify({ refresh_token: token.refresh_token, access_token: token.access_token || null, expires_at: Date.now() + Math.max(0, expiresIn - 60) * 1000 }));
      return json({ ok: true, oauth: "google", token_exchange: "success", stored: true });
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const visionMatch = url.pathname.match(/^\/vision\/([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9]+)?$/);
    if (visionMatch) return Response.redirect(visionProxyUrl(request, visionMatch[1]), 302);

    const cleanMatch = url.pathname.match(/^\/i\/([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9]+)?$/);
    if (cleanMatch) return serveDriveImage(request, env, cleanMatch[1]);

    if (url.pathname === "/image") {
      const source = url.searchParams.get("url") || url.searchParams.get("id");
      const fileId = extractDriveFileId(source);
      if (!fileId) return json({ ok: false, error: "Provide a Google Drive file URL or file ID using ?url=... or ?id=..." }, 400);
      return serveDriveImage(request, env, fileId);
    }

    return new Response("Image Hand Worker online. Use /oauth, /image?url=<Google Drive URL>, /i/<fileId>.jpg, or /vision/<fileId>.jpg.");
  },
};