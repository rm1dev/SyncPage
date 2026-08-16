import { PrismaClient, EdgeNodeStatus } from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

async function main() {
  const edgeNodeId = '03d3a6c3-4fec-4ab7-b56b-04cb756c828f';
  
  // بررسی می‌کنیم که آیا نود از قبل وجود دارد یا خیر
  const existingNode = await prisma.edgeNode.findUnique({
    where: { id: edgeNodeId },
  });

  if (!existingNode) {
    const installToken = randomBytes(24).toString('hex');
    await prisma.edgeNode.create({
      data: {
        id: edgeNodeId,
        title: 'Local Edge Node (Dev)',
        host: 'app-edge', // نام کانتینر در داکر
        port: 2002,
        queueName: `landing.sync.${edgeNodeId}`,
        installToken,
        status: EdgeNodeStatus.ONLINE, // فرض بر این است که در لوکال همیشه آنلاین است
        rabbitStatus: EdgeNodeStatus.ONLINE,
      },
    });
    console.log(`✅ Seeded Local Edge Node: ${edgeNodeId}`);
  } else {
    console.log(`ℹ️ Local Edge Node already exists: ${edgeNodeId}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
