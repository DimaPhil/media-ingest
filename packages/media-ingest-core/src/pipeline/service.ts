import { join } from 'node:path';

import { AsyncLimiter } from '../async';
import type {
  RemoteTranscriptionRequest,
  RemoteUnderstandingRequest,
} from '../contracts';
import { transcriptionRequestSchema, understandingRequestSchema } from '../contracts';
import type { AppConfig } from '../config';
import { createFingerprint } from '../fingerprint';
import { ensureDirectory, safeRemove } from '../media';
import type {
  OperationsRepository,
  PersistedMediaResource,
  PersistedOperation,
  PersistedDurableResult,
} from '../db';
import type { ProviderRegistry } from '../providers';
import type { ResolvedSource, SourceRegistry } from '../sources';
import type {
  OperationError,
  OperationKind,
  OperationProgress,
  OperationResult,
  OperationStatus,
  OperationStepName,
  OperationTimings,
  ProviderId,
  SourceKind,
} from '../types';

import { PipelineRunner } from './runner';
import {
  buildSteps,
  createOperationInput,
  getOperationRequest,
  requireTranscriptionRequest,
  requireUnderstandingRequest,
  serializeError,
  type AnyRequest,
} from './shared';
import { InMemoryStepStore, RemoteStepStore } from './stores';

export interface SubmitOperationResponse {
  operationId: string;
  status: OperationStatus;
  cacheHit: boolean;
  pollAfterMs: number;
  dedupeKey: string;
}

export interface OperationStatusView {
  operation: {
    id: string;
    kind: OperationKind;
    status: OperationStatus;
    provider: ProviderId;
    model: string | null;
    sourceType: string;
  };
  currentStep: OperationStepName | null;
  progress: OperationProgress;
  timings: OperationTimings;
  cacheHit: boolean;
  retryable: boolean;
  result?: OperationResult;
  error?: OperationError | null;
}

export interface OperationListItemView {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  provider: ProviderId;
  model: string | null;
  sourceType: string;
  sourceUri: string;
  currentStep: OperationStepName | null;
  cacheHit: boolean;
  retryable: boolean;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AdminOverviewView {
  counts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    total: number;
  };
  activeOperations: number;
  latestFailures: OperationListItemView[];
  latestCompleted: OperationListItemView[];
}

export interface ListOperationsViewInput {
  limit?: number;
  status?: OperationStatus;
  kind?: OperationKind;
  provider?: ProviderId;
  sourceType?: SourceKind;
}

function mapOperationListItem(operation: PersistedOperation): OperationListItemView {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    provider: operation.provider,
    model: operation.model,
    sourceType: operation.sourceType,
    sourceUri: String(operation.sourceLocator.uri ?? ''),
    currentStep: operation.currentStep,
    cacheHit: operation.cacheHit,
    retryable: operation.retryable,
    errorMessage: operation.error?.message ?? null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString(),
  };
}

function buildResourceKey(resolvedSource: ResolvedSource): string {
  return createFingerprint({
    sourceKind: resolvedSource.kind,
    canonicalUri: resolvedSource.canonicalUri,
  });
}

function buildNormalizedCacheKey(kind: OperationKind, request: AnyRequest, resolvedSource: ResolvedSource): string {
  if (kind === 'transcription') {
    const transcriptionRequest = requireTranscriptionRequest(request);
    return createFingerprint({
      kind,
      sourceUri: resolvedSource.canonicalUri,
      provider: transcriptionRequest.provider,
      model: transcriptionRequest.model ?? null,
      inputLanguage: transcriptionRequest.inputLanguage ?? null,
      targetLanguage: transcriptionRequest.targetLanguage ?? null,
    });
  }

  const understandingRequest = requireUnderstandingRequest(request);

  return createFingerprint({
    kind,
    sourceUri: resolvedSource.canonicalUri,
    provider: understandingRequest.provider,
    model: understandingRequest.model ?? null,
    prompt: understandingRequest.prompt,
  });
}

function durableRequestInput(kind: OperationKind, request: AnyRequest): Record<string, unknown> {
  if (kind === 'transcription') {
    const transcriptionRequest = requireTranscriptionRequest(request);
    return {
      inputLanguage: transcriptionRequest.inputLanguage,
      targetLanguage: transcriptionRequest.targetLanguage,
    };
  }
  const understandingRequest = requireUnderstandingRequest(request);
  return {
    prompt: understandingRequest.prompt,
  };
}

