export default () => ({
  nodeRole: (process.env.NODE_ROLE || 'MASTER').toUpperCase(),
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://spage:spage@localhost:5672',
  rabbitmqQueue: process.env.RABBITMQ_QUEUE || 'landing.sync',
  rabbitmqMasterQueue: process.env.RABBITMQ_MASTER_QUEUE || 'form.submission',
  // URL عمومی RabbitMQ برای نودهای Edge (از بیرون Docker)
  rabbitmqPublicUrl:
    process.env.RABBITMQ_PUBLIC_URL ||
    process.env.RABBITMQ_URL ||
    'amqp://spage:spage@localhost:5672',
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
  githubRepo: process.env.SPAGE_GITHUB_REPO || 'YOUR_GITHUB_USER/spage',
  githubBranch: process.env.SPAGE_GITHUB_BRANCH || 'master',
});
