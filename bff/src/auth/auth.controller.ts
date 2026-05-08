import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser, JwtAuthGuard, Public } from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";

const COOKIE_NAME = "access_token";

@Controller("auth")
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: JwtPayload }> {
    const payload = await this.auth.validate(dto.email, dto.password);
    const token = this.auth.signToken(payload);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: this.auth.cookieMaxAgeSeconds() * 1000,
    });
    return { user: payload };
  }

  @Post("logout")
  @Public()
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(COOKIE_NAME, { path: "/" });
  }

  @Get("me")
  me(@CurrentUser() user: JwtPayload): { user: JwtPayload } {
    return { user };
  }
}
