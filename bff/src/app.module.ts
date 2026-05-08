import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "@vibeos/database";
import { AgencyModule } from "./agency/agency.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { BugsModule } from "./bugs/bugs.module";
import { DecisionsModule } from "./decisions/decisions.module";
import { DevicesModule } from "./devices/devices.module";
import { DispatchModule } from "./dispatch/dispatch.module";
import { EnrollmentModule } from "./enrollment/enrollment.module";
import { FleetModule } from "./fleet/fleet.module";
import { HealthModule } from "./health/health.module";
import { InstallerModule } from "./installer/installer.module";
import { KnowledgeSearchModule } from "./knowledge-search/knowledge-search.module";
import { LettaProxyModule } from "./letta-proxy/letta-proxy.module";
import { MeshModule } from "./mesh/mesh.module";
import { TerminalModule } from "./terminal/terminal.module";
import { VoiceModule } from "./voice/voice.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env", "../../.env"],
    }),
    PrismaModule.forRoot(),
    AuthModule,
    HealthModule,
    AuditModule,
    DecisionsModule,
    BugsModule,
    InstallerModule,
    AgencyModule,
    DispatchModule,
    EnrollmentModule,
    FleetModule,
    KnowledgeSearchModule,
    LettaProxyModule,
    DevicesModule,
    MeshModule,
    TerminalModule,
    VoiceModule,
  ],
})
export class AppModule {}
