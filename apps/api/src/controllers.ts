import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';

import {
  RemoteOperationService,
  type AppConfig,
} from '@media-ingest/core';

import { renderAdminPage } from './admin-ui';
import {
  adminOperationsQuerySchema,
  operationIdParamSchema,
  remoteTranscriptionRequestSchema,
  remoteUnderstandingRequestSchema,
  type AdminOperationsQuery,
  type OperationIdParam,
} from './http-schemas';
import { APP_CONFIG } from './tokens';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller()
export class HealthController {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('/healthz')
  public healthz() {
    return {
      status: 'ok',
      env: this.config.app.env,
    };
  }

  @Get('/admin')
  public admin(
    @Res()
    response: {
      type(contentType: string): { send(body: string): unknown };
      send?(body: string): unknown;
    },
  ) {
    response.type('html').send(renderAdminPage());
  }
}

@Controller('/v1')
export class OperationsController {
  public constructor(
    @Inject(RemoteOperationService)
    private readonly operations: RemoteOperationService,
  ) {}

  @Post('/transcriptions')
  @HttpCode(202)
  public async createTranscription(
    @Body(new ZodValidationPipe(remoteTranscriptionRequestSchema))
    body: Parameters<RemoteOperationService['submitTranscription']>[0],
  ) {
    try {
      return await this.operations.submitTranscription(body);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('/understanding')
  @HttpCode(202)
  public async createUnderstanding(
    @Body(new ZodValidationPipe(remoteUnderstandingRequestSchema))
    body: Parameters<RemoteOperationService['submitUnderstanding']>[0],
  ) {
    try {
      return await this.operations.submitUnderstanding(body);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/operations/:operationId')
  public async getOperation(
    @Param(new ZodValidationPipe(operationIdParamSchema))
    params: OperationIdParam,
  ) {
    try {
      return await this.operations.getOperationStatus(params.operationId);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/admin/overview')
  public async getAdminOverview() {
    try {
      return await this.operations.getAdminOverview();
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Get('/admin/operations')
  public async listOperations(
    @Query(new ZodValidationPipe(adminOperationsQuerySchema))
    query: AdminOperationsQuery,
  ) {
    try {
      const items = await this.operations.listOperations(query);
      return {
        items,
        meta: {
          limit: query.limit,
          count: items.length,
        },
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      return error;
    }
    if (error instanceof Error && error.message.startsWith('Operation not found')) {
      return new NotFoundException(error.message);
    }
    if (error instanceof Error) {
      return new InternalServerErrorException(error.message);
    }
    return new InternalServerErrorException('Unknown request failure');
  }
}
