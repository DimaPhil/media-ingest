import type {
  OperationRequest,
  TranscriptionRequest,
  UnderstandingRequest,
} from '../contracts';
import type { PersistedOperationStep, PersistedOperation } from '../db';
import type { MediaInspection, PlannedChunk } from '../media';
import type { MaterializedSource, ResolvedSource } from '../sources';
import type {
  MediaSegment,
  OperationError,
  OperationKind,
  OperationResult,
  OperationStatus,
  OperationStepName,
  StepStatus,
  TimeRange,
} from '../types';

export type AnyRequest = TranscriptionRequest | UnderstandingRequest;

export interface PipelineContext {
  resolvedSource?: ResolvedSource;
  inspection?: MediaInspection;
  materialized?: MaterializedSource;
  plannedChunks?: PlannedChunk[];
  chunkTranscripts?: Array<{
    index: number;
    startMs: number;
    endMs: number;
    text: string;
    detectedLanguage: string | null;
    segments: MediaSegment[];
    raw?: unknown;
  }>;
  chunkUnderstanding?: Array<{
    index: number;
    startMs: number;
    endMs: number;
    responseText: string;
    timeRanges?: TimeRange[];
    raw?: unknown;
  }>;
  mergedResult?: OperationResult;
  translatedTranscript?: string;
}

export type ChunkTranscript = NonNullable<PipelineContext['chunkTranscripts']>[number];
export type ChunkUnderstanding = NonNullable<PipelineContext['chunkUnderstanding']>[number];

export interface StepOutputMap {
  resolve_source: { resolvedSource: ResolvedSource };
  inspect_media: { inspection: MediaInspection };
  materialize_media: { materialized: MaterializedSource };
  plan_chunks: { inspection: MediaInspection; plannedChunks: PlannedChunk[] };
  run_chunks: {
    chunkTranscripts?: ChunkTranscript[];
    chunkUnderstanding?: ChunkUnderstanding[];
  };
  merge_chunks: { result: OperationResult };
  translate_transcript: { translatedTranscript: string | null };
  finalize_result: { result: OperationResult };
  cleanup: { cleanedUp: boolean };
}

export type StepOutput = StepOutputMap[keyof StepOutputMap];

