import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalMediaProcessor, RemoteOperationService } from '../src/pipeline';
import { createFingerprint } from '../src/fingerprint';
import type { AppConfig } from '../src/config';
import type { OperationStepName } from '../src/types';

const execFile = promisify(execFileCb);

async function createAudioFixture(durationSeconds = 2): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'media-ingest-audio-'));
  const path = join(directory, 'fixture.mp3');
  await execFile('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:duration=${durationSeconds}`,
    '-q:a',
    '9',
    '-acodec',
    'libmp3lame',
    path,
  ]);
  return path;
}

async function createVideoFixture(durationSeconds = 1): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'media-ingest-video-'));
  const path = join(directory, 'fixture.mp4');
  await execFile('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x240:rate=25:duration=${durationSeconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=500:duration=${durationSeconds}`,
    '-shortest',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    path,
  ]);
  return path;
}

async function waitFor<T>(producer: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await producer();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

class InMemoryRepository {
  public readonly operations = new Map<string, any>();
  public readonly steps = new Map<string, Map<OperationStepName, any>>();
  public readonly mediaResources = new Map<string, any>();
  public readonly durableResults = new Map<string, any>();
  private nextId = 1;

  public async initialize(): Promise<void> {}
  public async close(): Promise<void> {}
  public async withAdvisoryLock<T>(_key: string, callback: () => Promise<T>): Promise<T> {
    return await callback();
  }

  public async createOperation(input: any): Promise<any> {
    const id = `op-${this.nextId++}`;
    const now = new Date();
    const operation = {
      id,
      ...input,
      status: input.status ?? 'queued',
      mediaResourceId: input.mediaResourceId ?? null,
      resultCacheKey: input.resultCacheKey ?? null,
      durableResultId: input.durableResultId ?? null,
      result: input.result ?? null,
      error: input.error ?? null,
      cacheHit: input.cacheHit ?? false,
      retryable: input.retryable ?? true,
      currentStep: input.currentStep ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    };
    this.operations.set(id, operation);
    this.steps.set(id, new Map());
    return operation;
  }

  public async upsertMediaResource(input: any): Promise<any> {
    const existing = Array.from(this.mediaResources.values()).find(
      (resource) => resource.resourceKey === input.resourceKey,
    );
    const now = new Date();
    if (existing) {
      const updated = {
        ...existing,
        ...input,
        mimeType: input.mimeType ?? null,
        updatedAt: now,
      };
      this.mediaResources.set(existing.id, updated);
      return updated;
    }

    const resource = {
      id: `media-${this.nextId++}`,
      ...input,
      mimeType: input.mimeType ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.mediaResources.set(resource.id, resource);
    return resource;
  }

  public async updateOperation(id: string, patch: any): Promise<any> {
    const current = this.operations.get(id);
    if (!current) {
      throw new Error(`Operation not found: ${id}`);
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date(),
    };
    this.operations.set(id, next);
    return next;
  }

  public async findOperationById(id: string): Promise<any> {
    return this.operations.get(id) ?? null;
  }

  public async findLatestByDedupeKey(dedupeKey: string): Promise<any> {
    return Array.from(this.operations.values())
      .filter((operation) => operation.dedupeKey === dedupeKey)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  public async findRecoverableOperations(): Promise<any[]> {
    return Array.from(this.operations.values()).filter((operation) =>
      ['queued', 'running', 'failed'].includes(operation.status),
    );
  }

  public async findReadyDurableResultByCacheKey(cacheKey: string): Promise<any> {
    return (
      Array.from(this.durableResults.values())
        .filter((result) => result.cacheKey === cacheKey && result.status === 'ready')
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    );
  }

  public async saveDurableResult(input: any): Promise<any> {
    const now = new Date();
    for (const [id, result] of this.durableResults.entries()) {
      if (result.cacheKey === input.cacheKey && result.status === 'ready') {
        this.durableResults.set(id, {
          ...result,
          status: 'superseded',
          supersededAt: now,
          updatedAt: now,
        });
      }
    }

    const durableResult = {
      id: `result-${this.nextId++}`,
      ...input,
      status: 'ready',
      supersededAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.durableResults.set(durableResult.id, durableResult);
    return durableResult;
  }

  public async listSteps(operationId: string): Promise<any[]> {
    return Array.from(this.steps.get(operationId)?.values() ?? []).sort(
      (left, right) => left.stepOrder - right.stepOrder,
    );
  }

  public async saveStep(operationId: string, name: OperationStepName, stepOrder: number, patch: any): Promise<any> {
    const operationSteps = this.steps.get(operationId);
    if (!operationSteps) {
      throw new Error(`Missing steps for ${operationId}`);
    }
    const current = operationSteps.get(name);
    const next = {
      name,
      operationId,
      stepOrder,
      status: patch.status ?? current?.status ?? 'pending',
      attemptCount: patch.attemptCount ?? current?.attemptCount ?? 0,
      output: patch.output ?? current?.output ?? null,
      error: patch.error ?? current?.error ?? null,
      startedAt: patch.startedAt ?? current?.startedAt ?? null,
      completedAt: patch.completedAt ?? current?.completedAt ?? null,
    };
    operationSteps.set(name, next);
    return next;
  }

  public async resetFailedSteps(operationId: string): Promise<void> {
    const operationSteps = this.steps.get(operationId);
    if (!operationSteps) {
      return;
    }
    for (const [name, step] of operationSteps.entries()) {
      if (step.status === 'failed') {
        operationSteps.set(name, {
          ...step,
          status: 'pending',
          error: null,
          startedAt: null,
          completedAt: null,
        });
      }
    }
  }

  public async deleteExpiredOperations(now: Date): Promise<any[]> {
    const expired = Array.from(this.operations.values()).filter(
      (operation) => operation.expiresAt && operation.expiresAt <= now,
    );
    for (const operation of expired) {
      this.operations.delete(operation.id);
      this.steps.delete(operation.id);
    }
    return expired;
  }
}

function createConfig(): AppConfig {
  return {
    app: {
      env: 'test',
      host: '127.0.0.1',
      port: 4000,
      pollAfterMs: 5,
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
      workingDirectory: join(tmpdir(), 'media-ingest-tests'),
      completedRetentionHours: 1,
      failedRetentionHours: 1,
      cleanupCron: '0 * * * *',
      ytDlpCookiesFromBrowser: '',
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

describe('RemoteOperationService', () => {
  const createdFiles: string[] = [];

  afterEach(async () => {
    for (const file of createdFiles) {
      await rm(dirname(file), { force: true, recursive: true }).catch(() => undefined);
    }
    createdFiles.length = 0;
  });

  it('processes a transcription request and reuses the completed operation from cache', async () => {
    const fixturePath = await createAudioFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    let chunkIndex = 0;
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'fake-model',
          capability: () => ({
            maxWholeFileDurationMs: 500,
            chunkDurationMs: 500,
            overlapMs: 0,
          }),
          transcribeChunk: async () => {
            const index = chunkIndex++;
            return {
              text: `chunk-${index}`,
              detectedLanguage: 'en',
              segments: [
                {
                  startMs: 0,
                  endMs: 300,
                  text: `chunk-${index}`,
                },
              ],
            };
          },
          translateText: async ({ text }: { text: string }) => `translated:${text}`,
        }),
        translateWithBestAvailable: async ({ text }: { text: string }) => `translated:${text}`,
      } as never,
    );

    await service.initialize();
    const first = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      targetLanguage: 'de',
      force: false,
    });

    const firstStatus = await waitFor(
      () => service.getOperationStatus(first.operationId),
      (value) => value.operation.status === 'completed',
    );
    expect(firstStatus.result).toMatchObject({
      kind: 'transcription',
      translatedTranscript: expect.stringContaining('translated:'),
    });

    const second = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      targetLanguage: 'de',
      force: false,
    });

    expect(second.cacheHit).toBe(true);
    expect(second.operationId).toBe(first.operationId);
  });

  it('reuses a durable transcription result after the original operation is cleaned up', async () => {
    const fixturePath = await createAudioFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'fake-model',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          transcribeChunk: async () => ({
            text: 'durable transcript',
            detectedLanguage: 'en',
            segments: [{ startMs: 0, endMs: 500, text: 'durable transcript' }],
          }),
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    await service.initialize();
    const first = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });

    await waitFor(
      () => service.getOperationStatus(first.operationId),
      (value) => value.operation.status === 'completed',
    );

    await repository.updateOperation(first.operationId, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    await service.cleanupExpiredOperations();

    const second = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });

    expect(second.cacheHit).toBe(true);
    expect(second.operationId).not.toBe(first.operationId);

    const cached = await service.getOperationStatus(second.operationId);
    expect(cached.operation.status).toBe('completed');
    expect(cached.cacheHit).toBe(true);
    expect(cached.result).toMatchObject({
      kind: 'transcription',
      sourceTranscript: 'durable transcript',
    });
  });

  it('reuses an in-flight operation instead of creating a duplicate', async () => {
    const fixturePath = await createAudioFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'slow-model',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          transcribeChunk: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              text: 'slow result',
              detectedLanguage: 'en',
              segments: [{ startMs: 0, endMs: 500, text: 'slow result' }],
            };
          },
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    await service.initialize();
    const first = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });
    const second = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });

    expect(second.cacheHit).toBe(true);
    expect(second.operationId).toBe(first.operationId);

    const completed = await waitFor(
      () => service.getOperationStatus(first.operationId),
      (value) => value.operation.status === 'completed',
    );
    expect(completed.result).toMatchObject({
      kind: 'transcription',
      sourceTranscript: 'slow result',
    });
  });

  it('runs chunk transcription with bounded parallelism', async () => {
    const fixturePath = await createAudioFixture(3);
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const config = createConfig();
    config.concurrency.chunkTasksPerOperation = 2;
    config.concurrency.providerRequests = 4;
    config.concurrency.ffmpegJobs = 2;

    let activeProviderCalls = 0;
    let maxProviderCalls = 0;

    const service = new RemoteOperationService(
      config,
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'parallel-model',
          capability: () => ({
            maxWholeFileDurationMs: 400,
            chunkDurationMs: 400,
            overlapMs: 0,
          }),
          transcribeChunk: async ({ filePath }: { filePath: string }) => {
            expect(filePath).toContain('chunk-');
            activeProviderCalls += 1;
            maxProviderCalls = Math.max(maxProviderCalls, activeProviderCalls);
            await new Promise((resolve) => setTimeout(resolve, 100));
            activeProviderCalls -= 1;
            return {
              text: 'parallel-result',
              detectedLanguage: 'en',
              segments: [{ startMs: 0, endMs: 200, text: 'parallel-result' }],
            };
          },
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    await service.initialize();
    const submitted = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: true,
    });

    const completed = await waitFor(
      () => service.getOperationStatus(submitted.operationId),
      (value) => value.operation.status === 'completed',
    );

    expect(completed.result).toMatchObject({
      kind: 'transcription',
    });
    expect(maxProviderCalls).toBeGreaterThan(1);
    expect(maxProviderCalls).toBeLessThanOrEqual(2);
  });

  it('force regeneration creates a fresh operation and supersedes the previous durable result', async () => {
    const fixturePath = await createAudioFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    let revision = 0;
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'fake-model',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          transcribeChunk: async () => {
            revision += 1;
            return {
              text: `version-${revision}`,
              detectedLanguage: 'en',
              segments: [{ startMs: 0, endMs: 500, text: `version-${revision}` }],
            };
          },
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    await service.initialize();
    const first = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });
    const firstStatus = await waitFor(
      () => service.getOperationStatus(first.operationId),
      (value) => value.operation.status === 'completed',
    );
    expect(firstStatus.result).toMatchObject({
      sourceTranscript: 'version-1',
    });

    const second = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: true,
    });
    expect(second.cacheHit).toBe(false);
    expect(second.operationId).not.toBe(first.operationId);

    const secondStatus = await waitFor(
      () => service.getOperationStatus(second.operationId),
      (value) => value.operation.status === 'completed',
    );
    expect(secondStatus.result).toMatchObject({
      sourceTranscript: 'version-2',
    });

    const durableResults = Array.from(repository.durableResults.values()).sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    expect(durableResults).toHaveLength(2);
    expect(durableResults[0]?.status).toBe('superseded');
    expect(durableResults[1]?.status).toBe('ready');
    expect(durableResults[1]?.result.sourceTranscript).toBe('version-2');
  });

  it('resumes a failed operation from the same operation id when retried', async () => {
    const fixturePath = await createAudioFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const config = createConfig();
    const dedupeKey = createFingerprint({
      kind: 'transcription',
      sourceUri: 'https://example.com/audio.mp3',
      provider: 'openai',
      model: null,
      inputLanguage: null,
      targetLanguage: null,
    });
    const service = new RemoteOperationService(
      config,
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/audio.mp3',
            displayName: 'Example',
            fileName: 'audio.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'audio.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'fake-model',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          transcribeChunk: async () => ({
            text: 'recovered',
            detectedLanguage: 'en',
            segments: [{ startMs: 0, endMs: 500, text: 'recovered' }],
          }),
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    await service.initialize();
    const prepared = await repository.createOperation({
      dedupeKey,
      kind: 'transcription',
      provider: 'openai',
      model: null,
      sourceType: 'http',
      sourceLocator: { uri: 'https://example.com/audio.mp3' },
      input: {
        kind: 'transcription',
        request: {
          source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
          provider: 'openai',
          force: false,
        },
      },
      cacheEnabled: true,
      workingDirectory: join(config.storage.workingDirectory, 'resume-op'),
    });
    await repository.saveStep(prepared.id, 'resolve_source', 0, {
      status: 'completed',
      attemptCount: 1,
      output: {
        resolvedSource: {
          kind: 'http',
          canonicalUri: 'https://example.com/audio.mp3',
          displayName: 'Example',
          fileName: 'audio.mp3',
          metadata: {},
        },
      },
    });
    await repository.saveStep(prepared.id, 'run_chunks', 4, {
      status: 'failed',
      attemptCount: 1,
      error: {
        code: 'temporary',
        message: 'temporary provider failure',
        retryable: true,
      },
    });
    await repository.updateOperation(prepared.id, {
      status: 'failed',
      error: {
        code: 'temporary',
        message: 'temporary provider failure',
        retryable: true,
      },
      workingDirectory: join(config.storage.workingDirectory, prepared.id),
    });

    const retry = await service.submitTranscription({
      source: { kind: 'http', uri: 'https://example.com/audio.mp3' },
      provider: 'openai',
      force: false,
    });

    expect(retry.operationId).toBe(prepared.id);

    const recovered = await waitFor(
      () => service.getOperationStatus(prepared.id),
      (value) => value.operation.status === 'completed',
    );
    expect(recovered.result).toMatchObject({
      kind: 'transcription',
      sourceTranscript: 'recovered',
    });
  });

  it('processes an understanding request through the understanding provider branch', async () => {
    const fixturePath = await createVideoFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/video.mp4',
            displayName: 'Example video',
            fileName: 'video.mp4',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'video.mp4',
          }),
        }),
      } as never,
      {
        understandingProvider: () => ({
          resolveModel: () => 'gemini-test',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          understandChunk: async () => ({
            responseText: 'understood',
            timeRanges: [{ startMs: 0, endMs: 500, label: 'intro' }],
          }),
        }),
      } as never,
    );

    await service.initialize();
    const submitted = await service.submitUnderstanding({
      source: { kind: 'http', uri: 'https://example.com/video.mp4' },
      provider: 'google-gemini',
      prompt: 'Summarize the clip',
      force: false,
    });

    const status = await waitFor(
      () => service.getOperationStatus(submitted.operationId),
      (value) => value.operation.status === 'completed',
    );
    expect(status.result).toMatchObject({
      kind: 'understanding',
      responseText: 'understood',
    });
  });

  it('keeps understanding results prompt-specific in the durable cache', async () => {
    const fixturePath = await createVideoFixture();
    createdFiles.push(fixturePath);
    const repository = new InMemoryRepository();
    const service = new RemoteOperationService(
      createConfig(),
      repository as never,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'http',
            canonicalUri: 'https://example.com/video.mp4',
            displayName: 'Example video',
            fileName: 'video.mp4',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'video.mp4',
          }),
        }),
      } as never,
      {
        understandingProvider: () => ({
          resolveModel: () => 'gemini-test',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          understandChunk: async ({ prompt }: { prompt: string }) => ({
            responseText: `understood:${prompt}`,
            timeRanges: [{ startMs: 0, endMs: 500, label: 'intro' }],
          }),
        }),
      } as never,
    );

    await service.initialize();
    const first = await service.submitUnderstanding({
      source: { kind: 'http', uri: 'https://example.com/video.mp4' },
      provider: 'google-gemini',
      prompt: 'Summarize the clip',
      force: false,
    });
    await waitFor(
      () => service.getOperationStatus(first.operationId),
      (value) => value.operation.status === 'completed',
    );

    await repository.updateOperation(first.operationId, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    await service.cleanupExpiredOperations();

    const second = await service.submitUnderstanding({
      source: { kind: 'http', uri: 'https://example.com/video.mp4' },
      provider: 'google-gemini',
      prompt: 'List key speakers',
      force: false,
    });

    expect(second.cacheHit).toBe(false);
    expect(second.operationId).not.toBe(first.operationId);
  });

  it('cleans up expired operations and their working directories', async () => {
    const repository = new InMemoryRepository();
    const config = createConfig();
    const service = new RemoteOperationService(
      config,
      repository as never,
      { resolverFor: () => ({}) } as never,
      {} as never,
    );
    const workingDirectory = join(config.storage.workingDirectory, 'expired-op');
    await rm(workingDirectory, { force: true, recursive: true }).catch(() => undefined);
    await execFile('mkdir', ['-p', workingDirectory]);
    const operation = await repository.createOperation({
      dedupeKey: 'expired',
      kind: 'transcription',
      provider: 'openai',
      model: null,
      sourceType: 'http',
      sourceLocator: { uri: 'https://example.com/audio.mp3' },
      input: { kind: 'transcription', request: { force: false } },
      cacheEnabled: true,
      workingDirectory,
    });
    await repository.updateOperation(operation.id, {
      expiresAt: new Date(Date.now() - 1_000),
    });

    await service.cleanupExpiredOperations();

    expect(await repository.findOperationById(operation.id)).toBeNull();
    await expect(execFile('test', ['-d', workingDirectory])).rejects.toBeTruthy();
  });
});

