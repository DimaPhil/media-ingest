import { z } from 'zod';

import { operationKinds, providerIds } from './types';
import {
  validateGoogleDriveSourceUri,
  validateHttpSourceUri,
  validateTelegramSourceUri,
  validateYoutubeSourceUri,
  validateYtDlpSourceUri,
} from './source-validation';

function buildSourceUriSchema(validate: (uri: string) => string) {
  return z.string().trim().min(1).superRefine((value, context) => {
    try {
      validate(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid source URI',
      });
    }
  });
}

const youtubeSourceSchema = z.object({
  kind: z.literal('youtube'),
  uri: buildSourceUriSchema(validateYoutubeSourceUri),
});

const ytDlpSourceSchema = z.object({
  kind: z.literal('yt_dlp'),
  uri: buildSourceUriSchema(validateYtDlpSourceUri),
});

const googleDriveSourceSchema = z.object({
  kind: z.literal('google_drive'),
  uri: buildSourceUriSchema(validateGoogleDriveSourceUri),
});

const telegramSourceSchema = z.object({
  kind: z.literal('telegram'),
  uri: buildSourceUriSchema(validateTelegramSourceUri),
});

const httpSourceSchema = z.object({
  kind: z.literal('http'),
  uri: buildSourceUriSchema(validateHttpSourceUri),
});

const localFileSourceSchema = z.object({
  kind: z.literal('local_file'),
  uri: z.string().trim().min(1),
});

export const baseSourceSchema = z.discriminatedUnion('kind', [
  youtubeSourceSchema,
  ytDlpSourceSchema,
  googleDriveSourceSchema,
  telegramSourceSchema,
  httpSourceSchema,
  localFileSourceSchema,
]);

export const remoteSourceSchema = z.discriminatedUnion('kind', [
  youtubeSourceSchema,
  ytDlpSourceSchema,
  googleDriveSourceSchema,
  telegramSourceSchema,
  httpSourceSchema,
]);

export const localSourceSchema = localFileSourceSchema;

const transcriptionProviderSchema = z.enum([
  providerIds[0],
  providerIds[1],
  providerIds[2],
]);

const understandingProviderSchema = z.enum([providerIds[1]]);

export const transcriptionRequestSchema = z.object({
  source: baseSourceSchema,
  provider: transcriptionProviderSchema,
  model: z.string().trim().min(1).optional(),
  inputLanguage: z.string().trim().min(2).max(32).optional(),
  targetLanguage: z.string().trim().min(2).max(32).optional(),
  force: z.boolean().default(false),
});

export const remoteTranscriptionRequestSchema = transcriptionRequestSchema.extend({
  source: remoteSourceSchema,
});

export const understandingRequestSchema = z.object({
  source: baseSourceSchema,
  provider: understandingProviderSchema,
  model: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  force: z.boolean().default(false),
});

export const remoteUnderstandingRequestSchema = understandingRequestSchema.extend({
  source: remoteSourceSchema,
});

export const operationRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(operationKinds[0]),
    request: transcriptionRequestSchema,
  }),
  z.object({
    kind: z.literal(operationKinds[1]),
    request: understandingRequestSchema,
  }),
]);

export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type MediaSourceInput = z.infer<typeof baseSourceSchema>;
export type RemoteMediaSourceInput = z.infer<typeof remoteSourceSchema>;
export type LocalMediaSourceInput = z.infer<typeof localSourceSchema>;
export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>;
export type RemoteTranscriptionRequest = z.infer<typeof remoteTranscriptionRequestSchema>;
export type UnderstandingRequest = z.infer<typeof understandingRequestSchema>;
export type RemoteUnderstandingRequest = z.infer<typeof remoteUnderstandingRequestSchema>;
