import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PaypingService } from './payping.service';
import { ProductService } from './product.service';
import { PaymentService } from './payment.service';
import { PaymentVerifyController } from './payment-verify.controller';
import { FormEngineModule } from '../form-engine/form-engine.module';

@Module({
  imports: [PrismaModule, forwardRef(() => FormEngineModule)],
  controllers: [PaymentVerifyController],
  providers: [PaypingService, ProductService, PaymentService],
  exports: [PaypingService, ProductService, PaymentService],
})
export class PaymentsModule {}
