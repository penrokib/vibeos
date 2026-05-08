import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it("returns the documented readiness shape", () => {
    const response = controller.ping();
    expect(response.status).toBe("ok");
    expect(response.service).toBe("bff");
    // ts is an ISO string — Date(...).getTime() should round-trip.
    expect(Number.isFinite(new Date(response.ts).getTime())).toBe(true);
  });
});
