export const operationStatuses = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

export type OperationStatus = (typeof operationStatuses)[number];

export const operationKinds = ['transcription', 'understanding'] as const;

export type OperationKind = (typeof operationKinds)[number];

export const operationStepNames = [
  'resolve_source',
  'inspect_media',
  'materialize_media',
  'plan_chunks',
  'run_chunks',
  'merge_chunks',
  'translate_transcript',
  'finalize_result',
  'cleanup',
] as const;

export type OperationStepName = (typeof operationStepNames)[number];

export const stepStatuses = ['pending', 'running', 'completed', 'failed'] as const;

export type StepStatus = (typeof stepStatuses)[number];

export const durableResultStatuses = ['ready', 'superseded'] as const;

export type DurableResultStatus = (typeof durableResultStatuses)[number];

export const providerIds = ['openai', 'google-gemini', 'google-speech'] as const;

export type ProviderId = (typeof providerIds)[number];

export const sourceKinds = [
  'youtube',
  'yt_dlp',
  'google_drive',
  'telegram',
  'http',
  'local_file',
] as const;

export type SourceKind = (typeof sourceKinds)[number];

export interface MediaSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult {
  kind: 'transcription';
  sourceLanguage: string | null;
  detectedLanguage: string | null;
  targetLanguage?: string;
  sourceTranscript: string;
  translatedTranscript?: string;
  segments: MediaSegment[];
  speakers?: string[];
  provider: {
    id: ProviderId;
    model: string;
    raw?: unknown;
  };
}

export interface TimeRange {
  startMs: number;
  endMs: number;
  label?: string;
}

export interface UnderstandingResult {
  kind: 'understanding';
  prompt: string;
  responseText: string;
  timeRanges?: TimeRange[];
  provider: {
    id: ProviderId;
    model: string;
    raw?: unknown;
  };
}

export type OperationResult = TranscriptionResult | UnderstandingResult;

export interface OperationError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface OperationTimings {
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface OperationProgress {
  completedSteps: number;
  totalSteps: number;
  percentage: number;
  steps: Array<{
    name: OperationStepName;
    status: StepStatus;
    startedAt?: string;
    completedAt?: string;
  }>;
}
