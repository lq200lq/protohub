import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { readAppVersion } from '../common/app-version';

/** 后端接口设计.md §9.4：健康检查无鉴权，因此不多吐任何额外信息。 */
export interface HealthStatus {
  readonly status: 'ok';
  readonly version: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '存活探针', operationId: 'health' })
  @ApiResponse({ status: 200, description: '服务存活' })
  health(): HealthStatus {
    return { status: 'ok', version: readAppVersion() };
  }
}
