import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { VoiceService } from "./voice.service";
import { __resetPersonaCacheForTest } from "./voice-grammar.parser";
import type { VoiceUtteranceDto } from "./dto/voice-utterance.dto";

/**
 * VoiceService spec — exercises the new grammar parser end-to-end through
 * the service. We mock AuditService (DB-backed) but use real filesystem
 * for the JSONL ledgers so we can assert audit lines actually got written.
 */

type AuditMock = jest.Mocked<Pick<AuditService, "record">>;

interface SetupHandles {
  service: VoiceService;
  audit: AuditMock;
  paths: { pending: string; audit: string; personas: string };
  cleanup: () => void;
}

async function setup(): Promise<SetupHandles> {
  const root = mkdtempSync(join(tmpdir(), "voice-svc-spec-"));
  const personasDir = join(root, "personas");
  const stateDir = join(root, "state");
  mkdirSync(personasDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Seed a realistic-ish persona registry — names mirror the live
  // rokibrain personas/ slugs the spec references.
  for (const slug of [
    "dewx-unipile-specialist",
    "dewx-unipile-linkedin-specialist",
    "dewx-unipile-whatsapp-specialist",
    "mira-persona-specialist",
    "mira-escalation-specialist",
    "ceo",
    "cto",
    "fleet-ops-c-level",
    "wife-amalya-specialist",
  ]) {
    mkdirSync(join(personasDir, slug), { recursive: true });
  }
  // Underscore-prefixed dirs (e.g. _index, _template) must be skipped.
  mkdirSync(join(personasDir, "_template"), { recursive: true });

  const pendingPath = join(stateDir, "voice-pending.jsonl");
  const auditPath = join(stateDir, "voice-audit.jsonl");

  __resetPersonaCacheForTest();

  const config: { get: jest.Mock } = { get: jest.fn() };
  config.get.mockImplementation((key: string) => {
    if (key === "ROKIBRAIN_ROOT") return root;
    if (key === "VOICE_PENDING_PATH") return pendingPath;
    if (key === "VOICE_AUDIT_PATH") return auditPath;
    if (key === "PERSONAS_DIR") return personasDir;
    return undefined;
  });

  const audit: AuditMock = { record: jest.fn().mockResolvedValue(undefined) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceService,
      { provide: ConfigService, useValue: config },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();

  const service = moduleRef.get(VoiceService);

  return {
    service,
    audit,
    paths: { pending: pendingPath, audit: auditPath, personas: personasDir },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const baseDto = (utterance: string, overrides: Partial<VoiceUtteranceDto> = {}): VoiceUtteranceDto => ({
  utterance,
  source: "mac",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe("VoiceService.ingest — grammar parser", () => {
  let handles: SetupHandles;

  beforeEach(async () => {
    handles = await setup();
  });

  afterEach(() => {
    handles.cleanup();
    __resetPersonaCacheForTest();
  });

  it('parses "dispatch unipile fix the webhook" → intent=dispatch, persona=dewx-unipile-specialist, readback=short', async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch unipile fix the webhook"),
    );

    expect(result.parsed.verb).toBe("dispatch");
    expect(result.parsed.intent).toBe("dispatch");
    expect(result.parsed.object).toBe("unipile");
    expect(result.routed_to_persona).toBe("dewx-unipile-specialist");
    expect(result.readback_tier).toBe("short");
    expect(result.requires_confirmation).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('parses "read mira inbox" → intent=query, persona=mira-persona-specialist, readback=short', async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("read mira inbox"),
    );

    expect(result.parsed.verb).toBe("read");
    expect(result.parsed.intent).toBe("query");
    expect(result.parsed.object).toBe("mira");
    // The structural-segment penalty in scoreSlug() pushes
    // mira-persona-specialist (3 segments, all structural after object)
    // ahead of mira-escalation-specialist (4 segments incl. unmatched
    // "escalation"). Single winner → readback=short.
    expect(result.routed_to_persona).toBe("mira-persona-specialist");
    expect(result.readback_tier).toBe("short");
    expect(result.requires_confirmation).toBe(false);
  });

  it("escalates readback to full when persona match is genuinely ambiguous", async () => {
    // Force an ambiguous match by adding two equally-named slugs.
    mkdirSync(join(handles.paths.personas, "twin-fooalpha-specialist"), {
      recursive: true,
    });
    mkdirSync(join(handles.paths.personas, "twin-foobeta-specialist"), {
      recursive: true,
    });
    __resetPersonaCacheForTest();

    const result = await handles.service.ingest(
      "roki",
      baseDto("read twin"),
    );
    expect(result.parsed.object).toBe("twin");
    // Both twin-* slugs tie — pick one but flag readback=full.
    expect(result.routed_to_persona).toMatch(/^twin-/);
    expect(result.readback_tier).toBe("full");
  });

  it('parses "delete persona xyz" → intent=destructive, requires_confirmation=true, readback=full', async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("delete persona xyz"),
    );

    expect(result.parsed.verb).toBe("delete");
    expect(result.parsed.intent).toBe("destructive");
    expect(result.requires_confirmation).toBe(true);
    expect(result.readback_tier).toBe("full");
  });

  it('parses "send message to wife" → destructive (sends are destructive), requires_confirmation=true, readback=full', async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("send message to wife"),
    );

    expect(result.parsed.verb).toBe("send");
    expect(result.parsed.intent).toBe("destructive");
    expect(result.requires_confirmation).toBe(true);
    expect(result.readback_tier).toBe("full");
  });

  it('parses "qwerty asdfgh" → intent=unknown, readback=full, error set', async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("qwerty asdfgh"),
    );

    expect(result.parsed.intent).toBe("unknown");
    expect(result.parsed.verb).toBe("qwerty"); // raw, not whitelisted
    expect(result.readback_tier).toBe("full");
    expect(result.requires_confirmation).toBe(false);
    expect(result.error).toBe("verb not in whitelist");
  });

  it("rejects 15-word utterances with 422 (existing behavior preserved)", async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `word${i}`).join(" ");
    await expect(
      handles.service.ingest("roki", baseDto(fifteen)),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("rejects empty utterances (post-trim) with 422", async () => {
    await expect(
      handles.service.ingest("roki", baseDto("   ")),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("status verb → readback=ack (low-stakes light tier)", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("status fleet"),
    );
    expect(result.parsed.verb).toBe("status");
    expect(result.parsed.intent).toBe("query");
    expect(result.readback_tier).toBe("ack");
  });

  it("repeat verb → readback=ack", async () => {
    const result = await handles.service.ingest("roki", baseDto("repeat"));
    expect(result.parsed.verb).toBe("repeat");
    expect(result.readback_tier).toBe("ack");
  });

  it("classifies pop noise marker as confirm", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("ack", { noise_marker: "pop" }),
    );
    expect(result.noise_action).toBe("confirm");
  });

  it("classifies hiss noise marker as cancel", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("read inbox", { noise_marker: "hiss" }),
    );
    expect(result.noise_action).toBe("cancel");
  });

  it("classifies click noise marker as repeat", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("repeat", { noise_marker: "click" }),
    );
    expect(result.noise_action).toBe("repeat");
  });

  it("classifies shh noise marker as sleep", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("ack", { noise_marker: "shh" }),
    );
    expect(result.noise_action).toBe("sleep");
  });

  it("returns noise_action=none when no marker present", async () => {
    const result = await handles.service.ingest("roki", baseDto("status"));
    expect(result.noise_action).toBe("none");
  });

  it("strips punctuation when tokenizing", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch, unipile! fix the webhook?"),
    );
    expect(result.parsed.verb).toBe("dispatch");
    expect(result.parsed.object).toBe("unipile");
  });

  it("appends parsed line to voice-audit.jsonl on every utterance", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("status fleet"),
    );
    const auditRaw = readFileSync(handles.paths.audit, "utf8");
    const lines = auditRaw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.task_id).toBe(result.task_id);
    expect(entry.actor).toBe("roki");
    expect(entry.parsed.verb).toBe("status");
    expect(entry.readback_tier).toBe("ack");
    expect(entry.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("appends pending entry to voice-pending.jsonl", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch unipile webhook"),
    );
    const pendingRaw = readFileSync(handles.paths.pending, "utf8");
    const lines = pendingRaw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.task_id).toBe(result.task_id);
    expect(entry.status).toBe("pending");
    expect(entry.routed_to_persona).toBe("dewx-unipile-specialist");
    expect(entry.parsed.intent).toBe("dispatch");
  });

  it("calls AuditService.record with parsed metadata", async () => {
    await handles.service.ingest("roki", baseDto("delete persona xyz"));
    expect(handles.audit.record).toHaveBeenCalledTimes(1);
    const [actor, action, target, payload] = handles.audit.record.mock.calls[0];
    expect(actor).toBe("roki");
    expect(action).toBe("voice.utterance");
    expect(target).toEqual(expect.any(String)); // task_id uuid
    expect(payload).toEqual(
      expect.objectContaining({
        intent: "destructive",
        verb: "delete",
        readback_tier: "full",
        requires_confirmation: true,
        destructive: true,
      }),
    );
  });

  it("never auto-executes destructive verbs (requires_confirmation always true)", async () => {
    for (const verb of ["delete", "send", "deploy", "pay", "cancel"]) {
      const result = await handles.service.ingest(
        "roki",
        baseDto(`${verb} something`),
      );
      expect(result.requires_confirmation).toBe(true);
      expect(result.readback_tier).toBe("full");
    }
  });

  it("falls back to raw object string when no persona matches", async () => {
    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch unknownmodule"),
    );
    expect(result.parsed.object).toBe("unknownmodule");
    expect(result.routed_to_persona).toBeNull();
  });

  it("skips underscore-prefixed persona dirs (e.g. _template)", async () => {
    // Add a fake persona that starts with underscore — should NOT match.
    mkdirSync(join(handles.paths.personas, "_internal-stuff"), {
      recursive: true,
    });
    __resetPersonaCacheForTest();

    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch internal something"),
    );
    expect(result.routed_to_persona).toBeNull();
  });

  it("preserves order: pending row appears in listPending()", async () => {
    await handles.service.ingest("roki", baseDto("status fleet"));
    const pending = await handles.service.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].parsed.verb).toBe("status");
  });

  it("findEntry resolves task_id and confirm() flips status", async () => {
    const r = await handles.service.ingest(
      "roki",
      baseDto("dispatch unipile fix"),
    );
    const ok = await handles.service.confirm("roki", r.task_id);
    expect(ok.ok).toBe(true);
    // Both pending + confirmed lines should now be in the ledger.
    const lines = readFileSync(handles.paths.pending, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it("audit_tail() returns parsed JSONL rows from voice-audit ledger", async () => {
    await handles.service.ingest("roki", baseDto("status fleet"));
    await handles.service.ingest("roki", baseDto("repeat"));
    const tail = handles.service.audit_tail(10);
    expect(tail.length).toBe(2);
    expect((tail[0] as { parsed: { verb: string } }).parsed.verb).toBe("status");
    expect((tail[1] as { parsed: { verb: string } }).parsed.verb).toBe("repeat");
  });

  it("works gracefully when personas dir is missing (degrades to null routing)", async () => {
    rmSync(handles.paths.personas, { recursive: true, force: true });
    __resetPersonaCacheForTest();

    const result = await handles.service.ingest(
      "roki",
      baseDto("dispatch unipile fix"),
    );
    expect(result.parsed.verb).toBe("dispatch");
    expect(result.routed_to_persona).toBeNull();
  });

  it("seeds a non-default ROKIBRAIN_ROOT location and writes there", async () => {
    // Sanity: confirm we wrote into the temp root, not the live brain.
    await handles.service.ingest("roki", baseDto("status"));
    const auditRaw = readFileSync(handles.paths.audit, "utf8");
    expect(auditRaw.length).toBeGreaterThan(0);
    expect(handles.paths.audit).toContain("voice-svc-spec-");
  });

  it("treats unknown verb path as fail-closed: no audit ledger crash", async () => {
    // Even with bad input the parser must NOT throw.
    const result = await handles.service.ingest(
      "roki",
      baseDto("xyzzy foobar baz"),
    );
    expect(result.parsed.intent).toBe("unknown");
    expect(result.error).toBe("verb not in whitelist");
    // And a row was still written so we have an audit trail of the miss.
    const auditRaw = readFileSync(handles.paths.audit, "utf8");
    const line = JSON.parse(auditRaw.split("\n")[0]);
    expect(line.parse_error).toBe("verb not in whitelist");
  });
});

describe("VoiceService.ingest — also writes file ledger before AuditService", () => {
  it("file ledger is durable even if AuditService.record rejects", async () => {
    const handles = await setup();
    try {
      handles.audit.record.mockRejectedValueOnce(new Error("db down"));

      // With our service order: appendJsonl runs BEFORE audit.record.
      // record() in real use never throws (AuditService swallows), but our
      // mock can still resolve to test the contract is "ledger first".
      // When mock rejects, the service should propagate (since AuditService's
      // real impl swallows errors but the mock doesn't). That's the correct
      // failure mode: a DB outage shouldn't roll back the file ledger.
      let caught: Error | null = null;
      try {
        await handles.service.ingest("roki", baseDto("status fleet"));
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      // File ledgers should already contain the line.
      const auditRaw = readFileSync(handles.paths.audit, "utf8");
      expect(auditRaw.length).toBeGreaterThan(0);
      const pendingRaw = readFileSync(handles.paths.pending, "utf8");
      expect(pendingRaw.length).toBeGreaterThan(0);
    } finally {
      handles.cleanup();
    }
  });
});
