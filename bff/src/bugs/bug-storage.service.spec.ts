import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BugStorageService } from "./bug-storage.service";

describe("BugStorageService", () => {
  let root: string;
  let service: BugStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bug-storage-"));
    service = new BugStorageService(root);
  });

  it("writes screenshot to <root>/<bugId>/screenshot.<ext>", async () => {
    const result = await service.save("bug-abc", {
      fieldname: "screenshot",
      originalname: "weird name.PNG",
      mimetype: "image/png",
      buffer: Buffer.from("hello"),
      size: 5,
    });

    expect(result.url).toBe("/storage/bugs/bug-abc/screenshot.png");
    expect(result.size).toBe(5);

    const path = join(root, "bug-abc", "screenshot.png");
    const stats = await stat(path);
    expect(stats.size).toBe(5);
    expect((await readFile(path)).toString()).toBe("hello");
  });

  it("strips a missing extension safely", async () => {
    const result = await service.save("bug-2", {
      fieldname: "video",
      originalname: "noext",
      mimetype: "video/webm",
      buffer: Buffer.from("v"),
      size: 1,
    });

    expect(result.url).toBe("/storage/bugs/bug-2/video");
  });

  it("strips path-traversal characters out of the extension", async () => {
    const result = await service.save("bug-3", {
      fieldname: "screenshot",
      originalname: "shot.png/../../etc",
      mimetype: "image/png",
      buffer: Buffer.from("x"),
      size: 1,
    });

    // extname() returns "" here (basename has no `.` after the last `/`),
    // so we end up with no extension at all — never a traversal.
    expect(result.url).toBe("/storage/bugs/bug-3/screenshot");
  });

  it("drops extensions longer than 10 chars", async () => {
    const result = await service.save("bug-4", {
      fieldname: "screenshot",
      originalname: "shot.aReallyLongExtension",
      mimetype: "image/png",
      buffer: Buffer.from("x"),
      size: 1,
    });

    expect(result.url).toBe("/storage/bugs/bug-4/screenshot");
  });
});
