import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { FoundersJoinedService } from './founders-joined.service'

/**
 * `GET /founders-joined` — public (no auth). Used by the landing hero
 * badge. Ticks the fake counter forward based on hours since last
 * update, then returns `{ count }`.
 */
@Controller('founders-joined')
export class FoundersJoinedController {
  private readonly logger = new Logger(FoundersJoinedController.name)

  constructor(private readonly foundersJoined: FoundersJoinedService) {}

  @Get()
  async get() {
    try {
      return await this.foundersJoined.getAndTick()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.logger.error(`GET /founders-joined failed: ${detail}`)
      throw new HttpException(
        'Could not load founders counter',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
  }
}
