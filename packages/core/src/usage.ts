import type { TaskUsageTotals } from '../../contracts/src/events.js';

const EMPTY: TaskUsageTotals = { input: 0, output: 0, cached: 0, total: 0 };

export function emptyUsage(): TaskUsageTotals {
  return { ...EMPTY };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function pick(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = num(obj[k]);
    if (v > 0) return v;
  }
  return 0;
}

/**
 * 把各 harness 的 token 用量归一成 {input,output,cached,total}。
 * 支持: Claude(result.usage 的 snake_case)、Codex(thread/tokenUsage/updated 的 last/total)、
 * 以及已经归一化过的形状; 认不出来就返回 null。
 */
export function normalizeUsage(raw: unknown, depth = 0): TaskUsageTotals | null {
  if (!raw || typeof raw !== 'object' || depth > 2) return null;
  const o = raw as Record<string, unknown>;

  // Codex: { last: {...}, total: {...} } —— 优先用 last(本回合), 没有再退 total
  for (const key of ['last', 'turn', 'current']) {
    if (o[key] && typeof o[key] === 'object') {
      const inner = normalizeUsage(o[key], depth + 1);
      if (inner) return inner;
    }
  }

  const input = pick(o, ['input', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const cached = pick(o, ['cached', 'cached_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cached_input_tokens']);
  const output = pick(o, [
    'output',
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'completionTokensIncludingReasoning',
  ]);
  const explicitTotal = pick(o, ['total', 'total_tokens', 'totalTokens']);
  if (input === 0 && output === 0 && cached === 0 && explicitTotal === 0) return null;
  // Claude 的 input_tokens 不含缓存读取, 缓存单独算; 展示时 input 保持"新输入"
  return { input, output, cached, total: explicitTotal || input + cached + output };
}

export function addUsage(a: TaskUsageTotals, b: TaskUsageTotals): TaskUsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    total: a.total + b.total,
  };
}
