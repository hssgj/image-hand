/**
 * Provider-native URL resolution playground.
 *
 * This module deliberately does NOT download or archive images.
 * It answers only: "Can we derive a media URL from this user-facing URL?"
 */

export function extractGoogleDriveFileId(input) {
  try {
    const url = new URL(input);

    // /file/d/<id>/view
    const pathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (pathMatch) return pathMatch[1];

    // ?id=<id> or common Drive query forms
    const id = url.searchParams.get("id");
    if (id) return id;

    return null;
  } catch {
    return null;
  }
}

export function googleDriveViewUrl(fileId) {
  return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
}

export function googleDriveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

export function resolveProviderUrl(input) {
  const driveId = extractGoogleDriveFileId(input);

  if (driveId) {
    return {
      provider: "google-drive",
      fileId: driveId,
      candidates: [
        googleDriveViewUrl(driveId),
        googleDriveDownloadUrl(driveId)
      ]
    };
  }

  return {
    provider: "unknown",
    fileId: null,
    candidates: [input]
  };
}
