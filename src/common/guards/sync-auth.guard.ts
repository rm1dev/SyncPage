import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class SyncAuthGuard implements CanActivate {
  private readonly logger = new Logger(SyncAuthGuard.name);

  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    
    // اگه توکن کلاً تنظیم نشده باشه، در محیط توسعه گیر نده
    // (اما در پروداکشن باید حتماً باشه)
    const expectedToken = this.configService.get<string>('syncHttpToken');
    if (!expectedToken) {
       if (process.env.NODE_ENV === 'production') {
           this.logger.error('SYNC_HTTP_TOKEN is not configured in production');
           throw new UnauthorizedException('Sync authentication not configured');
       }
       return true;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    
    if (token !== expectedToken) {
      this.logger.warn(`Invalid sync token provided from IP: ${request.ip}`);
      throw new UnauthorizedException('Invalid sync token');
    }

    return true;
  }
}
