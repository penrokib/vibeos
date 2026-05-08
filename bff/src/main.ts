import "reflect-metadata";
import { resolve } from "node:path";
import { NestFactory, Reflector } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { JwtAuthGuard } from "@vibeos/auth";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  app.use(helmet());
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Class-C: every controller defaults to authenticated.
  // Routes opt out via `@Public()` decorator.
  app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));

  // Bug attachments live on disk under BUG_STORAGE_ROOT and are addressed
  // by unguessable UUID paths emitted by BugStorageService. Express serves
  // them ahead of Nest's guards — see bugs.service.ts for the URL contract.
  const config = app.get(ConfigService);
  const bugStorageRoot = resolve(
    config.get<string>("BUG_STORAGE_ROOT") ?? "./storage/bugs",
  );
  app.useStaticAssets(bugStorageRoot, { prefix: "/storage/bugs/" });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["https://app.rokibrain.com"],
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  Logger.log(`BFF listening on :${port}`, "Bootstrap");
  Logger.log(`Serving bug attachments from ${bugStorageRoot}`, "Bootstrap");
}

void bootstrap();
