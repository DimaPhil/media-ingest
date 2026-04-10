import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import postgres from 'postgres';

import type { OperationRequest } from './contracts';
import type {
  OperationError,
  OperationKind,
  OperationResult,
  OperationStatus,
  OperationStepName,
  ProviderId,
  SourceKind,
  StepStatus,
} from './types';

export const operationsTable = pgTable(
  'operations',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').$type<OperationKind>().notNull(),
    status: text('status').$type<OperationStatus>().notNull(),
    provider: text('provider').$type<ProviderId>().notNull(),
    model: text('model'),
    sourceType: text('source_type').$type<SourceKind>().notNull(),
    sourceLocator: jsonb('source_locator').$type<Record<string, unknown>>().notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<OperationResult | null>(),
    error: jsonb('error').$type<OperationError | null>(),
    cacheEnabled: boolean('cache_enabled').notNull().default(true),
    cacheHit: boolean('cache_hit').notNull().default(false),
    retryable: boolean('retryable').notNull().default(true),
    currentStep: text('current_step').$type<OperationStepName | null>(),
    workingDirectory: text('working_directory'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  },
  (table) => ({
    dedupeIdx: index('operations_dedupe_key_idx').on(table.dedupeKey),
  }),
);

export const operationStepsTable = pgTable(
  'operation_steps',
  {
    id: text('id').primaryKey(),
    operationId: text('operation_id')
      .notNull()
      .references(() => operationsTable.id, { onDelete: 'cascade' }),
    name: text('name').$type<OperationStepName>().notNull(),
    stepOrder: integer('step_order').notNull(),
    status: text('status').$type<StepStatus>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    error: jsonb('error').$type<OperationError | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    opNameUniq: uniqueIndex('operation_steps_operation_name_uidx').on(
      table.operationId,
      table.name,
    ),
  }),
);

export interface DatabaseHandle {
  client: postgres.Sql<Record<string, unknown>>;
  db: PostgresJsDatabase;
}

export interface PersistedOperation {
  id: string;
  dedupeKey: string;
  kind: OperationKind;
  status: OperationStatus;
  provider: ProviderId;
  model: string | null;
  sourceType: SourceKind;
  sourceLocator: Record<string, unknown>;
  input: OperationRequest;
  result: OperationResult | null;
  error: OperationError | null;
  cacheEnabled: boolean;
  cacheHit: boolean;
  retryable: boolean;
  currentStep: OperationStepName | null;
  workingDirectory: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  lastHeartbeatAt: Date | null;
}

export interface PersistedOperationStep {
  id: string;
  operationId: string;
  name: OperationStepName;
  stepOrder: number;
  status: StepStatus;
  attemptCount: number;
  output: Record<string, unknown> | null;
  error: OperationError | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateOperationInput {
  dedupeKey: string;
  kind: OperationKind;
  provider: ProviderId;
  model: string | null;
  sourceType: SourceKind;
  sourceLocator: Record<string, unknown>;
  input: OperationRequest;
  cacheEnabled: boolean;
  workingDirectory: string | null;
}

export interface UpdateOperationInput {
  status?: OperationStatus;
  currentStep?: OperationStepName | null;
  result?: OperationResult | null;
  error?: OperationError | null;
  retryable?: boolean;
  cacheHit?: boolean;
  workingDirectory?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  expiresAt?: Date | null;
  lastHeartbeatAt?: Date | null;
}

export interface ListOperationsInput {
  limit?: number;
  status?: OperationStatus;
  kind?: OperationKind;
  provider?: ProviderId;
  sourceType?: SourceKind;
}

export interface OperationCounts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
}

interface AppliedMigrationRow {
  name: string;
}

function resolveMigrationsDirectory(): string {
  return resolve(__dirname, '../drizzle');
}

