import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { MasterOnlyGuard } from '../../common/guards/master-only.guard';
import { CreateFormDto, UpdateFormDto } from './dto/form.dto';
import { FormEngineService } from './form-engine.service';

@Controller('api/forms')
export class FormEngineController {
  constructor(private readonly forms: FormEngineService) {}

  // عمومی: سابمیشن از لندینگ
  @Post(':key/submit')
  submit(
    @Param('key') key: string,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, string>,
  ) {
    const otpCode = body.__otpCode ? String(body.__otpCode) : undefined;
    const payload = { ...body };
    delete payload.__otpCode;
    
    // 1. استخراج UTM ها از کوئری استرینگ (POST URL params)
    for (const [qKey, qValue] of Object.entries(query)) {
      if (qKey.startsWith('utm_') && qValue) {
        payload[qKey] = qValue;
      }
    }

    // 2. استخراج UTM ها از بدنه درخواست (Body/FormData) در صورت وجود
    for (const [bKey, bValue] of Object.entries(body)) {
      if (bKey.startsWith('utm_') && bValue) {
        payload[bKey] = bValue;
      }
    }

    return this.forms.submit(key, payload, otpCode);
  }

  @Post(':key/otp')
  requestOtp(
    @Param('key') key: string,
    @Body('mobile') mobile: string,
  ) {
    if (!mobile) throw new BadRequestException('Mobile is required');
    return this.forms.requestOtp(key, mobile);
  }

  @Get()
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  list() {
    return this.forms.list();
  }

  @Get(':id')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  get(@Param('id') id: string) {
    return this.forms.getById(id);
  }

  @Post()
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  create(@Body() dto: CreateFormDto) {
    return this.forms.create(dto);
  }

  @Put(':id')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  update(@Param('id') id: string, @Body() dto: UpdateFormDto) {
    return this.forms.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  remove(@Param('id') id: string) {
    return this.forms.remove(id);
  }

  @Get(':id/submissions')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  submissions(@Param('id') id: string) {
    return this.forms.listSubmissions(id);
  }
}
