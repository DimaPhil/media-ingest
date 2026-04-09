import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteOperationService, type AppConfig } from '@media-ingest/core';

import { HealthController, OperationsController } from '../src/controllers';
import { APP_CONFIG } from '../src/tokens';

const config: AppConfig = {
  app: { env: 'test', host: '127.0.0.1', port: 3000, pollAfterMs: 10 },
  features: { cacheEnabled: true },
  storage: {
    workingDirectory: '/tmp',
    completedRetentionHours: 24,
    failedRetentionHours: 4,
    cleanupCron: '0 * * * *',
    ytDlpCookiesFromBrowser: '',
    ytDlpCookiesPath: '',
  },
  database: { url: 'postgres://unused' },
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
    telegram: { enabled: true, baseUrl: 'http://localhost:8080', bearerToken: '' },
    ytDlp: { enabled: true, binaryPath: 'yt-dlp' },
    http: { enabled: true, timeoutMs: 1000 },
  },
};

const validOperationId = 'd7f2936b-781d-4bd2-8f42-935f6ec1121f';
const validTranscriptionRequest = {
  source: {
    kind: 'youtube',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  provider: 'openai',
  model: 'gpt-4o-transcribe',
  force: false,
};

const apps: INestApplication[] = [];

async function createApp(overrides: Partial<Record<keyof RemoteOperationService, unknown>> = {}) {
  const operations = {
    submitTranscription: vi.fn().mockResolvedValue({
      operationId: validOperationId,
      status: 'queued',
      cacheHit: false,
      pollAfterMs: 10,
      dedupeKey: 'dedupe-1',
    }),
    submitUnderstanding: vi.fn().mockResolvedValue({
      operationId: validOperationId,
      status: 'queued',
      cacheHit: false,
      pollAfterMs: 10,
      dedupeKey: 'dedupe-2',
    }),
    getOperationStatus: vi.fn().mockResolvedValue({
      operation: { id: validOperationId, status: 'completed' },
    }),
    getAdminOverview: vi.fn().mockResolvedValue({ counts: { total: 1 } }),
    listOperations: vi.fn().mockResolvedValue([{ id: validOperationId, status: 'running' }]),
    ...overrides,
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController, OperationsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: RemoteOperationService, useValue: operations },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  apps.push(app);

  return { app, operations };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API controllers', () => {
  it('returns health information', async () => {
    const { app } = await createApp();

    await request(app.getHttpServer())
      .get('/healthz')
      .expect(200)
      .expect({
        status: 'ok',
        env: 'test',
      });
  });

  it('renders the admin page shell', async () => {
    const { app } = await createApp();

    const response = await request(app.getHttpServer())
      .get('/admin')
      .expect(200);

    expect(response.text).toContain('Media Ingest Control Room');
  });

  it('accepts valid transcription requests at the HTTP boundary', async () => {
    const { app, operations } = await createApp();

    await request(app.getHttpServer())
      .post('/v1/transcriptions')
      .send(validTranscriptionRequest)
      .expect(202)
      .expect({
        operationId: validOperationId,
        status: 'queued',
        cacheHit: false,
        pollAfterMs: 10,
        dedupeKey: 'dedupe-1',
      });

    expect(operations.submitTranscription).toHaveBeenCalledWith(validTranscriptionRequest);
  });

  it('rejects invalid source URLs before dispatching work', async () => {
    const { app, operations } = await createApp();

    const response = await request(app.getHttpServer())
      .post('/v1/transcriptions')
      .send({
        ...validTranscriptionRequest,
        source: {
          kind: 'youtube',
          uri: 'https://example.com/video.mp4',
        },
      })
      .expect(400);

    expect(response.body.message).toBe('Validation failed');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Unsupported YouTube URL',
          path: ['source', 'uri'],
        }),
      ]),
    );
    expect(operations.submitTranscription).not.toHaveBeenCalled();
  });

  it('rejects unsupported Google Drive folders at the HTTP boundary', async () => {
    const { app, operations } = await createApp();

    const response = await request(app.getHttpServer())
      .post('/v1/understanding')
      .send({
        source: {
          kind: 'google_drive',
          uri: 'https://drive.google.com/drive/folders/abc123',
        },
        provider: 'google-gemini',
        prompt: 'Summarize the video.',
      })
      .expect(400);

    expect(response.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Google Drive folders are not supported in v1',
          path: ['source', 'uri'],
        }),
      ]),
    );
    expect(operations.submitUnderstanding).not.toHaveBeenCalled();
  });

  it('delegates operation lookup to the service after validating the id', async () => {
    const { app, operations } = await createApp();

    await request(app.getHttpServer())
      .get(`/v1/operations/${validOperationId}`)
      .expect(200)
      .expect({
        operation: { id: validOperationId, status: 'completed' },
      });

    expect(operations.getOperationStatus).toHaveBeenCalledWith(validOperationId);
  });

  it('rejects invalid operation ids before calling the service', async () => {
    const { app, operations } = await createApp();

    const response = await request(app.getHttpServer())
      .get('/v1/operations/not-a-uuid')
      .expect(400);

    expect(response.body.message).toBe('Validation failed');
    expect(operations.getOperationStatus).not.toHaveBeenCalled();
  });

  it('returns filtered admin operations lists', async () => {
    const { app, operations } = await createApp();

    await request(app.getHttpServer())
      .get('/v1/admin/operations?limit=25&status=running&kind=transcription&provider=openai&sourceType=http')
      .expect(200)
      .expect({
        items: [{ id: validOperationId, status: 'running' }],
        meta: { limit: 25, count: 1 },
      });

    expect(operations.listOperations).toHaveBeenCalledWith({
      limit: 25,
      status: 'running',
      kind: 'transcription',
      provider: 'openai',
      sourceType: 'http',
    });
  });

  it('rejects invalid admin query parameters before hitting the service', async () => {
    const { app, operations } = await createApp();

    await request(app.getHttpServer())
      .get('/v1/admin/operations?limit=999')
      .expect(400);

    expect(operations.listOperations).not.toHaveBeenCalled();
  });

  it('returns admin overview payloads', async () => {
    const { app } = await createApp();

    await request(app.getHttpServer())
      .get('/v1/admin/overview')
      .expect(200)
      .expect({
        counts: { total: 1 },
      });
  });

  it('maps missing operations to not found responses', async () => {
    const { app } = await createApp({
      getOperationStatus: vi.fn().mockRejectedValue(new Error(`Operation not found: ${validOperationId}`)),
    });

    await request(app.getHttpServer())
      .get(`/v1/operations/${validOperationId}`)
      .expect(404);
  });

  it('maps unexpected service errors to internal server errors', async () => {
    const { app } = await createApp({
      submitUnderstanding: vi.fn().mockRejectedValue(new Error('unexpected')),
    });

    await request(app.getHttpServer())
      .post('/v1/understanding')
      .send({
        source: { kind: 'http', uri: 'https://example.com/video.mp4' },
        provider: 'google-gemini',
        prompt: 'Describe this video.',
      })
      .expect(500);
  });
});
