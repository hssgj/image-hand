# Image Hand — Resolution Thesis

## Goal

Turn a user-facing image/share URL into a URL that serves the actual image representation, while keeping storage optional and avoiding permanent image archiving.

The project has two separate problems:

1. **Resolution:** share/view URL → actual image delivery URL / image bytes.
2. **Perception handoff:** actual image delivery → a representation that ChatGPT's available visual pathway can genuinely inspect.

These must be tested independently before being merged.

## Thesis A — Provider-native direct URL

For providers that expose a stable direct-media URL, resolve the share URL to that URL without copying the image.

Google Drive is the first target. A Drive share URL contains a file ID. A known media URL pattern can expose the file as an image when the file is publicly accessible.

Pros:
- zero storage;
- extremely simple;
- fast;
- closest to ImageUpload-style `direct_url` behavior.

Risks:
- provider URL formats can change;
- public sharing may be required;
- redirects/content-disposition/CORS can differ;
- a browser being able to display an image does not prove the ChatGPT web pathway can visually ingest it.

## Thesis B — Provider API resolver

Use the provider's official API to resolve a file ID and retrieve the media representation.

For Google Drive, the Drive API can retrieve file metadata and media. The resolver can validate MIME type and then expose or stream the bytes.

Pros:
- official API contract;
- better MIME/type validation;
- can support private Drive files if authentication is implemented;
- extensible to other providers.

Risks:
- OAuth/API credentials;
- cannot safely put secrets in a public GitHub Pages app;
- requires a backend or serverless component for private access.

## Thesis C — Stateless image proxy

Use a small backend/edge function as the universal boundary:

`share URL → resolver → fetch image → return image/* response`

The proxy can normalize provider quirks and expose one stable Image Hand endpoint.

Pros:
- one interface for many providers;
- can normalize headers and content type;
- can handle redirects and provider-specific URL formats;
- no permanent storage required;
- closest to a universal Image Hand.

Risks:
- now there is a server/runtime;
- bandwidth and abuse controls matter;
- private-source authentication needs careful design;
- the proxy solving image delivery still does not automatically solve ChatGPT visual ingestion.

## Likely architecture

The long-term candidate is a hybrid:

`provider detector → provider-native resolution when safe → proxy fallback when necessary → direct image endpoint → perception handoff test`

This keeps the common case cheap and stateless while leaving room for providers whose direct URLs are unreliable.

## Critical experiment

Do not assume that a successful HTTP image response means ChatGPT can see the image.

The acceptance tests are therefore:

### Resolution acceptance

Given the supplied Google Drive URL:

`https://drive.google.com/file/d/1IBUnff0WeujlffQolv7PshQ7giY5wYUU/view?usp=drivesdk`

extract file ID:

`1IBUnff0WeujlffQolv7PshQ7giY5wYUU`

and obtain a response whose media type is actually `image/*` and whose body is the image bytes.

### Perception acceptance

Given the resulting image endpoint, determine whether the available ChatGPT pathway can actually inspect the visual content and answer a visual question about it. Metadata, dimensions, MIME type, or HTML presence do not count as success.

Only after both acceptance tests pass should the two layers be merged into the everyday Image Hand workflow.
