import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config';
import { YtDlpClient } from '../src/yt-dlp';

function createConfig(): AppConfig {
  return {
    app: {
      env: 'test',
      host: '127.0.0.1',
      port: 4000,
      pollAfterMs: 10,
    },
    features: {
      cacheEnabled: true,
    },
    concurrency: {
      operations: 2,
      sourceResolvers: 2,
      ffmpegJobs: 2,
      providerRequests: 4,
      chunkTasksPerOperation: 2,
    },
    storage: {
      workingDirectory: '/tmp',
      completedRetentionHours: 24,
      failedRetentionHours: 4,
      cleanupCron: '0 * * * *',
      ytDlpCookiesFromBrowser: 'firefox:test-profile',
      ytDlpCookiesPath: '',
    },
    database: {
      url: 'postgres://unused',
    },
    providers: {
      openai: {
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-transcribe',
        diarizeModel: 'gpt-4o-transcribe',
        translationModel: 'gpt-4.1-mini',
      },
      gemini: {
        enabled: true,
        apiKey: '',
        geminiTranscriptionModel: 'gemini-2.5-flash',
        geminiUnderstandingModel: 'gemini-2.5-pro',
      },
      googleCloud: {
        enabled: true,
        projectId: '',
        location: 'global',
        speechRecognizer: 'projects/_/locations/global/recognizers/_',
        serviceAccountJson: '',
      },
    },
    sources: {
      googleDrive: { enabled: true },
      telegram: { enabled: true, baseUrl: 'http://localhost:4040', bearerToken: '' },
      ytDlp: { enabled: true, binaryPath: 'yt-dlp' },
      http: { enabled: true, timeoutMs: 1000 },
    },
  };
}

function createSpawnFactory(
  scenarios: Array<{ code: number; stdout?: string; stderr?: string }>,
  calls: Array<{ file: string; args: string[] }>,
) {
  return (file: string, args: string[]) => {
    const scenario = scenarios.shift();
    if (!scenario) {
      throw new Error('Unexpected yt-dlp spawn');
    }
    calls.push({ file, args });

    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 1));
      return true;
    };

    queueMicrotask(() => {
      if (scenario.stdout) {
        child.stdout.write(scenario.stdout);
      }
      child.stdout.end();
      if (scenario.stderr) {
        child.stderr.write(scenario.stderr);
      }
      child.stderr.end();
      child.emit('close', scenario.code);
    });

    return child as never;
  };
}

describe('YtDlpClient', () => {
  it('rejects playlist metadata payloads', async () => {
    const client = new YtDlpClient(
      createConfig(),
      createSpawnFactory(
        [
          {
            code: 0,
            stdout: JSON.stringify({
              title: 'Playlist',
              entries: [{}],
            }),
          },
        ],
        [],
      ),
    );

    await expect(client.resolve('https://www.youtube.com/watch?v=abc')).rejects.toThrow(
      'Playlists are not supported in v1',
    );
  });

  it('resolves metadata with runtime and cookie arguments', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = new YtDlpClient(
      createConfig(),
      createSpawnFactory(
        [
          {
            code: 0,
            stdout: JSON.stringify({
              title: 'Example Video',
              webpage_url: 'https://www.youtube.com/watch?v=abc',
              _filename: 'Example Video.webm',
            }),
          },
        ],
        calls,
      ),
    );

    const result = await client.resolve('https://www.youtube.com/watch?v=abc');

    expect(result).toMatchObject({
      canonicalUri: 'https://www.youtube.com/watch?v=abc',
      displayName: 'Example Video',
      fileName: 'Example_Video.webm',
    });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        '--js-runtimes',
        'node',
        '--remote-components',
        'ejs:github',
        '--cookies-from-browser',
        'firefox:test-profile',
      ]),
    );
  });

  it('falls back to an uncookied run when cookie-backed challenge solving fails', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = new YtDlpClient(
      createConfig(),
      createSpawnFactory(
        [
          {
            code: 1,
            stderr: 'WARNING: n challenge solving failed\nERROR: Requested format is not available',
          },
          {
            code: 0,
            stdout: '/tmp/downloaded-file.webm\n',
          },
        ],
        calls,
      ),
    );

    const downloaded = await client.download(
      'https://www.youtube.com/watch?v=abc',
      '/tmp/%(title)s.%(ext)s',
      'transcription',
    );

    expect(downloaded).toBe('/tmp/downloaded-file.webm');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain('--cookies-from-browser');
    expect(calls[1]?.args).not.toContain('--cookies-from-browser');
  });

  it('falls back to an uncookied run when configured cookie lookup fails', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const config = {
      ...createConfig(),
      storage: {
        ...createConfig().storage,
        ytDlpCookiesFromBrowser: '',
        ytDlpCookiesPath: '/missing/cookies.txt',
      },
    };
    const client = new YtDlpClient(
      config,
      createSpawnFactory(
        [
          {
            code: 1,
            stderr: 'FileNotFoundError: cookie file does not exist',
          },
          {
            code: 0,
            stdout: JSON.stringify({
              title: 'Recovered Video',
              webpage_url: 'https://www.youtube.com/watch?v=abc',
            }),
          },
        ],
        calls,
      ),
    );

    const result = await client.resolve('https://www.youtube.com/watch?v=abc');

    expect(result.displayName).toBe('Recovered Video');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain('--cookies');
    expect(calls[0]?.args).toContain('/missing/cookies.txt');
    expect(calls[1]?.args).not.toContain('--cookies');
  });

  it('uses the richer video format selection for understanding downloads', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = new YtDlpClient(
      createConfig(),
      createSpawnFactory(
        [
          {
            code: 0,
            stdout: '/tmp/understanding-file.mp4\n',
          },
        ],
        calls,
      ),
    );

    const downloaded = await client.download(
      'https://www.youtube.com/watch?v=abc',
      '/tmp/%(title)s.%(ext)s',
      'understanding',
    );

    expect(downloaded).toBe('/tmp/understanding-file.mp4');
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        '--format',
        'bestvideo*+bestaudio/best',
      ]),
    );
  });

  it('fails when yt-dlp does not report the downloaded file path', async () => {
    const client = new YtDlpClient(
      createConfig(),
      createSpawnFactory(
        [
          {
            code: 0,
            stdout: '\n',
          },
        ],
        [],
      ),
    );

    await expect(
      client.download(
        'https://www.youtube.com/watch?v=abc',
        '/tmp/%(title)s.%(ext)s',
        'transcription',
      ),
    ).rejects.toThrow('yt-dlp completed without reporting the downloaded file path');
  });
});
