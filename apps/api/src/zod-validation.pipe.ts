import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { ZodType, ZodIssue } from 'zod';

function isZodIssue(value: unknown): value is ZodIssue {
  return value !== null
    && typeof value === 'object'
    && 'code' in value
    && 'path' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractZodIssues(error: unknown): ZodIssue[] | null {
  if (!isRecord(error) || !('issues' in error)) {
    return null;
  }
  const { issues } = error;
  if (!Array.isArray(issues) || !issues.every(isZodIssue)) {
    return null;
  }
  return issues;
}

@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform {
  public constructor(private readonly schema: ZodType<TOutput>) {}

  public transform(value: unknown): TOutput {
    try {
      return this.schema.parse(value);
    } catch (error) {
      const issues = extractZodIssues(error);
      if (issues) {
        throw new BadRequestException({
          message: 'Validation failed',
          issues,
        });
      }
      throw error;
    }
  }
}
