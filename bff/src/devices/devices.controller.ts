import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "@vibeos/database";
import {
  CurrentUser,
  JwtAuthGuard,
  RolesGuard,
  type JwtPayload,
} from "@vibeos/auth";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

const DEVICE_KINDS = ["ios", "macos", "m3-bridge"] as const;
type DeviceKind = (typeof DEVICE_KINDS)[number];

class PairDeviceDto {
  @IsIn(DEVICE_KINDS)
  device_kind!: DeviceKind;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  public_key?: string;
}

/**
 * DevicesController — pairs a JWT-authenticated user with a physical device
 * and mints a device-scoped JWT (24h) the device uses for WS / REST traffic.
 *
 * Single-tenant in v1: ownership is the JWT email. The device-scoped token
 * carries a `device_id` claim so the WS gateway and REST endpoints can
 * audit per-device when we add multi-device features later.
 */
@Controller("devices")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Post("pair")
  async pair(
    @CurrentUser() user: JwtPayload,
    @Body() body: PairDeviceDto,
  ): Promise<{
    device_id: string;
    device_kind: DeviceKind;
    paired_at: string;
    token: string;
  }> {
    const ownerEmail = user.email.toLowerCase();
    const device = await this.prisma.device.create({
      data: {
        ownerEmail,
        deviceKind: body.device_kind,
        publicKey: body.public_key ?? null,
      },
    });

    const token = this.jwt.sign(
      {
        sub: ownerEmail,
        email: ownerEmail,
        role: user.role,
        device_id: device.id,
        device_kind: device.deviceKind,
      },
      { expiresIn: "24h" },
    );

    return {
      device_id: device.id,
      device_kind: device.deviceKind as DeviceKind,
      paired_at: device.pairedAt.toISOString(),
      token,
    };
  }

  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    const ownerEmail = user.email.toLowerCase();
    const rows = await this.prisma.device.findMany({
      where: { ownerEmail },
      orderBy: { pairedAt: "desc" },
      select: {
        id: true,
        deviceKind: true,
        publicKey: true,
        pairedAt: true,
        lastSeenAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      device_kind: r.deviceKind,
      public_key: r.publicKey,
      paired_at: r.pairedAt.toISOString(),
      last_seen_at: r.lastSeenAt?.toISOString() ?? null,
    }));
  }
}