export async function runDatabaseMigrations(database: DatabaseHandle): Promise<void> {
  const migrationDirectory = resolveMigrationsDirectory();
  const files = (await readdir(migrationDirectory))
    .filter((entry) => entry.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    return;
  }

  await database.client`SELECT pg_advisory_lock(hashtext('media_ingest_schema_migrations'))`;
  try {
    const migrationTableExistsRows = await database.client<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists
    `;
    if (!migrationTableExistsRows[0]?.exists) {
      await database.client.unsafe(`
        CREATE TABLE schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
      `);
    }

    const appliedRows = await database.client<AppliedMigrationRow[]>`
      SELECT name FROM schema_migrations
    `;
    const applied = new Set(appliedRows.map((row) => row.name));

    for (const fileName of files) {
      if (applied.has(fileName)) {
        continue;
      }
      if (fileName === '0000_init.sql') {
        const bootstrapRows = await database.client<
          Array<{ operationsExists: boolean; operationStepsExists: boolean }>
        >`
          SELECT
            to_regclass('public.operations') IS NOT NULL AS "operationsExists",
            to_regclass('public.operation_steps') IS NOT NULL AS "operationStepsExists"
        `;
        if (bootstrapRows[0]?.operationsExists && bootstrapRows[0]?.operationStepsExists) {
          await database.client`
            INSERT INTO schema_migrations (name)
            VALUES (${fileName})
          `;
          continue;
        }
      }
      const sqlText = await readFile(join(migrationDirectory, fileName), 'utf8');
      await database.client.begin(async (transaction) => {
        await transaction.unsafe(sqlText);
        await transaction`
          INSERT INTO schema_migrations (name)
          VALUES (${fileName})
        `;
      });
    }
  } finally {
    await database.client`SELECT pg_advisory_unlock(hashtext('media_ingest_schema_migrations'))`;
  }
}

export function createDatabase(url: string): DatabaseHandle {
  if (!url.trim()) {
    throw new Error('database.url must be configured and should point to a remote Postgres-compatible database');
  }
  const client = postgres(url, {
    max: 1,
    prepare: false,
  });
  return {
    client,
    db: drizzle(client),
  };
}

export class OperationsRepository {
  public constructor(private readonly database: DatabaseHandle) {}

  public async initialize(): Promise<void> {
    await runDatabaseMigrations(this.database);
  }

  public async withAdvisoryLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const rows = await this.database.client<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`;
    if (!rows[0]?.locked) {
      throw new Error(`Could not acquire advisory lock for ${key}`);
    }
    try {
      return await callback();
    } finally {
      await this.database.client`SELECT pg_advisory_unlock(hashtext(${key}))`;
    }
  }

  public async createOperation(input: CreateOperationInput): Promise<PersistedOperation> {
    const now = new Date();
    const inserted = await this.database.db
      .insert(operationsTable)
      .values({
        id: randomUUID(),
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        status: 'queued',
        provider: input.provider,
        model: input.model,
        sourceType: input.sourceType,
        sourceLocator: input.sourceLocator,
        input: input.input,
        cacheEnabled: input.cacheEnabled,
        cacheHit: false,
        retryable: true,
        workingDirectory: input.workingDirectory,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return inserted[0] as PersistedOperation;
  }

  public async updateOperation(
    operationId: string,
    patch: UpdateOperationInput,
  ): Promise<PersistedOperation> {
    const updated = await this.database.db
      .update(operationsTable)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(operationsTable.id, operationId))
      .returning();
    if (!updated[0]) {
      throw new Error(`Operation not found: ${operationId}`);
    }
    return updated[0] as PersistedOperation;
  }

  public async findOperationById(operationId: string): Promise<PersistedOperation | null> {
    const rows = await this.database.db
      .select()
      .from(operationsTable)
      .where(eq(operationsTable.id, operationId))
      .limit(1);
    return (rows[0] as PersistedOperation | undefined) ?? null;
  }

  public async findLatestByDedupeKey(dedupeKey: string): Promise<PersistedOperation | null> {
    const rows = await this.database.db
      .select()
      .from(operationsTable)
      .where(eq(operationsTable.dedupeKey, dedupeKey))
      .orderBy(desc(operationsTable.createdAt))
      .limit(1);
    return (rows[0] as PersistedOperation | undefined) ?? null;
  }

  public async findRecoverableOperations(limit = 20): Promise<PersistedOperation[]> {
    const rows = await this.database.db
      .select()
      .from(operationsTable)
      .where(
        inArray(operationsTable.status, ['queued', 'running', 'failed']),
      )
      .orderBy(desc(operationsTable.updatedAt))
      .limit(limit);
    return rows as PersistedOperation[];
  }

  public async listOperations(filters: ListOperationsInput = {}): Promise<PersistedOperation[]> {
    const conditions = [
      filters.status ? eq(operationsTable.status, filters.status) : undefined,
      filters.kind ? eq(operationsTable.kind, filters.kind) : undefined,
      filters.provider ? eq(operationsTable.provider, filters.provider) : undefined,
      filters.sourceType ? eq(operationsTable.sourceType, filters.sourceType) : undefined,
    ].filter(Boolean);

    const query = this.database.db.select().from(operationsTable);
    const rows =
      conditions.length > 0
        ? await query
            .where(and(...conditions))
            .orderBy(desc(operationsTable.updatedAt))
            .limit(filters.limit ?? 50)
        : await query.orderBy(desc(operationsTable.updatedAt)).limit(filters.limit ?? 50);
    return rows as PersistedOperation[];
  }

  public async getOperationCounts(): Promise<OperationCounts> {
    const rows = await this.database.db
      .select({
        status: operationsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(operationsTable)
      .groupBy(operationsTable.status);

    const counts: OperationCounts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
      counts.total += row.count;
    }
    return counts;
  }

  public async listSteps(operationId: string): Promise<PersistedOperationStep[]> {
    const rows = await this.database.db
      .select()
      .from(operationStepsTable)
      .where(eq(operationStepsTable.operationId, operationId))
      .orderBy(operationStepsTable.stepOrder);
    return rows as PersistedOperationStep[];
  }

  public async saveStep(
    operationId: string,
    stepName: OperationStepName,
    stepOrder: number,
    patch: Partial<Omit<PersistedOperationStep, 'id' | 'operationId' | 'name' | 'stepOrder'>>,
  ): Promise<PersistedOperationStep> {
    const existing = await this.database.db
      .select()
      .from(operationStepsTable)
      .where(
        and(
          eq(operationStepsTable.operationId, operationId),
          eq(operationStepsTable.name, stepName),
        ),
      )
      .limit(1);

    const now = new Date();
    if (!existing[0]) {
      const inserted = await this.database.db
        .insert(operationStepsTable)
        .values({
          id: randomUUID(),
          operationId,
          name: stepName,
          stepOrder,
          status: patch.status ?? 'pending',
          attemptCount: patch.attemptCount ?? 0,
          output: patch.output ?? null,
          error: patch.error ?? null,
          startedAt: patch.startedAt ?? null,
          completedAt: patch.completedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted[0] as PersistedOperationStep;
    }

    const updated = await this.database.db
      .update(operationStepsTable)
      .set({
        status: patch.status ?? existing[0].status,
        attemptCount: patch.attemptCount ?? existing[0].attemptCount,
        output: patch.output ?? existing[0].output,
        error: patch.error ?? existing[0].error,
        startedAt: patch.startedAt ?? existing[0].startedAt,
        completedAt: patch.completedAt ?? existing[0].completedAt,
        updatedAt: now,
      })
      .where(eq(operationStepsTable.id, existing[0].id))
      .returning();
    return updated[0] as PersistedOperationStep;
  }

  public async resetFailedSteps(operationId: string): Promise<void> {
    await this.database.db
      .update(operationStepsTable)
      .set({
        status: 'pending',
        error: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(operationStepsTable.operationId, operationId),
          eq(operationStepsTable.status, 'failed'),
        ),
      );
  }

  public async deleteExpiredOperations(now: Date): Promise<PersistedOperation[]> {
    const rows = await this.database.db
      .select()
      .from(operationsTable)
      .where(and(isNotNull(operationsTable.expiresAt), lte(operationsTable.expiresAt, now)));
    if (rows.length === 0) {
      return [];
    }
    await this.database.db
      .delete(operationsTable)
      .where(
        inArray(
          operationsTable.id,
          rows.map((row) => row.id),
        ),
      );
    return rows as PersistedOperation[];
  }

  public async close(): Promise<void> {
    await this.database.client.end();
  }
}
