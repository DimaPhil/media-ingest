import { z } from 'zod';

import {
  operationKinds,
  operationStatuses,
  providerIds,
  remoteTranscriptionRequestSchema,
  remoteUnderstandingRequestSchema,
  sourceKinds,
} from '@media-ingest/core';

export const operationIdParamSchema = z.object({
  operationId: z.string().uuid(),
});

export const adminOperationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(operationStatuses).optional(),
  kind: z.enum(operationKinds).optional(),
  provider: z.enum(providerIds).optional(),
  sourceType: z.enum(sourceKinds).optional(),
});

export { remoteTranscriptionRequestSchema, remoteUnderstandingRequestSchema };

export type OperationIdParam = z.infer<typeof operationIdParamSchema>;
export type AdminOperationsQuery = z.infer<typeof adminOperationsQuerySchema>;
