import 'reflect-metadata';

import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { readAppVersion } from './common/app-version';
import { PinoLoggerService } from './common/logger/pino-logger.service';
import { AppEnvService } from './config/app-env.service';
import {
  API_PREFIX,
  MULTIPART_FIELD_SIZE_BYTES,
  MULTIPART_MAX_FIELDS,
  SWAGGER_PATH,
} from './config/constants';

async function bootstrap(): Promise<void> {
  // 动态 import：AppConfigModule 的 validate 在模块装饰器求值时就可能抛 EnvConfigError，
  // 放在 try 能覆盖的位置，配置问题才会走下面统一的"启动失败"出口（可读消息 + 退出码 1）。
  const { AppModule } = await import('./app.module');

  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  // Nest/Fastify 的 JSON 解析器拒绝「content-type: application/json + 空请求体」，
  // 而无 body 的 POST/DELETE 天然带这个头（登出、归档/恢复、删项目都是），于是真实用户动作
  // 拿到一个与业务无关的 400——§1.4 的 400 只留给"参数不合法"。空体按"没有 body"放行，
  // 其余仍是 JSON.parse；所有 DTO 都 .strict()，多出来的键（含 __proto__）在参数校验层就被拒。
  app.useBodyParser(
    'application/json',
    { bodyLimit: adapter.getInstance().initialConfig.bodyLimit },
    (_request, body, done) => {
      const text = body.toString('utf8').trim();
      if (text === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (error: unknown) {
        done(error instanceof Error ? error : new Error(String(error)), undefined);
      }
    },
  );

  app.useLogger(app.get(PinoLoggerService));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  const env = app.get(AppEnvService).env;

  // 上传走流式（机制 §5.2：受理时不解压，所以不能把整包读进内存）：注册 multipart 内容解析器，
  // 由 `release/pipeline/intake.ts` 遍历分片直接写盘。
  // `throwFileSizeLimit: false` 是故意的——默认 true 时超限的分片会直接以 busboy 的通用错误结束，
  // 我们拿不到"是哪个限制被撞"，只能报成 500；关掉后 `part.file.truncated` 才读得到，
  // 于是 §8 的 413「文件超过 {N}MB 上限」有了出处。
  // fastify 的 `bodyLimit` 对 multipart 不生效（它只作用于内置的 asString/asBuffer 解析器），
  // 所以上限必须在这里由 `limits.fileSize` 给出，而不是指望全局那一道。
  // `files: 1` 是给解析器的资源上限（别同时开一堆文件流），它撞线时抛的是
  // `FST_FILES_LIMIT`，由 intake 翻成 400「一次只能上传一个 zip 文件」——留着这两个字面量一样的
  // 文案，是为了让"第二个文件"永远是一句用户能懂的话，而不是 500。
  await app.register(multipart, {
    limits: {
      fieldSize: MULTIPART_FIELD_SIZE_BYTES,
      fields: MULTIPART_MAX_FIELDS,
      fileSize: env.upload.maxBytes,
      files: 1,
    },
    throwFileSizeLimit: false,
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ProtoHub API')
      .setDescription('原型托管平台的后端接口，约定见 docs/后端接口设计.md')
      .setVersion(readAppVersion())
      .addServer(`/${API_PREFIX}`)
      .build(),
  );
  SwaggerModule.setup(SWAGGER_PATH, app, document);

  // 只监听回环地址（HOST 由配置给，代码里不写死；见 迭代实施计划.md §3.1）。
  await app.listen(env.http.port, env.http.host);

  Logger.log(
    {
      host: env.http.host,
      port: env.http.port,
      apiPrefix: API_PREFIX,
      docs: SWAGGER_PATH,
      serveStatic: env.serveStatic,
      storageRoot: env.storage.root,
      cookieSecure: env.cookie.secure,
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
