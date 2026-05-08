import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AuditModule } from "../audit/audit.module";
import { MeshController } from "./mesh.controller";
import { MeshGateway } from "./mesh.gateway";
import { KeystrokeService } from "./keystroke.service";
import { MeshService } from "./mesh.service";

/**
 * MeshModule — REST + WS for the desktop app's mesh comms surface.
 * See state/rokibrain-app-v1-design-2026-05-07.md §2 + §16.
 *
 * Standalone JwtModule (mirrors TerminalModule) so the gateway verifies
 * handshake tokens without the request-scope baggage of AuthModule.
 */
@Module({
  imports: [
    AuditModule,
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
  controllers: [MeshController],
  providers: [MeshService, MeshGateway, KeystrokeService],
  exports: [MeshService, MeshGateway, KeystrokeService],
})
export class MeshModule {}
