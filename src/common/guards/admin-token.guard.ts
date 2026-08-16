import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('adminToken') || '';

    const headerToken =
      (req.headers['x-admin-token'] as string | undefined) ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    const cookieHeader = req.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)admin_token=([^;]+)/);
    const cookieToken = cookieMatch?.[1]
      ? decodeURIComponent(cookieMatch[1])
      : undefined;

    const queryToken =
      typeof req.query.token === 'string' ? req.query.token : undefined;

    const token = headerToken || cookieToken || queryToken;

    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid or missing ADMIN_TOKEN');
    }
    return true;
  }
}
