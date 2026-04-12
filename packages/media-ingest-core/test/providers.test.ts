import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createTranscriptionMock,
  createResponseMock,
  deleteFileMock,
  generateContentMock,
  recognizeMock,
  toFileMock,
  uploadFileMock,
} = vi.hoisted(() => ({
  createTranscriptionMock: vi.fn(),
  createResponseMock: vi.fn(),
  deleteFileMock: vi.fn(),
  generateContentMock: vi.fn(),
  recognizeMock: vi.fn(),
  toFileMock: vi.fn(async (_contents: Buffer, fileName: string) => ({ fileName })),
  uploadFileMock: vi.fn(),
}));

vi.mock('@google-cloud/speech', () => {
  class MockSpeechClient {
    public constructor(_config: unknown) {}
    public recognize = recognizeMock;
  }

  return { SpeechClient: MockSpeechClient };
});

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    public readonly files = {
      upload: uploadFileMock,
      delete: deleteFileMock,
    };

    public readonly models = {
      generateContent: generateContentMock,
    };

    public constructor(_config: unknown) {}
  }

  return {
    GoogleGenAI: MockGoogleGenAI,
    createPartFromText: (text: string) => ({ text }),
    createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { uri, mimeType } }),
    createUserContent: (parts: unknown[]) => ({ role: 'user', parts }),
  };
});

vi.mock('openai', () => {
  class MockOpenAI {
    public static toFile = toFileMock;
    public readonly audio = {
      transcriptions: {
        create: createTranscriptionMock,
      },
    };
    public readonly responses = {
      create: createResponseMock,
    };

    public constructor(_config: unknown) {}
  }

  return { default: MockOpenAI };
});

import type { AppConfig } from '../src/config';
import {
  ProviderRegistry,
  buildOpenAiTranscriptionRequestOptions,
  normalizeOpenAiTranscriptionPayload,
  providerCapabilityFor,
} from '../src/providers';

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
      ytDlpCookiesFromBrowser: '',
      ytDlpCookiesPath: '',
    },
    database: {
      url: 'postgres://unused',
    },
    providers: {
      openai: {
        enabled: true,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-transcribe',
        diarizeModel: 'gpt-4o-transcribe-diarize',
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

describe('OpenAI transcription request options', () => {
  it('uses verbose_json only for whisper models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('whisper-1')).toEqual({
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
  });

  it('uses json for gpt-4o transcribe models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('gpt-4o-transcribe-api-v3')).toEqual({
      response_format: 'json',
    });
  });

  it('uses diarized_json for diarization models', () => {
    expect(buildOpenAiTranscriptionRequestOptions('gpt-4o-transcribe-diarize')).toEqual({
      response_format: 'diarized_json',
    });
  });

  it('returns provider-specific capabilities for Gemini and Google Speech', () => {
    expect(providerCapabilityFor('google-gemini')).toEqual({
      maxWholeFileDurationMs: 20 * 60 * 1000,
      chunkDurationMs: 10 * 60 * 1000,
      overlapMs: 2_000,
    });
    expect(providerCapabilityFor('google-speech')).toEqual({
      maxWholeFileDurationMs: 25 * 60 * 1000,
      chunkDurationMs: 20 * 60 * 1000,
      overlapMs: 2_000,
    });
  });

  it('normalizes empty OpenAI payloads safely', () => {
    expect(normalizeOpenAiTranscriptionPayload(null)).toEqual({
      text: '',
      detectedLanguage: null,
      segments: [],
      raw: null,
    });
  });
});

describe('OpenAI provider', () => {
  beforeEach(() => {
    createTranscriptionMock.mockReset();
    createResponseMock.mockReset();
    deleteFileMock.mockReset();
    generateContentMock.mockReset();
    recognizeMock.mockReset();
    toFileMock.mockClear();
    uploadFileMock.mockReset();
  });

  it('sends json response format for gpt-4o transcribe models', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-openai-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    createTranscriptionMock.mockResolvedValue({
      text: 'hello world',
      language: 'en',
    });

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('openai');
    const result = await provider.transcribeChunk({
      filePath,
      model: 'gpt-4o-transcribe-api-v3',
    });

    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-transcribe-api-v3',
        response_format: 'json',
      }),
    );
    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        timestamp_granularities: expect.anything(),
      }),
    );
    expect(result.text).toBe('hello world');
    expect(result.detectedLanguage).toBe('en');
  });

  it('sends diarized_json for diarization models and maps speakers', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-openai-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    createTranscriptionMock.mockResolvedValue({
      text: 'hi there',
      language: 'en',
      segments: [
        {
          start: 0,
          end: 1.25,
          text: 'hi there',
          speaker: 'speaker_1',
        },
      ],
    });

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('openai');
    const result = await provider.transcribeChunk({
      filePath,
      model: 'gpt-4o-transcribe-diarize',
    });

    expect(createTranscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-transcribe-diarize',
        response_format: 'diarized_json',
      }),
    );
    expect(result.segments).toEqual([
      {
        startMs: 0,
        endMs: 1250,
        text: 'hi there',
        speaker: 'speaker_1',
      },
    ]);
  });
});

