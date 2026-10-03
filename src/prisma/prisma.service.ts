import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

// No eager $connect() in onModuleInit: Prisma connects on the first query.
// Connecting at boot made app.listen() wait for Neon to resume from
// auto-suspend, stacking the database wake-up onto every container cold start.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(configService: ConfigService) {
    super({
      datasources: {
        db: { url: configService.get<string>('DATABASE_URL') },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
