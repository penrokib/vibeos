import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { InstallerController } from "./installer.controller";
import { MeshCentralController } from "./meshcentral.controller";
import { MeshCentralTokenService } from "./meshcentral-token.service";

/**
 * InstallerModule — exposes:
 *   GET  /install                                (rokibrain installer)
 *   GET  /install/meshcentral-server             (MeshCentral server bash)
 *   GET  /install/meshcentral-agent              (MeshCentral agent bash)
 *   POST /install/meshcentral-agent/token        (admin: mint one-time token)
 *   POST /install/meshcentral-agent/token/verify (script: burn token)
 *   GET  /install/meshcentral-agent/token/status (script: poll for register)
 *
 * AuditModule is imported so MeshCentralTokenService can record every
 * mint/verify/registered transition in the durable audit log.
 *
 * Token state itself is in-memory (10-min TTL + single-use means a BFF
 * restart drops at most a few minutes of pending tokens — recoverable
 * by re-running the mint endpoint). See meshcentral-token.service.ts
 * docstring for the full reasoning.
 */
@Module({
  imports: [AuditModule],
  controllers: [InstallerController, MeshCentralController],
  providers: [MeshCentralTokenService],
})
export class InstallerModule {}
