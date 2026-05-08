import { Module } from "@nestjs/common";
import { TenantModule } from "../tenant/tenant.module";
import { PushController } from "./push.controller";
import { PushDispatcherService } from "./push-dispatcher.service";

/**
 * PushModule — APNs device-token registry + content-free push dispatcher.
 *
 * Exports PushDispatcherService so MeshModule, DraftsModule (future), and
 * other feature modules can inject it and call dispatch() without importing
 * PushModule internals.
 *
 * TenantModule is imported so TenantContextService is available if needed by
 * future sub-services; the controller reads tenantId from @CurrentUser() JWT
 * directly in v1.
 */
@Module({
  imports: [TenantModule],
  controllers: [PushController],
  providers: [PushDispatcherService],
  exports: [PushDispatcherService],
})
export class PushModule {}
