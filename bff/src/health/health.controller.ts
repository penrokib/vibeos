import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, Public } from "@vibeos/auth";

/**
 * Health controller — Class-C: even health endpoints carry the guard,
 * but the readiness ping is explicitly @Public().
 */
@Controller("health")
@UseGuards(JwtAuthGuard)
export class HealthController {
  @Get()
  @Public()
  ping(): { status: "ok"; service: "bff"; ts: string } {
    return {
      status: "ok",
      service: "bff",
      ts: new Date().toISOString(),
    };
  }
}