describe('LocalMediaProcessor', () => {
  it('processes local files without persistent jobs', async () => {
    const fixturePath = await createAudioFixture();
    const config = createConfig();
    const processor = new LocalMediaProcessor(
      config,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'local_file',
            canonicalUri: fixturePath,
            displayName: 'Local fixture',
            fileName: 'fixture.mp3',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'fixture.mp3',
          }),
        }),
      } as never,
      {
        transcriptionProvider: () => ({
          resolveModel: () => 'local-model',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          transcribeChunk: async () => ({
            text: 'local transcript',
            detectedLanguage: 'en',
            segments: [{ startMs: 0, endMs: 250, text: 'local transcript' }],
          }),
        }),
        translateWithBestAvailable: async () => '',
      } as never,
    );

    const result = await processor.transcribe({
      source: {
        kind: 'local_file',
        uri: fixturePath,
      },
      provider: 'openai',
      force: true,
    });

    expect(result).toMatchObject({
      kind: 'transcription',
      sourceTranscript: 'local transcript',
    });
    await rm(dirname(fixturePath), { force: true, recursive: true }).catch(() => undefined);
  });

  it('processes local understanding requests', async () => {
    const fixturePath = await createVideoFixture();
    const config = createConfig();
    const processor = new LocalMediaProcessor(
      config,
      {
        resolverFor: () => ({
          resolve: async () => ({
            kind: 'local_file',
            canonicalUri: fixturePath,
            displayName: 'Local video',
            fileName: 'fixture.mp4',
            metadata: {},
          }),
          materialize: async () => ({
            localPath: fixturePath,
            fileName: 'fixture.mp4',
          }),
        }),
      } as never,
      {
        understandingProvider: () => ({
          resolveModel: () => 'local-gemini',
          capability: () => ({
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 60_000,
            overlapMs: 0,
          }),
          understandChunk: async () => ({
            responseText: 'local understanding',
            timeRanges: [{ startMs: 0, endMs: 200, label: 'opening' }],
          }),
        }),
      } as never,
    );

    const result = await processor.understand({
      source: {
        kind: 'local_file',
        uri: fixturePath,
      },
      provider: 'google-gemini',
      prompt: 'Explain what happens',
      force: true,
    });

    expect(result).toMatchObject({
      kind: 'understanding',
      responseText: 'local understanding',
    });
    await rm(dirname(fixturePath), { force: true, recursive: true }).catch(() => undefined);
  });
});
