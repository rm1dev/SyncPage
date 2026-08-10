import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import * as express from 'express';
import { engine } from 'express-handlebars';
import { AppModule } from './app.module';
import { isEdge, isMaster } from './config/role';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const viewsPath = join(process.cwd(), 'views');
  app.engine(
    'hbs',
    engine({
      extname: '.hbs',
      defaultLayout: 'main',
      layoutsDir: join(viewsPath, 'layouts'),
      partialsDir: join(viewsPath, 'partials'),
      helpers: {
        eq: (a: unknown, b: unknown) => a === b,
        json: (ctx: unknown) => JSON.stringify(ctx, null, 2),
      },
    }),
  );
  app.setBaseViewsDir(viewsPath);
  app.setViewEngine('hbs');

  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/public/' });

  // روی Master روت دامنه بره به پنل (قبلاً nginx این کار رو می‌کرد)
  if (isMaster()) {
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method === 'GET' && (req.path === '/' || req.path === '')) {
        return res.redirect(302, '/spadmin');
      }
      return next();
    });
  }

  // سرو پیش‌نمایش و fallback استاتیک
  const tempPath = process.env.TEMP_PATH || './temp';
  const staticPath = process.env.STATIC_PAGES_PATH || './static_pages';
  for (const dir of [
    join(tempPath, 'preview'),
    join(tempPath, 'packages'),
    join(tempPath, 'uploads'),
    staticPath,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  app.use('/preview', express.static(join(process.cwd(), tempPath, 'preview')));
  // لندینگ‌ها مستقیم روی /:slug/ سرو می‌شن (بدون پیشوند /pages)
  app.use(express.static(staticPath));
  // مسیر قدیمی رو ریدایرکت می‌کنیم که لینک‌های قبلی نشکنن
  app.use('/pages', (req: express.Request, res: express.Response) => {
    const target = req.url === '/' ? '/' : req.url;
    res.redirect(301, target);
  });

  const rmqUrl = process.env.RABBITMQ_URL || 'amqp://syncpage:syncpage@localhost:5672';
  const started: string[] = [];

  if (isEdge()) {
    const queue = process.env.RABBITMQ_QUEUE || 'landing.sync';
    // Edge ریموت: heartbeat بلند — مسیر بین‌الملل با ۳۰s مدام missed heartbeats می‌ده
    const heartbeat = parseInt(process.env.RABBITMQ_HEARTBEAT || '600', 10);
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue,
        queueOptions: { durable: true },
        noAck: false,
        prefetchCount: 1,
        socketOptions: {
          heartbeatIntervalInSeconds: Number.isFinite(heartbeat)
            ? heartbeat
            : 600,
          reconnectTimeInSeconds: 5,
        },
      },
    });
    started.push(`edge:${queue}`);
  }

  if (isMaster()) {
    // سابمیشن‌های Edge به این صف میان
    const queue = process.env.RABBITMQ_MASTER_QUEUE || 'form.submission';
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue,
        queueOptions: { durable: true },
        noAck: false,
        prefetchCount: 1,
        socketOptions: {
          heartbeatIntervalInSeconds: 30,
          reconnectTimeInSeconds: 5,
        },
      },
    });
    started.push(`master:${queue}`);
  }

  // اول HTTP رو بالا میاریم تا health گیر RabbitMQ نمونه
  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  console.log(
    `SyncPage running as ${process.env.NODE_ROLE || 'MASTER'} on port ${port}`,
  );

  if (started.length) {
    console.log(
      `Connecting microservices: ${started.join(', ')} → ${rmqUrl.replace(/:[^:@/]+@/, ':***@')}`,
    );
    // await نمی‌کنیم تا اگه RabbitMQ دیر جواب داد، پروسس روی HTTP زنده بمونه
    // و به‌محض وصل شدن، consumer همگام‌سازی شروع به کار کنه
    void app
      .startAllMicroservices()
      .then(() =>
        console.log(`Microservices listening: ${started.join(', ')}`),
      )
      .catch((err) =>
        console.error('Microservices failed to start (HTTP stays up):', err),
      );
  }
}

bootstrap();
