import { Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "@vibeos/auth";
import { DecisionsService } from "./decisions.service";
import { ListDecisionsDto } from "./dto/list-decisions.dto";
import { UpdateDecisionDto } from "./dto/update-decision.dto";

/**
 * Decisions controller — surfaces the brain's decision queue to app.rokibrain.com.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard).
 * Every method is authenticated by default; flip individual routes with @Public()
 * if you ever want a public read.
 */
@Controller("decisions")
@UseGuards(JwtAuthGuard)
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get()
  list(@CurrentUser("sub") userId: string, @Query() filter: ListDecisionsDto) {
    return this.decisions.list(userId, filter);
  }

  // Note: must be declared before @Get(":id") so Nest matches `/stats` literally
  // instead of treating "stats" as an :id param.
  @Get("stats")
  stats(@CurrentUser("sub") userId: string) {
    return this.decisions.stats(userId);
  }

  @Get(":id")
  get(@CurrentUser("sub") userId: string, @Param("id") id: string) {
    return this.decisions.get(userId, id);
  }

  @Patch(":id")
  update(
    @CurrentUser("sub") userId: string,
    @Param("id") id: string,
    @Body() dto: UpdateDecisionDto,
  ) {
    return this.decisions.update(userId, id, dto);
  }
}
