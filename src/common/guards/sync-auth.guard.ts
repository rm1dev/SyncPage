import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class SyncAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('syncHttpToken') || '';

    if (!expected) {
       // If not configured, deny access by default for safety, or we could allow it. 
       // The plan says "Guard that checks Authorization: Bearer <SYNC_HTTP_TOKEN>".
       // We'll throw an error if missing.
       throw new UnauthorizedException('SYNC_HTTP_TOKEN is not configured');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = tokenMatch?.[1];

    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid or missing SYNC_HTTP_TOKEN');
    }

    return true;
  }
}
