import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import { BugsService } from "./bugs.service";
import type { UploadInput } from "./bug-storage.service";
import { CreateBugDto } from "./dto/create-bug.dto";
import { CreateCommentDto } from "./dto/create-comment.dto";
import { ListBugsDto } from "./dto/list-bugs.dto";
import { RegisterAppDto } from "./dto/register-app.dto";
import { RegisterFeatureDto } from "./dto/register-feature.dto";
import { UpdateBugDto } from "./dto/update-bug.dto";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per attachment
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB total per bug

interface MulterFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Bugs controller — write surface for the bugs system at app.rokibrain.com/bugs.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard).
 * Auth is required for everything; per-method @Roles() locks down admin-only
 * surfaces (status mutations, app/feature registration). Testers may file
 * bugs, view their own, and comment on their own.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BugsController {
  constructor(private readonly bugs: BugsService) {}

  // ─── Bug CRUD ─────────────────────────────────────────────────────────

  @Post("bugs")
  @Roles("admin", "tester")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "screenshot", maxCount: 1 },
        { name: "video", maxCount: 1 },
      ],
      { limits: { fileSize: MAX_FILE_BYTES, files: 2 } },
    ),
  )
  async createBug(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateBugDto,
    @UploadedFiles()
    files: { screenshot?: MulterFile[]; video?: MulterFile[] } = {},
  ) {
    const screenshot = pickFile(files.screenshot);
    const video = pickFile(files.video);
    const totalBytes = (screenshot?.size ?? 0) + (video?.size ?? 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BadRequestException(`attachments exceed 50MB limit (got ${totalBytes} bytes)`);
    }

    // Testers cannot file on behalf of someone else; admins can override.
    const reporter = user.role === "admin" ? dto.reporter?.trim() || user.email : user.email;

    return this.bugs.create(user.email, {
      dto,
      reporter,
      reporterName: dto.reporterName,
      screenshot: screenshot ? toUploadInput(screenshot, "screenshot") : undefined,
      video: video ? toUploadInput(video, "video") : undefined,
    });
  }

  @Get("bugs")
  @Roles("admin", "tester")
  listBugs(@CurrentUser() user: JwtPayload, @Query() filter: ListBugsDto) {
    return this.bugs.list(user, filter);
  }

  @Get("bugs/:id")
  @Roles("admin", "tester")
  getBug(@CurrentUser() user: JwtPayload, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.bugs.get(user, id);
  }

  /**
   * Iter-12 AI summary endpoint. Returns `{ summary, generatedAt, cached }`
   * or `null` when summarization is skipped (cost gate, missing API
   * key, transport error). Web side renders nothing on null.
   */
  @Get("bugs/:id/summary")
  @Roles("admin", "tester")
  getBugSummary(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.bugs.getSummary(user, id);
  }

  @Patch("bugs/:id")
  @Roles("admin")
  updateBug(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBugDto,
  ) {
    return this.bugs.update(user.email, id, dto);
  }

  /**
   * Iter-10 reporter-or-admin verify endpoint. Narrower than the
   * admin-only PATCH so a tester can close their own bug-fix loop
   * without an admin needing to flip the status for them.
   */
  @Post("bugs/:id/verify")
  @Roles("admin", "tester")
  verifyFix(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.bugs.verifyFix(user, id);
  }

  @Post("bugs/:id/comments")
  @Roles("admin", "tester")
  @HttpCode(201)
  addComment(
    @CurrentUser() user: JwtPayload,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.bugs.addComment(user, id, dto);
  }

  // ─── Apps + features ──────────────────────────────────────────────────
  // Reads are open to testers so /bugs/catalog and the /bugs/new app-picker
  // can populate themselves. Mutations stay admin-only.

  @Get("catalog")
  @Roles("admin", "tester")
  catalog() {
    return this.bugs.catalog();
  }

  @Get("apps")
  @Roles("admin", "tester")
  listApps() {
    return this.bugs.listApps();
  }

  @Get("apps/:appId/features")
  @Roles("admin", "tester")
  listFeatures(@Param("appId", new ParseUUIDPipe()) appId: string) {
    return this.bugs.listFeatures(appId);
  }

  @Post("apps")
  @Roles("admin")
  registerApp(@CurrentUser() user: JwtPayload, @Body() dto: RegisterAppDto) {
    return this.bugs.registerApp(user.email, dto);
  }

  @Post("apps/:appId/features")
  @Roles("admin")
  registerFeature(
    @CurrentUser() user: JwtPayload,
    @Param("appId", new ParseUUIDPipe()) appId: string,
    @Body() dto: RegisterFeatureDto,
  ) {
    return this.bugs.registerFeature(user.email, appId, dto);
  }
}

function pickFile(arr: MulterFile[] | undefined): MulterFile | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr[0];
}

function toUploadInput(file: MulterFile, fieldname: "screenshot" | "video"): UploadInput {
  return {
    fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
    buffer: file.buffer,
    size: file.size,
  };
}
