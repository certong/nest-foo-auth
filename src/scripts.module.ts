import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

/**
 * What the admin scripts in scripts/ boot: configuration and the database,
 * nothing else (spec 15.9). Booting AppModule would demand the signing key and
 * the portal map just to add an account — and would start the retention timer.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
})
export class ScriptsModule {}
