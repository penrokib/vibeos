import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { DispatchService } from "./dispatch.service";
import {
  DispatchRequestDto,
  EscalateRequestDto,
  LedgerQueryDto,
} from "./dto/dispatch-request.dto";

/**
 * DispatchController — HTTP wrapper around `~/Projects/rokibrain/bin/dispatch.sh`.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard).
 * Every method is authenticated; per-method @Roles() enforces that only
 * orchestrator-tier callers can fire downward dispatches.
 *
 * Note on roles: the auth package's UserRole union is currently
 * `'admin' | 'tester'` (see packages/auth/src/types.ts). Per spec,
 * orchestrators carry `admin` JWTs in v1; the persona-level chain-of-command
 * check (only c-level/senior-manager/lead may originate dispatch) lives in
 * DispatchService.assertCanDispatch and runs against the request's `from`
 * field. When the role union grows to include `ceo` / `cto`, add them here.
 */
@Controller("dispatch")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  // ─── /dispatch/ledger MUST be declared before /dispatch/:task_id ────
  // (otherwise Nest routes "ledger" through the param matcher).

  @Get("ledger")
  @Roles("admin")
  ledger(@CurrentUser() _user: JwtPayload, @Query() query: LedgerQueryDto) {
    return this.dispatch.listLedger(query);
  }

  @Post()
  @Roles("admin")
  async create(@CurrentUser() _user: JwtPayload, @Body() dto: DispatchRequestDto) {
    // _user is available for future audit-trail wiring; the chain-of-command
    // check happens inside the service against dto.from.
    return this.dispatch.dispatch(dto);
  }

  @Post("escalate")
  @Roles("admin")
  async escalate(@CurrentUser() _user: JwtPayload, @Body() dto: EscalateRequestDto) {
    return this.dispatch.escalate(dto);
  }

  @Get(":task_id")
  @Roles("admin")
  async track(
    @CurrentUser() _user: JwtPayload,
    @Param("task_id") taskId: string,
  ) {
    return this.dispatch.track(taskId);
  }
}
