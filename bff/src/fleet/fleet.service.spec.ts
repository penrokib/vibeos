import { UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { TailscaleService } from "../enrollment/tailscale.service";
import { FleetService } from "./fleet.service";
import {
  buildHeartbeatHmacPayload,
  computeHeartbeatHmac,
} from "./hmac.util";

/**
 * Focuses on the new HMAC handshake added in 5d. The pre-existing
 * heartbeat path (rate-limit, payload mirror, machine-not-found) is
 * implicitly covered by the e2e tests; here we exercise the four
 * branches of `verifyHeartbeatSignature` x the env-gate.
 */
describe("FleetService — heartbeat HMAC", () => {
  let service: FleetService;
  let prismaMock: {
    fleetMachine: { findUnique: jest.Mock; update: jest.Mock };
    fleetHeartbeat: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let auditMock: { record: jest.Mock };

  const SECRET = "shared-secret";
  const machineId = "m1-abc";
  const machineRow = {
    id: "row-uuid",
    machineId,
    heartbeatSecret: SECRET,
    lastHeartbeatAt: null,
    hostAlias: null,
    publicIp: null,
    tailscaleIp: null,
  };

  function buildDto(extra: Partial<Record<string, unknown>> = {}) {
    return {
      machineId,
      hostname: "m1",
      personaCount: 0,
      tmuxSessionCount: 0,
      ramGb: 16,
      cpuLoad: 0.5,
      accountQuota: {},
      lastHeartbeatId: "",
      receivedAt: "2026-05-06T10:00:00Z",
      ...extra,
    };
  }

  function sign(dto: { machineId: string; lastHeartbeatId?: string; receivedAt?: string }) {
    return computeHeartbeatHmac(
      buildHeartbeatHmacPayload({
        machineId: dto.machineId,
        lastHeartbeatId: dto.lastHeartbeatId ?? "",
        receivedAt: dto.receivedAt ?? "",
      }),
      SECRET,
    );
  }

  beforeEach(async () => {
    delete process.env.FLEET_HMAC_REQUIRED;

    prismaMock = {
      fleetMachine: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      fleetHeartbeat: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    auditMock = { record: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FleetService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
        {
          provide: TailscaleService,
          useValue: { mintAuthKey: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(FleetService);

    // Mirror the prisma transaction shape: returns [heartbeat, machine]
    prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => {
      // The service builds prisma.* calls (objects) — but we mock those to
      // return promises directly. So just await all in sequence.
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    });

    prismaMock.fleetMachine.findUnique.mockResolvedValue(machineRow);
    prismaMock.fleetMachine.update.mockResolvedValue({
      ...machineRow,
      lastHeartbeatAt: new Date(),
    });
    prismaMock.fleetHeartbeat.create.mockResolvedValue({ id: "hb-1" });
  });

  it("accepts a valid signature (strict mode on)", async () => {
    process.env.FLEET_HMAC_REQUIRED = "true";
    const dto = buildDto();
    const sig = sign(dto);

    await expect(service.recordHeartbeat(dto, sig)).resolves.toBeDefined();
    // No hmacFailed audit
    expect(auditMock.record).not.toHaveBeenCalledWith(
      expect.anything(),
      "fleet.heartbeat.hmacFailed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("strict mode rejects a missing X-Heartbeat-Sig", async () => {
    process.env.FLEET_HMAC_REQUIRED = "true";
    const dto = buildDto();

    await expect(service.recordHeartbeat(dto, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auditMock.record).toHaveBeenCalledWith(
      `machine:${machineId}`,
      "fleet.heartbeat.hmacFailed",
      machineRow.id,
      expect.objectContaining({ reason: "missing_signature_header" }),
    );
  });

  it("strict mode rejects a wrong signature with code=hmac_mismatch", async () => {
    process.env.FLEET_HMAC_REQUIRED = "true";
    const dto = buildDto();
    const wrong = "0".repeat(64);

    let caught: UnauthorizedException | undefined;
    try {
      await service.recordHeartbeat(dto, wrong);
    } catch (err) {
      caught = err as UnauthorizedException;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    const resp = caught?.getResponse() as { code?: string; reason?: string };
    expect(resp.code).toBe("hmac_mismatch");
    expect(resp.reason).toBe("signature_mismatch");
  });

  it("strict mode rejects when payload fields are missing", async () => {
    process.env.FLEET_HMAC_REQUIRED = "true";
    const dto = buildDto({ lastHeartbeatId: undefined, receivedAt: undefined });
    const sig = "a".repeat(64);

    await expect(service.recordHeartbeat(dto, sig)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auditMock.record).toHaveBeenCalledWith(
      expect.anything(),
      "fleet.heartbeat.hmacFailed",
      expect.anything(),
      expect.objectContaining({ reason: "missing_payload_fields" }),
    );
  });

  it("rollout mode (FLEET_HMAC_REQUIRED unset) allows missing signature but audits", async () => {
    const dto = buildDto();

    await expect(service.recordHeartbeat(dto, undefined)).resolves.toBeDefined();
    // Audit should still record the failure for visibility
    expect(auditMock.record).toHaveBeenCalledWith(
      `machine:${machineId}`,
      "fleet.heartbeat.hmacFailed",
      machineRow.id,
      expect.objectContaining({ reason: "missing_signature_header" }),
    );
  });

  it("rollout mode allows a wrong signature but audits", async () => {
    const dto = buildDto();
    const wrong = "0".repeat(64);

    await expect(service.recordHeartbeat(dto, wrong)).resolves.toBeDefined();
    expect(auditMock.record).toHaveBeenCalledWith(
      expect.anything(),
      "fleet.heartbeat.hmacFailed",
      expect.anything(),
      expect.objectContaining({ reason: "signature_mismatch" }),
    );
  });

  it("rollout mode does not audit on a valid signature", async () => {
    const dto = buildDto();
    const sig = sign(dto);

    await service.recordHeartbeat(dto, sig);
    expect(auditMock.record).not.toHaveBeenCalled();
  });

  it("strict mode rejects when the machine row has no heartbeatSecret yet", async () => {
    process.env.FLEET_HMAC_REQUIRED = "true";
    prismaMock.fleetMachine.findUnique.mockResolvedValueOnce({
      ...machineRow,
      heartbeatSecret: null,
    });
    const dto = buildDto();
    const sig = "a".repeat(64);

    await expect(service.recordHeartbeat(dto, sig)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auditMock.record).toHaveBeenCalledWith(
      expect.anything(),
      "fleet.heartbeat.hmacFailed",
      expect.anything(),
      expect.objectContaining({ reason: "machine_missing_secret" }),
    );
  });

  it("401s when machineId is not enrolled (regression — preserved from pre-HMAC behavior)", async () => {
    prismaMock.fleetMachine.findUnique.mockResolvedValueOnce(null);
    const dto = buildDto();
    await expect(service.recordHeartbeat(dto, sign(dto))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
