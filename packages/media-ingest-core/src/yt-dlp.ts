import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { AppConfig } from './config';

const YT_DLP_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

interface YtDlpRunResult {
  stdout: string;
  stderr: string;
}

interface YtDlpResolvePayload {
  webpage_url?: string;
  title?: string;
  _filename?: string;
  entries?: unknown;
}

export interface YtDlpResolvedMedia {
  canonicalUri: string;
  displayName: string;
  fileName: string;
  metadata: Record<string, unknown>;
}

type SpawnFactory = (
  file: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}

function fileNameExtension(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(index) : fallback;
}

function extractLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export class YtDlpExecutionError extends Error {
  public constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'YtDlpExecutionError';
  }
}

export class YtDlpClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly spawnFactory: SpawnFactory = spawn,
  ) {}

  private cookiesArgs(): string[] {
    if (this.config.storage.ytDlpCookiesFromBrowser) {
      return ['--cookies-from-browser', this.config.storage.ytDlpCookiesFromBrowser];
    }
    return this.config.storage.ytDlpCookiesPath
      ? ['--cookies', this.config.storage.ytDlpCookiesPath]
      : [];
  }

  private runtimeArgs(): string[] {
    return ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];
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

  private async runOnce(args: string[]): Promise<YtDlpRunResult> {
    const child = this.spawnFactory(this.config.sources.ytDlp.binaryPath, args);
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > YT_DLP_OUTPUT_LIMIT_BYTES) {
        outputLimitExceeded = true;
        child.kill('SIGTERM');
        return;
      }
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= YT_DLP_OUTPUT_LIMIT_BYTES) {
        stderr += chunk;
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (outputLimitExceeded) {
          reject(new YtDlpExecutionError('yt-dlp output exceeded the configured limit', stdout, stderr));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new YtDlpExecutionError(
            `yt-dlp exited with code ${code ?? 'unknown'}`,
            stdout,
            stderr,
          ),
        );
      });
    });

    return { stdout, stderr };
  }

  private async run(args: string[]): Promise<YtDlpRunResult> {
    const baseArgs = [...this.runtimeArgs(), ...args];
    const cookieArgs = this.cookiesArgs();
    try {
      return await this.runOnce([...baseArgs, ...cookieArgs]);
    } catch (error) {
      if (
        cookieArgs.length > 0
        && this.hasCookieConfiguration()
        && (this.isCookieLookupFailure(error) || this.isCookieChallengeFailure(error))
      ) {
        return this.runOnce(baseArgs);
      }
      throw error;
    }
  }

  public async resolve(sourceUri: string): Promise<YtDlpResolvedMedia> {
    const { stdout } = await this.run([
      '--dump-single-json',
      '--no-playlist',
      sourceUri,
    ]);
    const parsed = JSON.parse(stdout) as YtDlpResolvePayload;
    if (!isRecord(parsed)) {
      throw new Error('yt-dlp returned an unexpected metadata payload');
    }
    if (parsed.entries) {
      throw new Error('Playlists are not supported in v1');
    }

    const title = String(parsed.title ?? sourceUri);
    const fileNameHint = typeof parsed._filename === 'string' ? parsed._filename : undefined;
    return {
      canonicalUri: String(parsed.webpage_url ?? sourceUri),
      displayName: title,
      fileName: safeFileName(title) + fileNameExtension(fileNameHint, '.mp4'),
      metadata: parsed,
    };
  }

  public async download(
    sourceUri: string,
    destinationTemplate: string,
    operationKind: 'transcription' | 'understanding',
  ): Promise<string> {
    const format = operationKind === 'transcription'
      ? 'bestaudio/best'
      : 'bestvideo*+bestaudio/best';
    const { stdout } = await this.run([
      '--no-playlist',
      '--format',
      format,
      '--output',
      destinationTemplate,
      '--print',
      'after_move:filepath',
      sourceUri,
    ]);
    const lastLine = extractLines(stdout).at(-1);
    if (!lastLine) {
      throw new Error('yt-dlp completed without reporting the downloaded file path');
    }
    return lastLine;
  }
}