function operationSourceLocator(
  request: AnyRequest,
  resolvedSource: ResolvedSource,
): Record<string, unknown> {
  return {
    uri: request.source.uri,
    canonicalUri: resolvedSource.canonicalUri,
  };
}

interface PreparedRequestContext {
  resolvedSource: ResolvedSource;
  mediaResource: PersistedMediaResource;
  cacheKey: string;
}

export class RemoteOperationService {
  private readonly runner: PipelineRunner;

  private readonly operationLimiter: AsyncLimiter;

  private readonly sourceResolverLimiter: AsyncLimiter;

  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly config: AppConfig,
    private readonly repository: OperationsRepository,
    private readonly sources: SourceRegistry,
    private readonly providers: ProviderRegistry,
  ) {
    this.runner = new PipelineRunner(config, sources, providers);
    this.operationLimiter = new AsyncLimiter(config.concurrency.operations);
    this.sourceResolverLimiter = new AsyncLimiter(config.concurrency.sourceResolvers);
  }

  public async initialize(): Promise<void> {
    await this.repository.initialize();
    await ensureDirectory(this.config.storage.workingDirectory);
  }

  public async submitTranscription(request: RemoteTranscriptionRequest): Promise<SubmitOperationResponse> {
    return this.submitOperation('transcription', request);
  }

  public async submitUnderstanding(request: RemoteUnderstandingRequest): Promise<SubmitOperationResponse> {
    return this.submitOperation('understanding', request);
  }

  public async getOperationStatus(operationId: string): Promise<OperationStatusView> {
    const operation = await this.repository.findOperationById(operationId);
    if (!operation) {
      throw new Error(`Operation not found: ${operationId}`);
    }
    const steps = await this.repository.listSteps(operationId);
    const request = getOperationRequest(operation.input);
    const totalSteps = buildSteps(operation.kind, request).length;
    const completedSteps = steps.filter((step) => step.status === 'completed').length;
    const effectiveTotalSteps = steps.length === 0 && operation.status === 'completed' ? 0 : totalSteps;
    const effectiveCompletedSteps =
      steps.length === 0 && operation.status === 'completed'
        ? effectiveTotalSteps
        : completedSteps;
    const progress = {
      completedSteps: effectiveCompletedSteps,
      totalSteps: effectiveTotalSteps,
      percentage:
        steps.length === 0 && operation.status === 'completed'
          ? 100
          : effectiveTotalSteps === 0
            ? 0
            : Math.round((effectiveCompletedSteps / effectiveTotalSteps) * 100),
      steps: steps.map((step) => ({
        name: step.name,
        status: step.status,
        startedAt: step.startedAt?.toISOString(),
        completedAt: step.completedAt?.toISOString(),
      })),
    } satisfies OperationProgress;
    return {
      operation: {
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
        provider: operation.provider,
        model: operation.model,
        sourceType: operation.sourceType,
      },
      currentStep: operation.currentStep,
      progress,
      timings: {
        createdAt: operation.createdAt.toISOString(),
        startedAt: operation.startedAt?.toISOString(),
        completedAt: operation.completedAt?.toISOString(),
        updatedAt: operation.updatedAt.toISOString(),
      },
      cacheHit: operation.cacheHit,
      retryable: operation.retryable,
      result: operation.result ?? undefined,
      error: operation.error,
    };
  }

  public async listOperations(input: ListOperationsViewInput = {}): Promise<OperationListItemView[]> {
    return (await this.repository.listOperations(input)).map(mapOperationListItem);
  }

  public async getAdminOverview(): Promise<AdminOverviewView> {
    const counts = await this.repository.getOperationCounts();
    const latestFailures = await this.repository.listOperations({
      status: 'failed',
      limit: 5,
    });
    const latestCompleted = await this.repository.listOperations({
      status: 'completed',
      limit: 5,
    });

    return {
      counts,
      activeOperations: counts.queued + counts.running,
      latestFailures: latestFailures.map(mapOperationListItem),
      latestCompleted: latestCompleted.map(mapOperationListItem),
    };
  }

  public async resumeRecoverableOperations(): Promise<void> {
    const operations = await this.repository.findRecoverableOperations();
    for (const operation of operations) {
      if (operation.status === 'queued' || operation.status === 'running') {
        this.queueOperation(operation.id);
      }
    }
  }

  public async cleanupExpiredOperations(): Promise<void> {
    const deleted = await this.repository.deleteExpiredOperations(new Date());
    for (const operation of deleted) {
      if (operation.workingDirectory) {
        await safeRemove(operation.workingDirectory);
      }
    }
  }

  private async submitOperation(
    kind: OperationKind,
    request: AnyRequest,
  ): Promise<SubmitOperationResponse> {
    const prepared = await this.prepareRequest(kind, request);
    const dedupeKey = prepared.cacheKey;
    const cacheEnabled = this.config.features.cacheEnabled && !request.force;

    if (cacheEnabled) {
      return this.repository.withAdvisoryLock(`dedupe:${dedupeKey}`, async () => {
        const existing = await this.repository.findLatestByDedupeKey(dedupeKey);
        if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
          if (existing.status === 'failed') {
            await this.repository.resetFailedSteps(existing.id);
            await this.repository.updateOperation(existing.id, {
              status: 'queued',
              error: null,
              retryable: true,
              cacheHit: true,
              completedAt: null,
            });
            this.queueOperation(existing.id);
          } else if (existing.status === 'queued' || existing.status === 'running') {
            this.queueOperation(existing.id);
          }
          return {
            operationId: existing.id,
            status: existing.status === 'failed' ? 'queued' : existing.status,
            cacheHit: true,
            pollAfterMs: this.config.app.pollAfterMs,
            dedupeKey,
          };
        }
        const durableResult = await this.repository.findReadyDurableResultByCacheKey(dedupeKey);
        if (durableResult) {
          return this.createCompletedCachedOperation(
            kind,
            request,
            prepared,
            durableResult,
          );
        }
        return this.createAndQueueOperation(kind, request, prepared, dedupeKey, cacheEnabled);
      });
    }

    return this.createAndQueueOperation(kind, request, prepared, dedupeKey, cacheEnabled);
  }

  private async createAndQueueOperation(
    kind: OperationKind,
    request: AnyRequest,
    prepared: PreparedRequestContext,
    dedupeKey: string,
    cacheEnabled: boolean,
  ): Promise<SubmitOperationResponse> {
    const input = createOperationInput(kind, request);

    const operation = await this.repository.createOperation({
      dedupeKey,
      kind,
      provider: request.provider,
      model: request.model ?? null,
      sourceType: request.source.kind,
      sourceLocator: operationSourceLocator(request, prepared.resolvedSource),
      input,
      mediaResourceId: prepared.mediaResource.id,
      resultCacheKey: dedupeKey,
      cacheEnabled,
      workingDirectory: null,
    });
    const workingDirectory = join(this.config.storage.workingDirectory, operation.id);
    await this.repository.updateOperation(operation.id, { workingDirectory });
    const now = new Date();
    await this.repository.saveStep(operation.id, 'resolve_source', 0, {
      status: 'completed',
      output: {
        resolvedSource: prepared.resolvedSource,
      },
      attemptCount: 1,
      startedAt: now,
      completedAt: now,
    });
    this.queueOperation(operation.id);
    return {
      operationId: operation.id,
      status: 'queued',
      cacheHit: false,
      pollAfterMs: this.config.app.pollAfterMs,
      dedupeKey,
    };
  }

  private async createCompletedCachedOperation(
    kind: OperationKind,
    request: AnyRequest,
    prepared: PreparedRequestContext,
    durableResult: PersistedDurableResult,
  ): Promise<SubmitOperationResponse> {
    const input = createOperationInput(kind, request);

    const now = new Date();
    const operation = await this.repository.createOperation({
      dedupeKey: prepared.cacheKey,
      kind,
      provider: request.provider,
      model: request.model ?? null,
      sourceType: request.source.kind,
      sourceLocator: operationSourceLocator(request, prepared.resolvedSource),
      input,
      mediaResourceId: prepared.mediaResource.id,
      resultCacheKey: prepared.cacheKey,
      durableResultId: durableResult.id,
      cacheEnabled: true,
      workingDirectory: null,
      status: 'completed',
      result: durableResult.result,
      error: null,
      cacheHit: true,
      retryable: false,
      currentStep: null,
      startedAt: now,
      completedAt: now,
      expiresAt: new Date(
        Date.now() + this.config.storage.completedRetentionHours * 60 * 60 * 1000,
      ),
      lastHeartbeatAt: now,
    });
    return {
      operationId: operation.id,
      status: 'completed',
      cacheHit: true,
      pollAfterMs: this.config.app.pollAfterMs,
      dedupeKey: prepared.cacheKey,
    };
  }

  private async prepareRequest(
    kind: OperationKind,
    request: AnyRequest,
  ): Promise<PreparedRequestContext> {
    const resolver = this.sources.resolverFor(request.source);
    const resolvedSource = await this.sourceResolverLimiter.run(() => resolver.resolve(request.source));
    const mediaResource = await this.repository.upsertMediaResource({
      resourceKey: buildResourceKey(resolvedSource),
      kind: resolvedSource.kind,
      canonicalUri: resolvedSource.canonicalUri,
      sourceLocator: operationSourceLocator(request, resolvedSource),
      displayName: resolvedSource.displayName,
      fileName: resolvedSource.fileName,
      mimeType: resolvedSource.mimeType,
      metadata: resolvedSource.metadata,
    });

    return {
      resolvedSource,
      mediaResource,
      cacheKey: buildNormalizedCacheKey(kind, request, resolvedSource),
    };
  }

  private queueOperation(operationId: string): void {
    if (this.inFlight.has(operationId)) {
      return;
    }
    const promise = (async () => {
      try {
        await this.operationLimiter.run(() => this.processOperation(operationId));
      } catch {
        // Errors are already persisted in operation state.
      } finally {
        this.inFlight.delete(operationId);
      }
    })();
    this.inFlight.set(operationId, promise);
  }

  private async processOperation(operationId: string): Promise<void> {
    await this.repository.withAdvisoryLock(`operation:${operationId}`, async () => {
      const operation = await this.repository.findOperationById(operationId);
      if (!operation) {
        return;
      }
      const workingDirectory = operation.workingDirectory ?? join(this.config.storage.workingDirectory, operation.id);
      await ensureDirectory(workingDirectory);
      if (!operation.workingDirectory) {
        await this.repository.updateOperation(operation.id, { workingDirectory });
      }
      const store = new RemoteStepStore(this.repository, {
        ...operation,
        workingDirectory,
      });
      const result = await this.runner.execute(store);
      if (operation.mediaResourceId && operation.resultCacheKey) {
        try {
          const durableResult = await this.repository.saveDurableResult({
            mediaResourceId: operation.mediaResourceId,
            kind: operation.kind,
            cacheKey: operation.resultCacheKey,
            provider: operation.provider,
            model: operation.model,
            requestInput: durableRequestInput(operation.kind, store.request),
            result,
            sourceOperationId: operation.id,
          });
          await this.repository.updateOperation(operation.id, {
            durableResultId: durableResult.id,
          });
        } catch (error) {
          const serializedError = serializeError(error);
          await this.repository.updateOperation(operation.id, {
            status: 'failed',
            error: serializedError,
            retryable: serializedError.retryable,
            completedAt: new Date(),
            expiresAt: new Date(
              Date.now() + this.config.storage.failedRetentionHours * 60 * 60 * 1000,
            ),
          });
          throw error;
        }
      }
    });
  }
}

