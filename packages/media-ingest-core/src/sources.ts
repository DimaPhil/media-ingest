import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import { google } from 'googleapis';

import type { AppConfig } from './config';
import type { MediaSourceInput } from './contracts';
import { parseGoogleDriveFileId, parseTelegramUri } from './source-validation';

const execFile = promisify(execFileCb);

export interface ResolvedSource {
  kind: MediaSourceInput['kind'];
  canonicalUri: string;
  displayName: string;
  fileName: string;
  mimeType?: string;
  metadata: Record<string, unknown>;
}

export interface MaterializedSource {
  localPath: string;
  fileName: string;
  mimeType?: string;
}

export interface SourceResolver {
  supports(source: MediaSourceInput): boolean;
  resolve(source: MediaSourceInput): Promise<ResolvedSource>;
  materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource>;
}

async function downloadToFile(
  response: Response,
  destinationPath: string,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Response body is empty');
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReadableNodeStream(value: unknown): value is NodeJS.ReadableStream {
  return value !== null
    && typeof value === 'object'
    && 'pipe' in value
    && typeof value.pipe === 'function';
}

function requireSingleMedia(items: Array<{ media_id: string; file_name?: string; mime_type?: string }>): {
  mediaId: string;
  fileName: string;
  mimeType?: string;
} {
  if (items.length === 0) {
    throw new Error('No media found for the specified Telegram post');
  }
  if (items.length > 1) {
    throw new Error('Telegram post contains multiple media items; explicit selectors are not supported yet');
  }
  const item = items[0];
  if (!item) {
    throw new Error('Telegram post contains no accessible media');
  }
  return {
    mediaId: item.media_id,
    fileName: item.file_name ?? `telegram-${item.media_id}`,
    mimeType: item.mime_type,
  };
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}

class LocalFileSourceResolver implements SourceResolver {
  public supports(source: MediaSourceInput): boolean {
    return source.kind === 'local_file';
  }

  public async resolve(source: MediaSourceInput): Promise<ResolvedSource> {
    await access(source.uri);
    return {
      kind: source.kind,
      canonicalUri: source.uri,
      displayName: basename(source.uri),
      fileName: basename(source.uri),
      metadata: {},
    };
  }

  public async materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    _operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource> {
    const targetPath = join(destinationDirectory, safeFileName(source.fileName));
    await mkdir(destinationDirectory, { recursive: true });
    await copyFile(source.canonicalUri, targetPath);
    return {
      localPath: targetPath,
      fileName: source.fileName,
      mimeType: source.mimeType,
    };
  }
}

class HttpSourceResolver implements SourceResolver {
  public constructor(private readonly config: AppConfig) {}

  public supports(source: MediaSourceInput): boolean {
    return source.kind === 'http';
  }

  public async resolve(source: MediaSourceInput): Promise<ResolvedSource> {
    const head = await fetch(source.uri, {
      method: 'HEAD',
      signal: AbortSignal.timeout(this.config.sources.http.timeoutMs),
    });
    if (!head.ok) {
      throw new Error(`Could not inspect remote media: ${head.status}`);
    }
    const parsed = new URL(source.uri);
    return {
      kind: source.kind,
      canonicalUri: parsed.toString(),
      displayName: basename(parsed.pathname) || parsed.hostname,
      fileName: basename(parsed.pathname) || 'remote-media',
      mimeType: head.headers.get('content-type') ?? undefined,
      metadata: {
        contentLength: head.headers.get('content-length'),
      },
    };
  }

  public async materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    _operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource> {
    await mkdir(destinationDirectory, { recursive: true });
    const targetPath = join(destinationDirectory, safeFileName(source.fileName));
    const response = await fetch(source.canonicalUri, {
      signal: AbortSignal.timeout(this.config.sources.http.timeoutMs),
    });
    await downloadToFile(response, targetPath);
    return {
      localPath: targetPath,
      fileName: source.fileName,
      mimeType: source.mimeType,
    };
  }
}

class YtDlpSourceResolver implements SourceResolver {
  public constructor(private readonly config: AppConfig) {}

  public supports(source: MediaSourceInput): boolean {
    return source.kind === 'youtube' || source.kind === 'yt_dlp';
  }

  private cookiesArgs(): string[] {
    if (this.config.storage.ytDlpCookiesFromBrowser) {
      return ['--cookies-from-browser', this.config.storage.ytDlpCookiesFromBrowser];
    }
    return this.config.storage.ytDlpCookiesPath
      ? ['--cookies', this.config.storage.ytDlpCookiesPath]
      : [];
  }

  private runtimeArgs(): string[] {
    return ['--js-runtimes', 'node'];
  }

  private hasCookieConfiguration(): boolean {
    return Boolean(
      this.config.storage.ytDlpCookiesFromBrowser || this.config.storage.ytDlpCookiesPath,
    );
  }

  private isCookieLookupFailure(error: unknown): boolean {
    const details = isRecord(error) ? error : undefined;
    const text = `${details?.message ?? ''}\n${details?.stderr ?? ''}`;
    return /could not find .*cookies database/i.test(text)
      || (/FileNotFoundError/i.test(text) && /cookies/i.test(text))
      || (/cookie file/i.test(text) && /does not exist/i.test(text));
  }

  private isCookieChallengeFailure(error: unknown): boolean {
    const details = isRecord(error) ? error : undefined;
    const text = `${details?.message ?? ''}\n${details?.stderr ?? ''}`;
    return /n challenge solving failed/i.test(text)
      || /signature solving failed/i.test(text)
      || /only images are available for download/i.test(text)
      || /requested format is not available/i.test(text)
      || /no supported javascript runtime could be found/i.test(text);
  }

  private async execYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const baseArgs = [...this.runtimeArgs(), ...args];
    const cookieArgs = this.cookiesArgs();
    try {
      return await execFile(this.config.sources.ytDlp.binaryPath, [...baseArgs, ...cookieArgs]);
    } catch (error) {
      if (
        cookieArgs.length > 0
        && this.hasCookieConfiguration()
        && (this.isCookieLookupFailure(error) || this.isCookieChallengeFailure(error))
      ) {
        return execFile(this.config.sources.ytDlp.binaryPath, baseArgs);
      }
      throw error;
    }
  }

  public async resolve(source: MediaSourceInput): Promise<ResolvedSource> {
    const { stdout } = await this.execYtDlp([
      '--dump-single-json',
      '--no-playlist',
      source.uri,
    ]);
    const parsed = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error('yt-dlp returned an unexpected metadata payload');
    }
    const metadata = parsed;
    if (metadata.entries) {
      throw new Error('Playlists are not supported in v1');
    }
    return {
      kind: source.kind,
      canonicalUri: String(metadata.webpage_url ?? source.uri),
      displayName: String(metadata.title ?? source.uri),
      fileName: safeFileName(String(metadata.title ?? 'media')) + extname(String(metadata._filename ?? '.mp4')),
      metadata,
    };
  }

  public async materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource> {
    await mkdir(destinationDirectory, { recursive: true });
    const template = join(destinationDirectory, '%(title)s.%(ext)s');
    const format = operationKind === 'transcription' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best';
    await this.execYtDlp([
      '--no-playlist',
      '--format',
      format,
      '--output',
      template,
      source.canonicalUri,
    ]);
    const files = await execFile('bash', ['-lc', `ls -1 ${JSON.stringify(destinationDirectory)} | head -n 1`]);
    const fileName = files.stdout.trim();
    if (!fileName) {
      throw new Error('yt-dlp completed without creating a file');
    }
    return {
      localPath: join(destinationDirectory, fileName),
      fileName,
    };
  }
}

