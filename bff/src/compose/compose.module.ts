import { Module } from "@nestjs/common";
import { MeshModule } from "../mesh/mesh.module";
import { TenantModule } from "../tenant/tenant.module";
import { ComposeController } from "./compose.controller";
import { ComposeService } from "./compose.service";

/**
 * ComposeModule — Cycle 18 phone-side compose pipeline.
 *
 * Imports MeshModule so ComposeService can inject MeshGateway for WS routing
 * to the user's Mac daemon. TenantModule provides TenantContextService for
 * per-request tenant isolation.
 *
 * Hard wall: ComposeService NEVER calls CC directly. CC only runs on user's Mac.
 */
@Module({
  imports: [MeshModule, TenantModule],
  controllers: [ComposeController],
  providers: [ComposeService],
  exports: [ComposeService],
})
export class ComposeModule {}
