import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

/**
 * Short-lived JWT access tokens (HS256). The token only proves "this session existed and was
 * issued by us"; whether the session is still live is checked against the database on every
 * request (see plugin.ts), which is what makes logout/revocation immediate.
 */
export class AccessTokenService {
  private readonly keys: Uint8Array[];
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly config: Config,
    private readonly clock: Clock,
  ) {
    const secrets = [
      config.JWT_SECRET,
      ...(config.JWT_SECRET_PREVIOUS ? [config.JWT_SECRET_PREVIOUS] : []),
    ];
    this.keys = secrets.map((s) => this.encoder.encode(s));
  }

  async sign(userId: string, sessionId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.clock.now();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + this.config.ACCESS_TOKEN_TTL_SECONDS;
    const signingKey = this.keys[0];
    if (!signingKey) throw new Error('No JWT signing key configured');
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.config.JWT_ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(signingKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verify(token: string): Promise<AccessClaims> {
    let lastError: unknown;
    for (const key of this.keys) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: this.config.JWT_ISSUER,
          currentDate: this.clock.now(),
        });
        const sid = payload['sid'];
        if (typeof payload.sub !== 'string' || typeof sid !== 'string')
          throw new AppError('TOKEN_INVALID');
        return { userId: payload.sub, sessionId: sid };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof joseErrors.JWTExpired) throw new AppError('TOKEN_EXPIRED');
        lastError = err; // wrong key / malformed: try the previous secret, if any
      }
    }
    throw new AppError('TOKEN_INVALID', { cause: lastError });
  }
}