export class LocalMediaProcessor {
  private readonly runner: PipelineRunner;

  public constructor(
    private readonly config: AppConfig,
    private readonly sources: SourceRegistry,
    private readonly providers: ProviderRegistry,
  ) {
    this.runner = new PipelineRunner(config, sources, providers);
  }

  public async transcribe(input: unknown): Promise<OperationResult> {
    const request = transcriptionRequestSchema.parse(input);
    if (request.source.kind !== 'local_file') {
      throw new Error('Local processor only accepts local_file sources');
    }
    const workingDirectory = join(
      this.config.storage.workingDirectory,
      `local-${Date.now().toString(36)}`,
    );
    await ensureDirectory(workingDirectory);
    return this.runner.execute(
      new InMemoryStepStore(
        `local-${Date.now().toString(36)}`,
        'transcription',
        request,
        workingDirectory,
      ),
    );
  }

  public async understand(input: unknown): Promise<OperationResult> {
    const request = understandingRequestSchema.parse(input);
    if (request.source.kind !== 'local_file') {
      throw new Error('Local processor only accepts local_file sources');
    }
    const workingDirectory = join(
      this.config.storage.workingDirectory,
      `local-${Date.now().toString(36)}`,
    );
    await ensureDirectory(workingDirectory);
    return this.runner.execute(
      new InMemoryStepStore(
        `local-${Date.now().toString(36)}`,
        'understanding',
        request,
        workingDirectory,
      ),
    );
  }
}
