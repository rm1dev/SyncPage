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

  @Post(':key/submit')
  submit(
    @Param('key') key: string,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, string>,
  ) {
    return this.forms.submit(key, this.withUtms(body, query));
  }

  @Post(':key/otp')
  requestOtp(
    @Param('key') key: string,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, string>,
  ) {
    return this.forms.requestOtp(key, this.withUtms(body, query));
  }

  @Post(':key/otp/verify')
  verifyOtp(
    @Param('key') key: string,
    @Body('submissionId') submissionId: string,
    @Body('code') code: string,
  ) {
    return this.forms.verifyOtp(key, submissionId, code);
  }

  private withUtms(
    body: Record<string, unknown>,
    query: Record<string, string>,
  ) {
    const payload = { ...body };
    for (const [qKey, qValue] of Object.entries(query)) {
      if (qKey.startsWith('utm_') && qValue) payload[qKey] = qValue;
    }
    return payload;
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