class GoogleDriveSourceResolver implements SourceResolver {
  public constructor(private readonly config: AppConfig) {}

  public supports(source: MediaSourceInput): boolean {
    return source.kind === 'google_drive';
  }

  private driveClient() {
    const credentials = this.config.providers.googleCloud.serviceAccountJson
      ? JSON.parse(this.config.providers.googleCloud.serviceAccountJson)
      : undefined;
    const auth = new google.auth.GoogleAuth({
      ...(credentials ? { credentials } : {}),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      ...(this.config.providers.googleCloud.projectId
        ? { projectId: this.config.providers.googleCloud.projectId }
        : {}),
    });
    return google.drive({ version: 'v3', auth });
  }

  public async resolve(source: MediaSourceInput): Promise<ResolvedSource> {
    const fileId = parseGoogleDriveFileId(source.uri);
    const drive = this.driveClient();
    const response = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      supportsAllDrives: true,
    });
    if (!response.data.id || !response.data.name) {
      throw new Error('Drive file metadata could not be loaded');
    }
    return {
      kind: source.kind,
      canonicalUri: `google-drive://${response.data.id}`,
      displayName: response.data.name,
      fileName: response.data.name,
      mimeType: response.data.mimeType ?? undefined,
      metadata: {
        fileId: response.data.id,
        size: response.data.size,
      },
    };
  }

  public async materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    _operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource> {
    await mkdir(destinationDirectory, { recursive: true });
    const fileId = String(source.metadata.fileId);
    const drive = this.driveClient();
    const response = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      {
        responseType: 'stream',
      },
    );
    const targetPath = join(destinationDirectory, safeFileName(source.fileName));
    if (!isReadableNodeStream(response.data)) {
      throw new Error('Drive download did not return a readable stream');
    }
    await pipeline(response.data, createWriteStream(targetPath));
    return {
      localPath: targetPath,
      fileName: source.fileName,
      mimeType: source.mimeType,
    };
  }
}

