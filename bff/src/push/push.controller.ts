import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { IsString, Length } from "class-validator";
import { PushDispatcherService } from "./push-dispatcher.service";

class RegisterApnsBody {
  @IsString()
  @Length(8, 256)
  token!: string;

  @IsString()
  @Length(1, 128)
  deviceId!: string;
}

/**
 * PushController — APNs device-token registration / deregistration.
 *
 * All routes are behind JwtAuthGuard. tenantId is read from the JWT payload
 * so the client can never self-assign to another tenant.
 *
 * Routes:
 *   POST   /push/register-apns    — store token
 *   DELETE /push/unregister-apns/:deviceId — remove token
 *   GET    /push/devices          — list devices (sanitised: last 8 chars of token)
 */
@Controller("push")
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly push: PushDispatcherService) {}

  @Post("register-apns")
  @HttpCode(200)
  register(
    @CurrentUser() user: JwtPayload,
    @Body() body: RegisterApnsBody,
  ): { ok: boolean } {
    this.push.register(user.tenantId, body.deviceId, body.token);
    return { ok: true };
  }

  @Delete("unregister-apns/:deviceId")
  @HttpCode(200)
  unregister(
    @CurrentUser() user: JwtPayload,
    @Param("deviceId") deviceId: string,
  ): { ok: boolean } {
    this.push.unregister(user.tenantId, deviceId);
    return { ok: true };
  }

  @Get("devices")
  listDevices(@CurrentUser() user: JwtPayload) {
    return this.push.listDevices(user.tenantId);
  }
}
