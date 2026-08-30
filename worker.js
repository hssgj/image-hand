const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

function callbackUrl(request) {
  return new URL("/oauth/callback", request.url).toString();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/oauth") {
      if (!env.GOOGLE_CLIENT_ID) {
        return new Response("Missing GOOGLE_CLIENT_ID secret/variable.", { status: 500 });
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

      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
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

      const tokenText = await tokenResponse.text();

      if (!tokenResponse.ok) {
        return new Response(`Google token exchange failed: ${tokenText}`, { status: 502 });
      }

      const token = JSON.parse(tokenText);
      const hasRefreshToken = Boolean(token.refresh_token);
      const hasAccessToken = Boolean(token.access_token);

      return new Response(
        JSON.stringify({
          ok: true,
          oauth: "google",
          token_exchange: "success",
          access_token_received: hasAccessToken,
          refresh_token_received: hasRefreshToken,
          next_step: "Store the refresh token securely, then implement Drive image retrieval.",
        }, null, 2),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Image Hand Worker online. Use /oauth to begin Google authorization.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
