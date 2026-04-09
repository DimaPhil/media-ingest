import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

const providerSchema = z.object({
  openai: z.object({
    enabled: z.boolean().default(true),
    apiKey: z.string().default(''),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    defaultModel: z.string().default('gpt-4o-transcribe'),
    diarizeModel: z.string().default('gpt-4o-transcribe'),
    translationModel: z.string().default('gpt-4.1-mini'),
  }),
  gemini: z.object({
    enabled: z.boolean().default(true),
    apiKey: z.string().default(''),
    geminiTranscriptionModel: z.string().default('gemini-2.5-flash'),
    geminiUnderstandingModel: z.string().default('gemini-2.5-pro'),
  }),
  googleCloud: z.object({
    enabled: z.boolean().default(true),
    projectId: z.string().default(''),
    location: z.string().default('global'),
    speechRecognizer: z.string().default('projects/_/locations/global/recognizers/_'),
    serviceAccountJson: z.string().default(''),
  }),
});

const configSchema = z.object({
  app: z.object({
    env: z.string().default('development'),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3000),
    pollAfterMs: z.number().int().positive().default(1500),
  }),
  features: z.object({
    cacheEnabled: z.boolean().default(true),
  }),
  storage: z.object({
    workingDirectory: z.string().default('./.tmp/media-ingest'),
    completedRetentionHours: z.number().positive().default(24),
    failedRetentionHours: z.number().positive().default(4),
    cleanupCron: z.string().default('0 * * * *'),
    ytDlpCookiesFromBrowser: z.string().default(''),
    ytDlpCookiesPath: z.string().default(''),
  }),
  database: z.object({
    url: z.string().default(''),
  }),
  providers: providerSchema,
  sources: z.object({
    googleDrive: z.object({
      enabled: z.boolean().default(true),
    }),
    telegram: z.object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().url().default('http://localhost:8080'),
      bearerToken: z.string().default(''),
    }),
    ytDlp: z.object({
      enabled: z.boolean().default(true),
      binaryPath: z.string().default('yt-dlp'),
    }),
    http: z.object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(30000),
    }),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      isPlainObject(value) &&
      key in result &&
      isPlainObject(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result as T;
}

function expandHome(value: string): string {
  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function resolvePath(value: string, configPath?: string): string {
  const expanded = expandHome(value);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolve(configPath ? dirname(configPath) : process.cwd(), expanded);
}

function parseConfigFile(configPath?: string): Record<string, unknown> {
  if (!configPath) {
    return {};
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw);
  return isPlainObject(parsed) ? parsed : {};
}

function findDefaultConfigPath(startDirectory = process.cwd()): string | undefined {
  let current = resolve(startDirectory);
  while (true) {
    const primary = join(current, 'config', 'app.yaml');
    if (existsSync(primary)) {
      return primary;
    }
    const fallback = join(current, 'config', 'app.example.yaml');
    if (existsSync(fallback)) {
      return fallback;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (env.DATABASE_URL) {
    overrides.database = { url: env.DATABASE_URL };
  }
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) {
    overrides.providers = {
      ...(overrides.providers as object),
      openai: {
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
      },
    };
  }
  if (
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.GOOGLE_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT_ID ||
    env.GOOGLE_LOCATION ||
    env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON
  ) {
    overrides.providers = {
      ...(overrides.providers as object),
      gemini: {
        apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
      },
      googleCloud: {
        projectId: env.GOOGLE_CLOUD_PROJECT_ID ?? env.GOOGLE_PROJECT_ID,
        location: env.GOOGLE_LOCATION,
        serviceAccountJson:
          env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON ?? env.GOOGLE_SERVICE_ACCOUNT_JSON,
      },
    };
  }
  if (env.MEDIA_INGEST_CONFIG_PATH) {
    overrides.app = {
      ...(overrides.app as object),
    };
  }
  if (env.MEDIA_INGEST_CACHE_ENABLED) {
    overrides.features = {
      cacheEnabled: env.MEDIA_INGEST_CACHE_ENABLED === 'true',
    };
  }
  if (
    env.MEDIA_INGEST_WORKDIR ||
    env.YT_DLP_COOKIES_FROM_BROWSER ||
    env.YT_DLP_COOKIES_PATH
  ) {
    overrides.storage = {
      workingDirectory: env.MEDIA_INGEST_WORKDIR,
      ytDlpCookiesFromBrowser: env.YT_DLP_COOKIES_FROM_BROWSER,
      ytDlpCookiesPath: env.YT_DLP_COOKIES_PATH,
    };
  }
  if (env.TELEGRAM_PROXY_BASE_URL || env.TELEGRAM_PROXY_BEARER_TOKEN) {
    overrides.sources = {
      ...(overrides.sources as object),
      telegram: {
        baseUrl: env.TELEGRAM_PROXY_BASE_URL,
        bearerToken: env.TELEGRAM_PROXY_BEARER_TOKEN,
      },
    };
  }
  if (env.YT_DLP_BINARY_PATH) {
    overrides.sources = {
      ...(overrides.sources as object),
      ytDlp: {
        binaryPath: env.YT_DLP_BINARY_PATH,
      },
    };
  }
  return overrides;
}

export function loadAppConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const explicitConfigPath =
    options.configPath ?? env.MEDIA_INGEST_CONFIG_PATH ?? findDefaultConfigPath();
  const defaults: AppConfig = {
    app: {
      env: 'development',
      host: '0.0.0.0',
      port: 3000,
      pollAfterMs: 1500,
    },
    features: {
      cacheEnabled: true,
    },
    storage: {
      workingDirectory: './.tmp/media-ingest',
      completedRetentionHours: 24,
      failedRetentionHours: 4,
      cleanupCron: '0 * * * *',
      ytDlpCookiesFromBrowser: '',
      ytDlpCookiesPath: '',
    },
    database: {
      url: '',
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
      googleDrive: {
        enabled: true,
      },
      telegram: {
        enabled: true,
        baseUrl: 'http://localhost:8080',
        bearerToken: '',
      },
      ytDlp: {
        enabled: true,
        binaryPath: 'yt-dlp',
      },
      http: {
        enabled: true,
        timeoutMs: 30000,
      },
    },
  };
  const merged = deepMerge(
    defaults,
    deepMerge(parseConfigFile(explicitConfigPath), envOverrides(env)),
  );
  const parsed = configSchema.parse(merged);
  return {
    ...parsed,
    storage: {
      ...parsed.storage,
      workingDirectory: resolvePath(parsed.storage.workingDirectory, explicitConfigPath),
      ytDlpCookiesFromBrowser: parsed.storage.ytDlpCookiesFromBrowser,
      ytDlpCookiesPath: parsed.storage.ytDlpCookiesPath
        ? resolvePath(parsed.storage.ytDlpCookiesPath, explicitConfigPath)
        : '',
    },
  };
}