export interface PersistedOperationStepLike {
  name: OperationStepName;
  status: StepStatus;
  output: StepOutput | null;
  error: OperationError | null;
  attemptCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface StepStore {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly request: AnyRequest;
  readonly workingDirectory: string;
  loadSteps(): Promise<Map<OperationStepName, PersistedOperationStepLike>>;
  setOperationState(patch: {
    status?: OperationStatus;
    currentStep?: OperationStepName | null;
    result?: OperationResult | null;
    error?: OperationError | null;
    retryable?: boolean;
    cacheHit?: boolean;
    startedAt?: Date | null;
    completedAt?: Date | null;
    expiresAt?: Date | null;
    lastHeartbeatAt?: Date | null;
  }): Promise<void>;
  saveStep(
    name: OperationStepName,
    order: number,
    patch: {
      status?: StepStatus;
      output?: StepOutput | null;
      error?: OperationError | null;
      attemptCount?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<PersistedOperationStepLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMediaSegment(value: unknown): value is MediaSegment {
  return isRecord(value)
    && isNumber(value.startMs)
    && isNumber(value.endMs)
    && isString(value.text)
    && (value.speaker === undefined || isString(value.speaker));
}

function isTimeRange(value: unknown): value is TimeRange {
  return isRecord(value)
    && isNumber(value.startMs)
    && isNumber(value.endMs)
    && (value.label === undefined || isString(value.label));
}

function isResolvedSource(value: unknown): value is ResolvedSource {
  return isRecord(value)
    && isString(value.kind)
    && isString(value.canonicalUri)
    && isString(value.displayName)
    && isString(value.fileName)
    && (value.mimeType === undefined || isString(value.mimeType))
    && isRecord(value.metadata);
}

function isMaterializedSource(value: unknown): value is MaterializedSource {
  return isRecord(value)
    && isString(value.localPath)
    && isString(value.fileName)
    && (value.mimeType === undefined || isString(value.mimeType));
}

function isMediaInspection(value: unknown): value is MediaInspection {
  return isRecord(value)
    && isString(value.path)
    && (value.formatName === null || value.formatName === undefined || isString(value.formatName))
    && isNumber(value.durationMs)
    && (value.sizeBytes === null || value.sizeBytes === undefined || isNumber(value.sizeBytes))
    && typeof value.hasAudio === 'boolean'
    && typeof value.hasVideo === 'boolean';
}

function isPlannedChunk(value: unknown): value is PlannedChunk {
  return isRecord(value)
    && isNumber(value.index)
    && isNumber(value.startMs)
    && isNumber(value.endMs);
}

function isChunkTranscript(value: unknown): value is ChunkTranscript {
  return isRecord(value)
    && isNumber(value.index)
    && isNumber(value.startMs)
    && isNumber(value.endMs)
    && isString(value.text)
    && (value.detectedLanguage === null || isString(value.detectedLanguage))
    && Array.isArray(value.segments)
    && value.segments.every(isMediaSegment);
}

function isChunkUnderstanding(value: unknown): value is ChunkUnderstanding {
  return isRecord(value)
    && isNumber(value.index)
    && isNumber(value.startMs)
    && isNumber(value.endMs)
    && isString(value.responseText)
    && (value.timeRanges === undefined
      || (Array.isArray(value.timeRanges) && value.timeRanges.every(isTimeRange)));
}

function isOperationResult(value: unknown): value is OperationResult {
  return isRecord(value)
    && (value.kind === 'transcription' || value.kind === 'understanding');
}

export function isTranscriptionStore(
  store: StepStore,
): store is StepStore & { kind: 'transcription'; request: TranscriptionRequest } {
  return store.kind === 'transcription';
}

export function isUnderstandingStore(
  store: StepStore,
): store is StepStore & { kind: 'understanding'; request: UnderstandingRequest } {
  return store.kind === 'understanding';
}

export function isTranscriptionRequest(request: AnyRequest): request is TranscriptionRequest {
  return !('prompt' in request);
}

export function isUnderstandingRequest(request: AnyRequest): request is UnderstandingRequest {
  return 'prompt' in request;
}

export function requireTranscriptionRequest(request: AnyRequest): TranscriptionRequest {
  if (!isTranscriptionRequest(request)) {
    throw new Error('Transcription operations require a transcription request');
  }
  return request;
}

export function requireUnderstandingRequest(request: AnyRequest): UnderstandingRequest {
  if (!isUnderstandingRequest(request)) {
    throw new Error('Understanding operations require an understanding request');
  }
  return request;
}

export function serializeError(error: unknown): OperationError {
  if (error instanceof Error) {
    return {
      code: 'operation_failed',
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: 'operation_failed',
    message: 'Unknown operation failure',
    retryable: true,
    details: error,
  };
}

export function buildSteps(kind: OperationKind, request: AnyRequest): OperationStepName[] {
  const steps: OperationStepName[] = [
    'resolve_source',
    'inspect_media',
    'materialize_media',
    'plan_chunks',
    'run_chunks',
    'merge_chunks',
  ];
  if (kind === 'transcription' && requireTranscriptionRequest(request).targetLanguage) {
    steps.push('translate_transcript');
  }
  steps.push('finalize_result', 'cleanup');
  return steps;
}

export function restoreStepOutput(context: PipelineContext, step: PersistedOperationStepLike): void {
  if (!step.output) {
    return;
  }
  const output = step.output;
  switch (step.name) {
    case 'resolve_source':
      if ('resolvedSource' in output && isResolvedSource(output.resolvedSource)) {
        context.resolvedSource = output.resolvedSource;
      }
      break;
    case 'inspect_media':
      if ('inspection' in output && isMediaInspection(output.inspection)) {
        context.inspection = output.inspection;
      }
      break;
    case 'materialize_media':
      if ('materialized' in output && isMaterializedSource(output.materialized)) {
        context.materialized = output.materialized;
      }
      break;
    case 'plan_chunks':
      if ('inspection' in output && isMediaInspection(output.inspection)) {
        context.inspection = output.inspection;
      }
      if ('plannedChunks' in output && Array.isArray(output.plannedChunks) && output.plannedChunks.every(isPlannedChunk)) {
        context.plannedChunks = output.plannedChunks;
      }
      break;
    case 'run_chunks':
      if ('chunkTranscripts' in output && Array.isArray(output.chunkTranscripts) && output.chunkTranscripts.every(isChunkTranscript)) {
        context.chunkTranscripts = output.chunkTranscripts;
      }
      if ('chunkUnderstanding' in output && Array.isArray(output.chunkUnderstanding) && output.chunkUnderstanding.every(isChunkUnderstanding)) {
        context.chunkUnderstanding = output.chunkUnderstanding;
      }
      break;
    case 'merge_chunks':
    case 'finalize_result':
      if ('result' in output && isOperationResult(output.result)) {
        context.mergedResult = output.result;
      }
      break;
    case 'translate_transcript':
      if ('translatedTranscript' in output && (output.translatedTranscript === null || isString(output.translatedTranscript))) {
        context.translatedTranscript = output.translatedTranscript ?? undefined;
      }
      break;
    case 'cleanup':
      break;
  }
}

export function mergeSegments(chunks: NonNullable<PipelineContext['chunkTranscripts']>): MediaSegment[] {
  const segments = chunks
    .flatMap((chunk) =>
      chunk.segments.map((segment) => ({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      })),
    )
    .sort((left, right) => left.startMs - right.startMs);
  const merged: MediaSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.startMs < previous.endMs && segment.text === previous.text) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

export function mergeTimeRanges(chunks: NonNullable<PipelineContext['chunkUnderstanding']>): TimeRange[] {
  return chunks
    .flatMap((chunk) =>
      (chunk.timeRanges ?? []).map((range) => ({
        startMs: range.startMs + chunk.startMs,
        endMs: range.endMs + chunk.startMs,
        label: range.label,
      })),
    )
    .sort((left, right) => left.startMs - right.startMs);
}

export function getOperationRequest(request: OperationRequest): AnyRequest {
  return request.request;
}

export function createOperationInput(
  kind: 'transcription',
  request: TranscriptionRequest,
): Extract<OperationRequest, { kind: 'transcription' }>;
export function createOperationInput(
  kind: 'understanding',
  request: UnderstandingRequest,
): Extract<OperationRequest, { kind: 'understanding' }>;
export function createOperationInput(
  kind: OperationKind,
  request: AnyRequest,
): OperationRequest;
export function createOperationInput(kind: OperationKind, request: AnyRequest): OperationRequest {
  if (kind === 'transcription') {
    return { kind, request: requireTranscriptionRequest(request) };
  }
  return { kind, request: requireUnderstandingRequest(request) };
}

export function toStepMap(
  steps: PersistedOperationStep[] | PersistedOperationStepLike[],
): Map<OperationStepName, PersistedOperationStepLike> {
  return new Map(steps.map((step) => [step.name, step]));
}

export function operationWorkingDirectory(operation: PersistedOperation): string {
  return operation.workingDirectory ?? '';
}
