import type { CodeCheckResult } from '@protohub/shared';

import { computed, ref } from 'vue';

import { normalizeCodeInput } from '@protohub/shared';

import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

/**
 * 编码字段的一套行为：失焦才查（每次按键都打 check-code 没必要）、留空也查一次拿 `generated` 预览、
 * 占用时把服务端给的原因与备选编码一起说清楚。
 *
 * 项目与原型两级共用这一处（前端设计 §3.7「通用能力收敛一处」）：三处表单（项目抽屉、原型抽屉、
 * 上传抽屉）各自写过一遍的话，"改一处忘改另一处"就会让两级编码的提示长得不一样。
 */
export interface UseCodeCheckOptions {
  /** 编辑态编码不可改：不再查询，提示换成"创建后不可修改" */
  immutable?: () => boolean;
  /** 留空时传 undefined（服务端把它当"请帮我生成"的信号） */
  query: (code: undefined | string) => Promise<CodeCheckResult>;
}

/** 编码输入框的实时规范化：把 shared 的规则应用到输入事件上，非法字符不落输入（§3.4） */
export function codeInputHandler(write: (value: string) => void) {
  return (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const next = normalizeCodeInput(target.value);
    if (next !== target.value) {
      write(next);
    }
  };
}

export function useCodeCheck(options: UseCodeCheckOptions) {
  const checking = ref(false);
  const result = ref<CodeCheckResult | null>(null);
  const error = ref<null | string>(null);

  function reset(): void {
    checking.value = false;
    result.value = null;
    error.value = null;
  }

  async function check(rawCode: string): Promise<void> {
    if (options.immutable?.()) {
      return;
    }
    const code = rawCode.trim();
    checking.value = true;
    result.value = null;
    error.value = null;
    try {
      result.value = await options.query(code === '' ? undefined : code);
    } catch (error_) {
      error.value = toErrorMessage(error_) || $t('proto.common.loadFailed');
    } finally {
      checking.value = false;
    }
  }

  /** 服务端说"留空会生成这个"——上传抽屉的链接预览要用它，不能只当提示文字 */
  const generated = computed(() => result.value?.generated ?? null);

  const hint = computed(() => {
    if (options.immutable?.()) {
      return $t('proto.codeCheck.immutable');
    }
    if (checking.value) {
      return $t('proto.codeCheck.checking');
    }
    if (error.value) {
      return error.value;
    }
    const checked = result.value;
    if (!checked) {
      return null;
    }
    if (checked.available) {
      return checked.generated
        ? $t('proto.codeCheck.generatedHint', [checked.generated])
        : $t('proto.codeCheck.available');
    }
    const reason = checked.message ?? $t('proto.codeCheck.unavailable');
    return checked.suggestion
      ? `${reason}（${$t('proto.codeCheck.suggestion', [checked.suggestion])}）`
      : reason;
  });

  const hintIsError = computed(
    () =>
      Boolean(error.value) ||
      Boolean(result.value && !result.value.available),
  );

  return { check, generated, hint, hintIsError, reset, result };
}
