import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";

export const BUG_STORAGE_ROOT = "BUG_STORAGE_ROOT";

export interface UploadInput {
  fieldname: "screenshot" | "video";
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface StoredFile {
  url: string;
  size: number;
}

/**
 * Disk-backed attachment store for bug uploads.
 *
 * Files land at `<root>/<bugId>/<fieldname><ext>`. The returned `url` is the
 * public path relative to the storage mount (`/storage/bugs/<bugId>/...`)
 * — Phase 7 will swap this for S3 without changing the controller surface.
 */
@Injectable()
export class BugStorageService {
  private readonly root: string;

  constructor(@Inject(BUG_STORAGE_ROOT) root: string) {
    this.root = resolve(root);
  }

  async save(bugId: string, file: UploadInput): Promise<StoredFile> {
    const dir = join(this.root, bugId);
    await mkdir(dir, { recursive: true });
    const ext = sanitizeExt(extname(file.originalname || ""));
    const filename = `${file.fieldname}${ext}`;
    const path = join(dir, filename);
    await writeFile(path, file.buffer);
    return {
      url: `/storage/bugs/${bugId}/${filename}`,
      size: file.size,
    };
  }
}

function sanitizeExt(ext: string): string {
  if (!ext) return "";
  // Strip anything funky — only allow ascii alnum + dot.
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!cleaned.startsWith(".") || cleaned.length > 10) return "";
  return cleaned;
}
