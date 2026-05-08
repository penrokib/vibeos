import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TerminalGateway } from "./terminal.gateway";
import { TerminalService } from "./terminal.service";

/**
 * TerminalModule — WS gateway for terminal-mirror traffic between the
 * rokibrain-bridge daemon (M3) and iOS / macOS apps.
 *
 * Standalone JwtModule registration (mirrors AuthModule) so the gateway
 * can verify handshake tokens without depending on AuthModule's request
 * scope. Same JWT_SECRET — tokens issued by /auth/login are accepted as-is.
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
  providers: [TerminalGateway, TerminalService],
  exports: [TerminalService],
})
export class TerminalModule {}
