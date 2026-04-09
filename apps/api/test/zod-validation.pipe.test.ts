import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe } from '../src/zod-validation.pipe';

describe('ZodValidationPipe', () => {
  it('returns parsed values when validation succeeds', () => {
    const pipe = new ZodValidationPipe(z.object({
      limit: z.coerce.number().int().min(1),
    }));

    expect(pipe.transform({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('maps zod-shaped validation errors to bad requests', () => {
    const pipe = new ZodValidationPipe(z.object({
      limit: z.coerce.number().int().min(1),
    }));

    expect(() => pipe.transform({ limit: '0' })).toThrow(BadRequestException);
  });

  it('rethrows non-zod errors unchanged', () => {
    const pipe = new ZodValidationPipe({
      parse() {
        throw new Error('boom');
      },
    } as z.ZodType<unknown>);

    expect(() => pipe.transform({})).toThrow('boom');
  });
});
