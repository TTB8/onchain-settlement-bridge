/**
 * @file OpenAPI pieces shared by every controller: the problem schema, the auth scheme names and
 * a decorator that documents the problem responses a route can give.
 */

import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

import { PROBLEMS, type ProblemCode } from './problem';

/** Security scheme name of the platform token. */
export const PLATFORM_AUTH = 'platform-token';
/** Security scheme name of the admin token. */
export const ADMIN_AUTH = 'admin-token';

/*
 * Schema classes describe the wire format for OpenAPI only; nothing constructs them. Their
 * properties are declared optional in TypeScript (no definite-assignment `!`); whether a field
 * is required on the wire is what the `@ApiProperty` decorator says.
 */

/** One field error, for the schema. */
export class FieldErrorDto {
  /** The field. */
  @ApiProperty({ example: 'amount' })
  field?: string;

  /** What is wrong. */
  @ApiProperty({ example: 'must be a decimal string of the smallest unit (6 decimals): ...' })
  message?: string;
}

/** The RFC 9457 problem body, for the schema. */
export class ProblemDto {
  /** Stable URN. */
  @ApiProperty({ example: 'urn:bridge:problem:insufficient-funds' })
  type?: string;

  /** Constant per code. */
  @ApiProperty({ example: 'Insufficient funds' })
  title?: string;

  /** HTTP status. */
  @ApiProperty({ example: 422 })
  status?: number;

  /** Fixed explanation. */
  @ApiProperty({ example: 'The available balance does not cover the amount.' })
  detail?: string;

  /** Stable code. */
  @ApiProperty({ enum: Object.keys(PROBLEMS), example: 'INSUFFICIENT_FUNDS' })
  code?: string;

  /** This request. */
  @ApiPropertyOptional({ example: 'urn:request:7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11' })
  instance?: string;

  /** Field errors (validation only). */
  @ApiPropertyOptional({ type: [FieldErrorDto] })
  errors?: FieldErrorDto[];
}

/**
 * Documents the problem responses of a route (each code's status and title).
 *
 * @param codes The codes the route can answer with.
 */
export function ApiProblems(...codes: ProblemCode[]) {
  const byStatus = new Map<number, string[]>();
  for (const code of codes) {
    const spec = PROBLEMS[code];
    byStatus.set(spec.status, [...(byStatus.get(spec.status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus.entries()].map(([status, list]) =>
      ApiResponse({
        status,
        description: `problem+json: ${list.join(', ')}`,
        type: ProblemDto,
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDto' } },
        },
      }),
    ),
  );
}