class TelegramSourceResolver implements SourceResolver {
  public constructor(private readonly config: AppConfig) {}

  public supports(source: MediaSourceInput): boolean {
    return source.kind === 'telegram';
  }

  private headers(): Record<string, string> {
    if (!this.config.sources.telegram.bearerToken) {
      return {};
    }
    return {
      Authorization: `Bearer ${this.config.sources.telegram.bearerToken}`,
    };
  }

  public async resolve(source: MediaSourceInput): Promise<ResolvedSource> {
    const parsed = parseTelegramUri(source.uri);
    const resolveResponse = await fetch(
      `${this.config.sources.telegram.baseUrl}/resolve?value=${encodeURIComponent(parsed.chatRef)}`,
      {
        headers: this.headers(),
      },
    );
    if (!resolveResponse.ok) {
      throw new Error(`Telegram resolve failed with status ${resolveResponse.status}`);
    }
    const resolvePayload = (await resolveResponse.json()) as {
      data?: {
        peer?: {
          id?: string;
          display_name?: string;
        };
      };
    };
    const chatId = resolvePayload.data?.peer?.id;
    if (!chatId) {
      throw new Error('Telegram chat could not be resolved');
    }
    const mediaResponse = await fetch(
      `${this.config.sources.telegram.baseUrl}/chats/${encodeURIComponent(chatId)}/messages/${parsed.messageId}/media`,
      {
        headers: this.headers(),
      },
    );
    if (!mediaResponse.ok) {
      throw new Error(`Telegram media manifest failed with status ${mediaResponse.status}`);
    }
    const mediaPayload = (await mediaResponse.json()) as {
      data?: Array<{ media_id: string; file_name?: string; mime_type?: string }>;
    };
    const media = requireSingleMedia(mediaPayload.data ?? []);
    return {
      kind: source.kind,
      canonicalUri: `telegram://${chatId}/${parsed.messageId}/${media.mediaId}`,
      displayName: resolvePayload.data?.peer?.display_name ?? source.uri,
      fileName: media.fileName,
      mimeType: media.mimeType,
      metadata: {
        chatId,
        messageId: parsed.messageId,
        mediaId: media.mediaId,
      },
    };
  }

  public async materialize(
    source: ResolvedSource,
    destinationDirectory: string,
    _operationKind: 'transcription' | 'understanding',
  ): Promise<MaterializedSource> {
    await mkdir(destinationDirectory, { recursive: true });
    const targetPath = join(destinationDirectory, safeFileName(source.fileName));
    const response = await fetch(
      `${this.config.sources.telegram.baseUrl}/chats/${encodeURIComponent(String(source.metadata.chatId))}/messages/${String(source.metadata.messageId)}/media/${String(source.metadata.mediaId)}`,
      {
        headers: this.headers(),
      },
    );
    await downloadToFile(response, targetPath);
    return {
      localPath: targetPath,
      fileName: source.fileName,
      mimeType: source.mimeType,
    };
  }
}

export class SourceRegistry {
  private readonly resolvers: SourceResolver[];

  public constructor(private readonly config: AppConfig) {
    this.resolvers = [
      new LocalFileSourceResolver(),
      new HttpSourceResolver(config),
      new YtDlpSourceResolver(config),
      new GoogleDriveSourceResolver(config),
      new TelegramSourceResolver(config),
    ];
  }

  public resolverFor(source: MediaSourceInput): SourceResolver {
    const resolver = this.resolvers.find((candidate) => candidate.supports(source));
    if (!resolver) {
      throw new Error(`Unsupported source kind: ${source.kind}`);
    }
    if (
      (source.kind === 'google_drive' && !this.config.sources.googleDrive.enabled) ||
      (source.kind === 'telegram' && !this.config.sources.telegram.enabled) ||
      ((source.kind === 'youtube' || source.kind === 'yt_dlp') && !this.config.sources.ytDlp.enabled) ||
      (source.kind === 'http' && !this.config.sources.http.enabled)
    ) {
      throw new Error(`Source kind is disabled: ${source.kind}`);
    }
    return resolver;
  }
}
