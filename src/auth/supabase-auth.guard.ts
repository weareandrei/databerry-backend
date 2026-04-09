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

    let user: any
    try {
      const { data, error } = await this.supabaseService.getClient().auth.getUser(token)
      if (error || !data.user) throw new Error('invalid')
      user = data.user
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }

    request.authUser = user
    return true
  }
}