describe('Gemini provider', () => {
  it('uses the Gemini SDK for transcription uploads and cleans up the uploaded file', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-gemini-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    uploadFileMock.mockResolvedValue({
      name: 'files/123',
      uri: 'gs://files/123',
      mimeType: 'audio/mpeg',
    });
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        text: 'hello from gemini',
        detectedLanguage: 'en',
        segments: [{ startMs: 0, endMs: 1000, text: 'hello from gemini' }],
      }),
    });
    deleteFileMock.mockResolvedValue({});

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('google-gemini');
    const result = await provider.transcribeChunk({
      filePath,
    });

    expect(uploadFileMock).toHaveBeenCalledWith({
      file: filePath,
      config: { mimeType: 'audio/mpeg' },
    });
    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        config: { responseMimeType: 'application/json' },
      }),
    );
    expect(deleteFileMock).toHaveBeenCalledWith({ name: 'files/123' });
    expect(result).toEqual(
      expect.objectContaining({
        text: 'hello from gemini',
        detectedLanguage: 'en',
        segments: [{ startMs: 0, endMs: 1000, text: 'hello from gemini' }],
      }),
    );
  });

  it('uses the Gemini SDK for video understanding', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-gemini-'));
    const filePath = join(fixtureDirectory, 'video.mp4');
    await writeFile(filePath, 'fake');

    uploadFileMock.mockResolvedValue({
      name: 'files/456',
      uri: 'gs://files/456',
      mimeType: 'video/mp4',
    });
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        responseText: 'summary',
        timeRanges: [{ startMs: 0, endMs: 5000, label: 'intro' }],
      }),
    });
    deleteFileMock.mockResolvedValue({});

    const provider = new ProviderRegistry(createConfig()).understandingProvider('google-gemini');
    const result = await provider.understandChunk({
      filePath,
      prompt: 'Summarize the video.',
    });

    expect(uploadFileMock).toHaveBeenCalledWith({
      file: filePath,
      config: { mimeType: 'video/mp4' },
    });
    expect(result).toEqual({
      responseText: 'summary',
      timeRanges: [{ startMs: 0, endMs: 5000, label: 'intro' }],
      raw: {
        payload: {
          responseText: 'summary',
          timeRanges: [{ startMs: 0, endMs: 5000, label: 'intro' }],
        },
        uploadedFile: {
          name: 'files/456',
          uri: 'gs://files/456',
          mimeType: 'video/mp4',
        },
      },
    });
  });

  it('uses the Gemini SDK for translation', async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        translatedText: 'hola mundo',
      }),
    });

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('google-gemini');
    const translated = await provider.translateText?.({
      text: 'hello world',
      targetLanguage: 'es',
    });

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        config: { responseMimeType: 'application/json' },
      }),
    );
    expect(translated).toBe('hola mundo');
  });
});

describe('Google Speech provider', () => {
  it('maps recognize responses into transcript segments', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'media-ingest-speech-'));
    const filePath = join(fixtureDirectory, 'audio.mp3');
    await writeFile(filePath, 'fake');

    recognizeMock.mockResolvedValue([
      {
        results: [
          {
            languageCode: 'en-US',
            alternatives: [
              {
                transcript: 'hello world',
                words: [
                  { startOffset: { seconds: 0 }, endOffset: { seconds: 1 } },
                  { startOffset: { seconds: 1 }, endOffset: { seconds: 2 } },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const provider = new ProviderRegistry(createConfig()).transcriptionProvider('google-speech');
    const result = await provider.transcribeChunk({ filePath });

    expect(recognizeMock).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        text: 'hello world',
        detectedLanguage: 'en-US',
        segments: [{ startMs: 0, endMs: 2000, text: 'hello world' }],
      }),
    );
  });
});

describe('Provider registry', () => {
  it('falls back to OpenAI for translation when the preferred provider cannot translate', async () => {
    createResponseMock.mockResolvedValue({ output_text: 'bonjour' });

    const config = createConfig();
    config.providers.gemini.enabled = false;
    const registry = new ProviderRegistry(config);
    const translated = await registry.translateWithBestAvailable({
      preferredProvider: 'google-speech',
      text: 'hello',
      targetLanguage: 'fr',
    });

    expect(createResponseMock).toHaveBeenCalledOnce();
    expect(translated).toBe('bonjour');
  });
});
