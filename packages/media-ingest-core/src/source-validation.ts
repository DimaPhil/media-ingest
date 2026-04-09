export interface TelegramPostReference {
  chatRef: string;
  messageId: number;
}

function parseHttpUrl(uri: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Source URI must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Source URI must use http or https');
  }
  return parsed;
}

function isYoutubeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'youtu.be'
    || normalized === 'youtube.com'
    || normalized.endsWith('.youtube.com');
}

export function validateHttpSourceUri(uri: string): string {
  return parseHttpUrl(uri).toString();
}

export function validateYtDlpSourceUri(uri: string): string {
  return parseHttpUrl(uri).toString();
}

export function validateYoutubeSourceUri(uri: string): string {
  const parsed = parseHttpUrl(uri);
  if (!isYoutubeHostname(parsed.hostname)) {
    throw new Error('Unsupported YouTube URL');
  }

  if (parsed.hostname.toLowerCase() === 'youtu.be') {
    const videoId = parsed.pathname.split('/').filter(Boolean)[0];
    if (!videoId) {
      throw new Error('YouTube short links must include a video id');
    }
    if (parsed.searchParams.has('list')) {
      throw new Error('YouTube playlists are not supported in v1');
    }
    return parsed.toString();
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const isWatch = pathParts[0] === 'watch' || parsed.pathname === '/watch';
  const isShorts = pathParts[0] === 'shorts' && Boolean(pathParts[1]);
  const isLive = pathParts[0] === 'live' && Boolean(pathParts[1]);
  const isEmbed = pathParts[0] === 'embed' && Boolean(pathParts[1]);

  if (parsed.searchParams.has('list') || pathParts[0] === 'playlist') {
    throw new Error('YouTube playlists are not supported in v1');
  }

  if (isWatch && parsed.searchParams.get('v')) {
    return parsed.toString();
  }
  if (isShorts || isLive || isEmbed) {
    return parsed.toString();
  }

  throw new Error('Unsupported YouTube URL');
}

export function parseGoogleDriveFileId(uri: string): string {
  const parsed = parseHttpUrl(uri);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'drive.google.com' && hostname !== 'docs.google.com') {
    throw new Error('Unsupported Google Drive URL');
  }
  if (parsed.pathname.includes('/folders/')) {
    throw new Error('Google Drive folders are not supported in v1');
  }
  if (parsed.searchParams.has('id')) {
    const fileId = parsed.searchParams.get('id');
    if (fileId) {
      return fileId;
    }
  }
  const match = parsed.pathname.match(/\/d\/([^/]+)/);
  if (!match?.[1]) {
    throw new Error('Unsupported Google Drive URL');
  }
  return match[1];
}

export function validateGoogleDriveSourceUri(uri: string): string {
  parseGoogleDriveFileId(uri);
  return uri;
}

export function parseTelegramUri(uri: string): TelegramPostReference {
  const parsed = parseHttpUrl(uri);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 't.me' && hostname !== 'telegram.me') {
    throw new Error('Unsupported Telegram post URL');
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'c' && pathParts[1] && pathParts[2]) {
    const messageId = Number(pathParts[2]);
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new Error('Telegram message id must be a positive integer');
    }
    return {
      chatRef: `-100${pathParts[1]}`,
      messageId,
    };
  }

  if (pathParts[0] && pathParts[1]) {
    const messageId = Number(pathParts[1]);
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new Error('Telegram message id must be a positive integer');
    }
    return {
      chatRef: `@${pathParts[0]}`,
      messageId,
    };
  }

  throw new Error('Unsupported Telegram post URL');
}

export function validateTelegramSourceUri(uri: string): string {
  parseTelegramUri(uri);
  return uri;
}
