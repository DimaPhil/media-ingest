import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { type AppConfig, type RemoteOperationService } from '@media-ingest/core';

import { HealthController, OperationsController } from '../src/controllers';
import {
  adminOperationsQuerySchema,
  operationIdParamSchema,
  remoteTranscriptionRequestSchema,
  remoteUnderstandingRequestSchema,
} from '../src/http-schemas';
import { ZodValidationPipe } from '../src/zod-validation.pipe';

const config: AppConfig = {
  app: { env: 'test', host: '127.0.0.1', port: 4000, pollAfterMs: 10 },
  features: { cacheEnabled: true },
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
    telegram: { enabled: true, baseUrl: 'http://localhost:4040', bearerToken: '' },
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
} as const;

function createOperations(
  overrides: Partial<Record<keyof RemoteOperationService, unknown>> = {},
) {
  return {
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
  } satisfies Partial<Record<keyof RemoteOperationService, unknown>>;
}

describe('HealthController', () => {
  it('returns health information', () => {
    const controller = new HealthController(config);

    expect(controller.healthz()).toEqual({
      status: 'ok',
      env: 'test',
    });
  });

  it('renders the admin page shell', () => {
    const controller = new HealthController(config);
    const send = vi.fn();
    const type = vi.fn().mockReturnValue({ send });

    controller.admin({ type });

    expect(type).toHaveBeenCalledWith('html');
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Media Ingest Control Room'));
  });
});

describe('OperationsController', () => {
  it('accepts valid transcription requests after schema validation and dispatches work', async () => {
    const operations = createOperations();
    const controller = new OperationsController(operations as RemoteOperationService);
    const body = new ZodValidationPipe(remoteTranscriptionRequestSchema).transform(validTranscriptionRequest);

    await expect(controller.createTranscription(body)).resolves.toEqual({
      operationId: validOperationId,
      status: 'queued',
      cacheHit: false,
      pollAfterMs: 10,
      dedupeKey: 'dedupe-1',
    });
    expect(operations.submitTranscription).toHaveBeenCalledWith(validTranscriptionRequest);
  });

  it('rejects invalid source URLs at the validation boundary', () => {
    const pipe = new ZodValidationPipe(remoteTranscriptionRequestSchema);

    expect(() =>
      pipe.transform({
        ...validTranscriptionRequest,
        source: {
          kind: 'youtube',
          uri: 'https://example.com/video.mp4',
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects unsupported Google Drive folders at the validation boundary', () => {
    const pipe = new ZodValidationPipe(remoteUnderstandingRequestSchema);

    expect(() =>
      pipe.transform({
        source: {
          kind: 'google_drive',
          uri: 'https://drive.google.com/drive/folders/abc123',
        },
        provider: 'google-gemini',
        prompt: 'Summarize the video.',
      }),
    ).toThrow(BadRequestException);
  });

  it('delegates operation lookup after validating the id', async () => {
    const operations = createOperations();
    const controller = new OperationsController(operations as RemoteOperationService);
    const params = new ZodValidationPipe(operationIdParamSchema).transform({
      operationId: validOperationId,
    });

    await expect(controller.getOperation(params)).resolves.toEqual({
      operation: { id: validOperationId, status: 'completed' },
    });
    expect(operations.getOperationStatus).toHaveBeenCalledWith(validOperationId);
  });

  it('rejects invalid operation ids at the validation boundary', () => {
    const pipe = new ZodValidationPipe(operationIdParamSchema);

    expect(() => pipe.transform({ operationId: 'not-a-uuid' })).toThrow(BadRequestException);
  });

  it('returns filtered admin operations lists', async () => {
    const operations = createOperations();
    const controller = new OperationsController(operations as RemoteOperationService);
    const query = new ZodValidationPipe(adminOperationsQuerySchema).transform({
      limit: '25',
      status: 'running',
      kind: 'transcription',
      provider: 'openai',
      sourceType: 'http',
    });

    await expect(controller.listOperations(query)).resolves.toEqual({
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

  it('rejects invalid admin query parameters at the validation boundary', () => {
    const pipe = new ZodValidationPipe(adminOperationsQuerySchema);

    expect(() => pipe.transform({ limit: '999' })).toThrow(BadRequestException);
  });

  it('returns admin overview payloads', async () => {
    const operations = createOperations();
    const controller = new OperationsController(operations as RemoteOperationService);

    await expect(controller.getAdminOverview()).resolves.toEqual({
      counts: { total: 1 },
    });
  });

  it('maps missing operations to not found responses', async () => {
    const operations = createOperations({
      getOperationStatus: vi.fn().mockRejectedValue(new Error(`Operation not found: ${validOperationId}`)),
    });
    const controller = new OperationsController(operations as RemoteOperationService);

    await expect(
      controller.getOperation({ operationId: validOperationId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps unexpected service errors to internal server errors', async () => {
    const operations = createOperations({
      submitUnderstanding: vi.fn().mockRejectedValue(new Error('unexpected')),
    });
    const controller = new OperationsController(operations as RemoteOperationService);

    await expect(
      controller.createUnderstanding({
        source: { kind: 'http', uri: 'https://example.com/video.mp4' },
        provider: 'google-gemini',
        prompt: 'Describe this video.',
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
