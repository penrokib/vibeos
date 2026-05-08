import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { DevicesController } from "./devices.controller";

/**
 * DevicesModule — pairs iOS / macOS / m3-bridge devices to Roki's account
 * and mints a 24h device-scoped JWT used for WS + device-only REST.
 *
 * JWT signing key matches AuthModule (env JWT_SECRET) so device tokens
 * pass the same JwtAuthGuard the rest of the BFF uses.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>("JWT_SECRET");
        if (!secret) throw new Error("JWT_SECRET must be set before BFF can boot");
        return { secret };
      },
    }),
  ],
  controllers: [DevicesController],
})
export class DevicesModule {}
