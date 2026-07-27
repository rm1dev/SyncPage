import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isMaster } from '../../config/role';

@Injectable()
export class MasterOnlyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isMaster()) {
      throw new ForbiddenException('This endpoint is only available on MASTER');
    }
    return true;
  }
}
