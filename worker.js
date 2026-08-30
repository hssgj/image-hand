const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_KEY = "google:default";

function callbackUrl(request) {
  return new URL("/oauth/callback", request.url).toString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function extractDriveFileId(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  // Direct file ID.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value) && !value.includes("/")) {
    return value;
  }

  try {
    const url = new URL(value);

    // /file/d/<ID>/...
    const fileMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return fileMatch[1];

    // ?id=<ID>
    const id = url.searchParams.get("id");
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;

    // /open?id=<ID>, /uc?id=<ID>, etc. are covered by the query-string case.
  } catch {
    return null;
  }

  return null;
}

async function exchangeCode(request, env, code) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(request),
      grant_type: "authorization_code",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, response, text };
  }

  return { ok: true, token: JSON.parse(text) };
}

async function refreshAccessToken(env, stored) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, text };
  }

  const token = JSON.parse(text);
  return {
    ok: true,
    access_token: token.access_token,
    expires_at: Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1000,
  };
}

async function getGoogleAccessToken(env) {
  if (!env.OAUTH_TOKENS) {
    return { ok: false, error: "OAUTH_TOKENS binding is not configured." };
  }

  const raw = await env.OAUTH_TOKENS.get(TOKEN_KEY);
  if (!raw) {
    return { ok: false, error: "Google authorization is not stored yet. Visit /oauth first." };
  }

  const stored = JSON.parse(raw);

  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at) {
    return { ok: true, access_token: stored.access_token };
  }

  if (!stored.refresh_token) {
    return { ok: false, error: "Stored Google credentials have no refresh token." };
  }

  const refreshed = await refreshAccessToken(env, stored);
  if (!refreshed.ok) {
    return { ok: false, error: "Google access-token refresh failed." };
  }

  const updated = {
    refresh_token: stored.refresh_token,
    access_token: refreshed.access_token,
    expires_at: refreshed.expires_at,
  };

  await env.OAUTH_TOKENS.put(TOKEN_KEY, JSON.stringify(updated));
  return { ok: true, access_token: refreshed.access_token };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/oauth") {
      if (!env.GOOGLE_CLIENT_ID) {
        return new Response("Missing GOOGLE_CLIENT_ID.", { status: 500 });
      }

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

      if (error) {
        return new Response(`Google OAuth error: ${error}`, { status: 400 });
      }

      if (!code) {
        return new Response("Missing Google authorization code.", { status: 400 });
      }

      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return new Response("OAuth configuration is incomplete.", { status: 500 });
      }

      if (!env.OAUTH_TOKENS) {
        return new Response(
          "OAuth works, but OAUTH_TOKENS storage is not configured yet.",
          { status: 500 },
        );
      }

      const exchanged = await exchangeCode(request, env, code);
      if (!exchanged.ok) {
        return new Response("Google token exchange failed.", { status: 502 });
      }

      const token = exchanged.token;
      if (!token.refresh_token) {
        return new Response(
          "Google authorization succeeded, but no refresh token was returned.",
          { status: 502 },
        );
      }

      const expiresIn = Number(token.expires_in || 3600);
      await env.OAUTH_TOKENS.put(
        TOKEN_KEY,
        JSON.stringify({
          refresh_token: token.refresh_token,
          access_token: token.access_token || null,
          expires_at: Date.now() + Math.max(0, expiresIn - 60) * 1000,
        }),
      );

      return json({
        ok: true,
        oauth: "google",
        token_exchange: "success",
        access_token_received: Boolean(token.access_token),
        refresh_token_received: true,
        stored: true,
        next_step: "Use /image?url=<Google Drive URL> to retrieve an image.",
      });
    }

    if (url.pathname === "/image") {
      const source = url.searchParams.get("url") || url.searchParams.get("id");
      const fileId = extractDriveFileId(source);

      if (!fileId) {
        return json({
          ok: false,
          error: "Provide a Google Drive file URL or file ID using ?url=... or ?id=...",
        }, 400);
      }

      const access = await getGoogleAccessToken(env);
      if (!access.ok) {
        return json({ ok: false, error: access.error }, 401);
      }

      const driveUrl = new URL(`${GOOGLE_DRIVE_API}/${encodeURIComponent(fileId)}`);
      driveUrl.searchParams.set("alt", "media");

      const imageResponse = await fetch(driveUrl, {
        headers: {
          Authorization: `Bearer ${access.access_token}`,
        },
      });

      if (!imageResponse.ok) {
        return json({
          ok: false,
          error: "Google Drive image retrieval failed.",
          status: imageResponse.status,
        }, imageResponse.status === 404 ? 404 : 502);
      }

      const headers = new Headers();
      const contentType = imageResponse.headers.get("Content-Type") || "application/octet-stream";
      headers.set("Content-Type", contentType);
      headers.set("Cache-Control", "private, max-age=60");

      return new Response(imageResponse.body, {
        status: 200,
        headers,
      });
    }

    return new Response(
      "Image Hand Worker online. Use /oauth to authorize Google, then /image?url=<Google Drive URL>.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
};
