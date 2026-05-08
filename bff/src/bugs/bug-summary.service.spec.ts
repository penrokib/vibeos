import { BugSummaryService, type SummarizeBugInput } from "./bug-summary.service";

describe("BugSummaryService", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  let originalFetch: typeof globalThis.fetch | undefined;
  let service: BugSummaryService;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    originalFetch = globalThis.fetch;
    service = new BugSummaryService();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
  });

  function makeInput(overrides: Partial<SummarizeBugInput> = {}): SummarizeBugInput {
    return {
      bug: {
        id: "bug-1",
        title: "Login button does nothing",
        description: "Clicking sign-in on /login is silent.",
        status: "OPEN",
        reportedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        ...overrides.bug,
      },
      comments: overrides.comments ?? [
        {
          id: "c1",
          author: "tester@example.com",
          body: "Reproduces in Chrome 130.",
          createdAt: new Date(Date.now() - 47 * 60 * 60 * 1000),
        },
        {
          id: "c2",
          author: "claude:tab-2",
          body: "Claimed.",
          createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        },
        {
          id: "c3",
          author: "claude:tab-2",
          body: "Found root cause: missing form action.",
          createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
        },
        {
          id: "c4",
          author: "claude:tab-2",
          body: "Fix attached.",
          createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
        },
      ],
    } as SummarizeBugInput;
  }

  function fakeAnthropicResponse(text: string, status = 200): Response {
    const body = JSON.stringify({
      content: [{ type: "text", text }],
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    } as unknown as Response;
  }

  it("returns null when ANTHROPIC_API_KEY is missing (graceful no-op)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const out = await service.getSummary(makeInput());
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for trivial bugs (≤3 comments AND <24h old)", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const trivial = makeInput({
      bug: {
        id: "bug-1",
        title: "small bug",
        description: "x",
        status: "OPEN",
        reportedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h old
      },
      comments: [
        {
          id: "c1",
          author: "tester@example.com",
          body: "x",
          createdAt: new Date(),
        },
      ],
    });

    const out = await service.getSummary(trivial);
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("summarizes when comment count exceeds the gate even if recent", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeAnthropicResponse("First sentence. Second sentence."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const out = await service.getSummary(
      makeInput({
        bug: {
          id: "bug-1",
          title: "x",
          description: "y",
          status: "OPEN",
          reportedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h old, not stale
        },
      }),
    );
    expect(out?.summary).toBe("First sentence. Second sentence.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls the Anthropic Messages API with x-api-key + claude-haiku-4-5", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeAnthropicResponse("S1. S2."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const out = await service.getSummary(makeInput());

    expect(out?.cached).toBe(false);
    expect(out?.summary).toBe("S1. S2.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(200);
    expect(body.system).toContain("two sentences");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("Login button does nothing");
  });

  it("returns the cached summary when (status, count, last id) is unchanged", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeAnthropicResponse("Cached."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const input = makeInput();
    const first = await service.getSummary(input);
    const second = await service.getSummary(input);

    expect(first?.cached).toBe(false);
    expect(second?.cached).toBe(true);
    expect(second?.summary).toBe("Cached.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when a new comment is appended (cache key changes)", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeAnthropicResponse("First."))
      .mockResolvedValueOnce(fakeAnthropicResponse("Refreshed."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const before = makeInput();
    const first = await service.getSummary(before);

    const after = makeInput({
      comments: [
        ...before.comments,
        {
          id: "c5",
          author: "tester@example.com",
          body: "Verified, looks good.",
          createdAt: new Date(),
        },
      ],
    });
    const second = await service.getSummary(after);

    expect(first?.summary).toBe("First.");
    expect(second?.summary).toBe("Refreshed.");
    expect(second?.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when status flips even with same comments", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeAnthropicResponse("Open phase."))
      .mockResolvedValueOnce(fakeAnthropicResponse("Fixed phase."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const open = makeInput();
    const fixed = makeInput({
      bug: { ...open.bug, status: "FIXED" },
    });

    await service.getSummary(open);
    const second = await service.getSummary(fixed);

    expect(second?.summary).toBe("Fixed phase.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on transport error and never caches the failure", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValueOnce(fakeAnthropicResponse("Recovered."));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const first = await service.getSummary(makeInput());
    expect(first).toBeNull();

    const second = await service.getSummary(makeInput());
    expect(second?.summary).toBe("Recovered.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on non-2xx response", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeAnthropicResponse("rate limited", 429));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const out = await service.getSummary(makeInput());
    expect(out).toBeNull();
  });

  it("returns null when Anthropic response has no text blocks", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve('{"content":[]}'),
      json: () => Promise.resolve({ content: [] }),
    } as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const out = await service.getSummary(makeInput());
    expect(out).toBeNull();
  });
});
