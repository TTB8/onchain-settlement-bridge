/**
 * @file Authentication and authorisation: two static bearer tokens and a deny-by-default guard.
 *
 * The model, deliberately small (a reference implementation, not an identity system):
 *
 * - `API_PLATFORM_TOKEN` is the credential of the PLATFORM: the trusted backend that owns the
 *   end-user relationship and calls this API on its users' behalf. It may act on any user; the
 *   platform is responsible for mapping its own logged-in user to a `userId`.
 * - `API_ADMIN_TOKEN` is the credential of an OPERATOR: compliance changes and reconciliation.
 * - The two scopes are disjoint. The admin token is NOT accepted on platform routes (403), and
 *   the platform token is not accepted on admin routes (403). Why not let admin do everything:
 *   an operator console that can also move users' money turns one leaked admin token into both
 *   a compliance and a funds compromise, and audit trails stop telling the two apart.
 * - 401 means "no valid credential at all" (missing, malformed, unknown token), with
 *   `WWW-Authenticate: Bearer`; 403 means "a valid credential, the wrong one for this route".
 * - Every CONTROLLER route must declare its access with `@Access(...)`; one without it is
 *   refused (deny by default), so a forgotten decorator can never publish a route. The Swagger
 *   pages are not controller routes and bypass this guard (hence off by default off local).
 *
 * Real deployments put an identity provider in front (OIDC / OAuth 2 client credentials for the
 * platform, SSO with MFA for operators), issue short-lived tokens with per-user subjects, and add
 * an object-ownership check on every `:userId` route. The static tokens here stand in for that.
 *
 * Comparison is constant time: both sides are hashed with SHA-256 (fixed 32-byte digests, so no
 * length leaks and `timingSafeEqual` never throws), then compared with `timingSafeEqual`. Both
 * tokens are always compared, so the time does not tell which one nearly matched.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiConfig } from '@bridge/engine/env';
import type { Request } from 'express';

import { ApiProblem } from '../core/problem';
import { API_CONFIG } from '../core/tokens';

/** Who may call a route. */
export type AccessScope = 'public' | 'platform' | 'admin';

/** Metadata key of `@Access`. */
export const ACCESS_KEY = 'bridge:access';

/**
 * Declares who may call a route (or every route of a controller).
 *
 * @param scope `public` (no credential), `platform` or `admin`.
 */
export const Access = (scope: AccessScope) => SetMetadata(ACCESS_KEY, scope);

/** Which credential a request presented. */
export type Credential = 'platform' | 'admin' | 'none';

/**
 * Constant-time equality of two strings: SHA-256 both, then `timingSafeEqual` on the digests.
 *
 * @param a One string.
 * @param b The other.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** The bearer token in an `Authorization` header, or null when absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Decides which credential a token is. Both comparisons always run. */
export class TokenMatcher {
  /**
   * @param platformToken The platform token.
   * @param adminToken The admin token.
   * @param equal The comparison (constant time; injectable only for tests).
   */
  constructor(
    private readonly platformToken: string,
    private readonly adminToken: string,
    private readonly equal: (a: string, b: string) => boolean = constantTimeEqual,
  ) {}

  /** Which credential `token` is. */
  match(token: string | null): Credential {
    if (token === null) return 'none';
    // Both run, no short-circuit: the time must not depend on which token was nearly right.
    const isPlatform = this.equal(token, this.platformToken);
    const isAdmin = this.equal(token, this.adminToken);
    if (isPlatform) return 'platform';
    if (isAdmin) return 'admin';
    return 'none';
  }
}

/**
 * The access decision, pure: allowed, or the problem to answer with.
 *
 * @param scope The route's declared scope (undefined: not declared).
 * @param credential What the request presented.
 */
export function decideAccess(
  scope: AccessScope | undefined,
  credential: Credential,
): 'allow' | 'UNAUTHENTICATED' | 'FORBIDDEN' {
  // Deny by default: a route that declares nothing is never reachable.
  if (scope === undefined) return 'FORBIDDEN';
  if (scope === 'public') return 'allow';
  if (credential === 'none') return 'UNAUTHENTICATED';
  return credential === scope ? 'allow' : 'FORBIDDEN';
}

/** The global guard (registered as `APP_GUARD`). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly matcher: TokenMatcher;

  /**
   * @param reflector Reads `@Access`.
   * @param config The two tokens.
   */
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.matcher = new TokenMatcher(config.platformToken.reveal(), config.adminToken.reveal());
  }

  /** @inheritdoc */
  canActivate(context: ExecutionContext): boolean {
    const scope = this.reflector.getAllAndOverride<AccessScope | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const credential =
      scope === 'public' ? 'none' : this.matcher.match(bearerToken(req.headers.authorization));
    const decision = decideAccess(scope, credential);
    if (decision !== 'allow') throw new ApiProblem(decision);
    return true;
  }
}
