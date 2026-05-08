import { ExecutionContext, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

/**
 * JwtAuthGuard — channels Dewx packages/auth/src/guards/jwt-auth.guard.ts.
 *
 * Class-C rule: every controller MUST apply this guard at class-level.
 * Use the `@Public()` decorator to opt individual routes out.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(@Optional() private readonly reflector?: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) return true;
    }

    try {
      const result = await super.canActivate(context);
      return result as boolean;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        error instanceof Error ? error.message : "Authentication failed",
      );
    }
  }

  override handleRequest<TUser>(err: Error | null, user: TUser, info: Error | null): TUser {
    if (err || !user) {
      if (info?.name === "TokenExpiredError") {
        throw new UnauthorizedException("Token has expired");
      }
      if (info?.name === "JsonWebTokenError") {
        throw new UnauthorizedException(`JWT Error: ${info.message}`);
      }
      if (info?.message) throw new UnauthorizedException(info.message);
      throw new UnauthorizedException(err?.message || "Invalid authentication token");
    }
    return user;
  }
}
