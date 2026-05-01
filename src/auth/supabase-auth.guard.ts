import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const authHeader: string | undefined = request.headers['authorization']

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token')
    }

    const token = authHeader.slice(7)

    // `auth.getUser` returns `{ data, error }` rather than throwing; we
    // collapse both shapes (network throw / auth-rejection) into a single
    // `UnauthorizedException` so the controller doesn't have to care which
    // one happened.
    try {
      const { data, error } = await this.supabaseService.getClient().auth.getUser(token)
      if (error || !data.user) {
        throw new UnauthorizedException('Invalid or expired token')
      }
      request.authUser = data.user
      return true
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err
      throw new UnauthorizedException('Invalid or expired token')
    }
  }
}
