import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { NoPortal } from '../portal/no-portal.decorator';

@Controller()
export class HealthController {
  /** Probed by the platform, which sends no Origin. */
  @Public()
  @NoPortal()
  @Get('health')
  check(): { status: string } {
    return { status: 'ok' };
  }
}
