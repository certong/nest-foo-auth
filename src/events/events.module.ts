import { Module } from '@nestjs/common';
import { AuthEventRetention } from './auth-event-retention';
import { AuthEventService } from './auth-event.service';

@Module({
  providers: [AuthEventService, AuthEventRetention],
  exports: [AuthEventService],
})
export class EventsModule {}
