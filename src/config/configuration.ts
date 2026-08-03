/** hostnameهایی که فقط داخل Docker/لوکال معنی دارن — به Edge نده */
function isInternalAmqpHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === 'rabbitmq' ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === 'host.docker.internal'
  );
}

/**
 * URL عمومی AMQP برای Edgeها.
 * اولویت: RABBITMQ_PUBLIC_URL → RABBITMQ_URL غیرداخلی → ساخت از PUBLIC_BASE_URL + پورت 45672
 * پورت پیش‌فرض عمومی 45672 است چون خیلی از مسیرهای بین‌الملل :5672 را می‌بندند.
 */
function resolveRabbitmqPublicUrl(): string {
  const user = process.env.RABBITMQ_USER || 'syncpage';
  const pass = process.env.RABBITMQ_PASS || 'syncpage';
  const publicPort = process.env.RABBITMQ_PUBLIC_PORT || '45672';

  const explicit = process.env.RABBITMQ_PUBLIC_URL?.trim();
  if (explicit) return explicit;

  const internal = process.env.RABBITMQ_URL?.trim();
  if (internal) {
    try {
      const u = new URL(internal);
      if (!isInternalAmqpHost(u.hostname)) return internal;
    } catch {
      /* URL خراب بود، پایین می‌سازیم */
    }
  }

  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.MASTER_INTERNAL_URL ||
    'http://localhost';
  try {
    const withProto = base.includes('://') ? base : `http://${base}`;
    const host = new URL(withProto).hostname || 'localhost';
    return `amqp://${user}:${pass}@${host}:${publicPort}`;
  } catch {
    return `amqp://${user}:${pass}@localhost:${publicPort}`;
  }
}

export default () => ({
  nodeRole: (process.env.NODE_ROLE || 'MASTER').toUpperCase(),
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://syncpage:syncpage@localhost:5672',
  rabbitmqQueue: process.env.RABBITMQ_QUEUE || 'landing.sync',
  rabbitmqMasterQueue: process.env.RABBITMQ_MASTER_QUEUE || 'form.submission',
  rabbitmqPublicPort: parseInt(process.env.RABBITMQ_PUBLIC_PORT || '45672', 10),
  // URL عمومی RabbitMQ برای نودهای Edge (از بیرون Docker)
  rabbitmqPublicUrl: resolveRabbitmqPublicUrl(),
  adminToken: process.env.ADMIN_TOKEN || 'change-me-admin-token',
  staticPagesPath: process.env.STATIC_PAGES_PATH || './static_pages',
  tempPath: process.env.TEMP_PATH || './temp',
  masterInternalUrl:
    process.env.MASTER_INTERNAL_URL || 'http://localhost:3000',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost',
  outboxPollMs: parseInt(process.env.OUTBOX_POLL_MS || '3000', 10),
  outboxMaxAttempts: parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '10', 10),
  // شناسه نود Edge (موقع نصب ست می‌شه)
  edgeNodeId: process.env.EDGE_NODE_ID || '',
  // ریپوی گیت‌هاب برای ساخت کامند نصب
  githubRepo: process.env.SYNCPAGE_GITHUB_REPO || 'rm1dev/SyncPage',
  githubBranch: process.env.SYNCPAGE_GITHUB_BRANCH || 'main',
});
