import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { JwtPayload } from "../types";

/**
 * Param decorator: pull the authenticated user (or a single field) off the request.
 * Usage: `@CurrentUser('sub') userId: string` or `@CurrentUser() user: JwtPayload`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = req.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
