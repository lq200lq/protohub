import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../common/exception/business.exception';
import { IDEMPOTENCY_KEY_MAX_LENGTH } from '../../config/constants';
import { resolveUploadForm } from './release.dto';

/**
 * §5.1 表单解析单测（计划 M3-T2）。
 *
 * 钉的是"三选一 + 矛盾组合必须报出矛盾在哪"这段规则：它是纯函数，没有依赖，
 * 也是整个受理链路里唯一会**决定往哪张表插数据**的判断——猜错的代价是在别人没料到的项目下多了一个原型。
 */

const PROTOTYPE_JSON = JSON.stringify({ name: '登录页演示' });
const PROJECT_JSON = JSON.stringify({ name: 'CRM系统' });

function expectFormError(fields: Record<string, string>): BusinessException {
  try {
    resolveUploadForm(fields);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BusinessException);
    const business = error as BusinessException;
    expect(business.httpStatus).toBe(400);
    expect(business.errorCode).toBe(ERROR_CODES.PARAM_INVALID);
    return business;
  }
  throw new Error('表单本该被判为矛盾，却解析成功了');
}

describe('resolveUploadForm：三选一场景判定', () => {
  it('只带 prototypeId → 给已有原型追加新版本', () => {
    const form = resolveUploadForm({ prototypeId: '31' });
    expect(form.target).toEqual({ kind: 'append', prototypeId: '31' });
    expect(form.force).toBe(false);
    expect(form.note).toBeNull();
  });

  it('带 projectId + prototype → 在已有项目下新建原型', () => {
    const form = resolveUploadForm({
      projectId: '9',
      prototype: PROTOTYPE_JSON,
    });
    expect(form.target).toEqual({
      kind: 'createPrototype',
      projectId: '9',
      prototype: { code: undefined, description: undefined, name: '登录页演示' },
    });
  });

  it('带 project + prototype → 新建项目并挂上新原型', () => {
    const form = resolveUploadForm({
      project: PROJECT_JSON,
      prototype: JSON.stringify({ code: 'login-flow', description: '', name: '登录页演示' }),
    });
    expect(form.target).toEqual({
      kind: 'createProject',
      project: { code: undefined, description: undefined, name: 'CRM系统' },
      prototype: { code: 'login-flow', description: undefined, name: '登录页演示' },
    });
  });

  it('追加版本时再带 project/prototype/projectId → 400 并说明只需要什么', () => {
    const error = expectFormError({
      project: PROJECT_JSON,
      prototypeId: '31',
    });
    expect(error.message).toContain('发新版本只需要文件与可选的 note');
  });

  it('projectId 与 project 同时给 → 400 说明只能二选一', () => {
    const error = expectFormError({
      project: PROJECT_JSON,
      projectId: '9',
      prototype: PROTOTYPE_JSON,
    });
    expect(error.message).toContain('只能二选一');
  });

  it('新建场景缺 prototype → 400 点名要补哪个字段', () => {
    const error = expectFormError({ projectId: '9' });
    expect(error.message).toBe('请用 prototype 字段给出原型信息（JSON：name/code/description）');
  });

  it('新建原型却没给项目 → 400 点名 project', () => {
    const error = expectFormError({ prototype: PROTOTYPE_JSON });
    expect(error.message).toBe('请用 project 字段给出项目信息（JSON：name/code/description）');
  });

  it('prototype 不是合法 JSON → 单独报字段而不是报内部属性', () => {
    const error = expectFormError({ projectId: '9', prototype: '{name:' });
    expect(error.message).toBe('prototype 字段不是合法的 JSON');
  });

  it('prototype JSON 里的多余键被拒绝（DTO 一律 strict）', () => {
    const error = expectFormError({
      projectId: '9',
      prototype: JSON.stringify({ name: '登录页演示', status: 'published' }),
    });
    expect(error.message).toContain('参数不合法');
    expect(error.message).toContain('status');
  });

  it('prototype JSON 缺名称 → 400 用人话名词', () => {
    const error = expectFormError({
      projectId: '9',
      prototype: JSON.stringify({ name: '' }),
    });
    expect(error.message).toContain('原型名称不能为空');
  });
});

describe('resolveUploadForm：note / force / 幂等键', () => {
  it('note 去空白后落值', () => {
    const form = resolveUploadForm({
      note: '  改了配色  ',
      prototypeId: '31',
    });
    expect(form.note).toBe('改了配色');
  });

  it('note 超 300 字 → 400（proto_release.note 是 varchar(300)）', () => {
    const error = expectFormError({
      note: 'x'.repeat(301),
      prototypeId: '31',
    });
    expect(error.message).toContain('版本说明最长 300 个字符');
  });

  it('force 接受 multipart 里的字符串真值', () => {
    expect(resolveUploadForm({ force: 'true', prototypeId: '31' }).force).toBe(true);
    expect(resolveUploadForm({ force: '1', prototypeId: '31' }).force).toBe(true);
    expect(resolveUploadForm({ force: 'false', prototypeId: '31' }).force).toBe(false);
    expect(resolveUploadForm({ force: '', prototypeId: '31' }).force).toBe(false);
  });

  it('幂等键截断到上限而不是报错（§1.5：报 400 会让用户以为提交失败）', () => {
    const form = resolveUploadForm({ prototypeId: '31' }, 'k'.repeat(100));
    expect(form.idempotencyKey).toBe('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH));
  });

  it('空幂等键归一成 null', () => {
    expect(resolveUploadForm({ prototypeId: '31' }, '   ').idempotencyKey).toBeNull();
  });

  it('白名单外的字段不会走到这里，但真到了也要 400', () => {
    const error = expectFormError({ accessMode: 'member', prototypeId: '31' });
    expect(error.message).toContain('accessMode');
  });
});
