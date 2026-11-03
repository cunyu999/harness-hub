/**
 * 提示信封: 机器可解析的 turn 头 + 结构化上下文 + 人可读指令。
 * 真实 harness 读到的是同一段文本; mock 适配器通过信封做确定性行为, 不解析自然语言。
 */
import type { TurnKind } from './types.js';

const HEADER = '### HARNESS-HUB TURN v1';
const CONTEXT = '### CONTEXT (JSON)';
const INSTRUCTION = '### INSTRUCTION';

export interface BuiltPrompt {
  text: string;
  kind: TurnKind;
  context: Record<string, unknown>;
}

export function buildPrompt(args: {
  kind: TurnKind;
  taskId: string;
  workItemId?: string | null;
  expectsJson: boolean;
  context: Record<string, unknown>;
  instruction: string;
}): BuiltPrompt {
  const head = [
    HEADER,
    `kind: ${args.kind}`,
    `task: ${args.taskId}`,
    args.workItemId ? `work_item: ${args.workItemId}` : 'work_item: -',
    `expects_json: ${args.expectsJson ? 'true' : 'false'}`,
  ].join('\n');
  const text = `${head}\n\n${CONTEXT}\n${JSON.stringify(args.context, null, 2)}\n\n${INSTRUCTION}\n${args.instruction}\n`;
  return { text, kind: args.kind, context: args.context };
}

export interface ParsedPrompt {
  kind: TurnKind | null;
  taskId: string | null;
  workItemId: string | null;
  expectsJson: boolean;
  context: Record<string, unknown>;
  instruction: string;
}

export function parsePrompt(prompt: string): ParsedPrompt {
  const out: ParsedPrompt = {
    kind: null,
    taskId: null,
    workItemId: null,
    expectsJson: false,
    context: {},
    instruction: prompt,
  };
  const idx = prompt.indexOf(HEADER);
  if (idx < 0) return out;
  const ctxIdx = prompt.indexOf(CONTEXT, idx);
  const insIdx = prompt.indexOf(INSTRUCTION, idx);
  const headEnd = ctxIdx >= 0 ? ctxIdx : insIdx >= 0 ? insIdx : prompt.length;
  const head = prompt.slice(idx + HEADER.length, headEnd);
  for (const line of head.split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'kind') out.kind = value as TurnKind;
    if (key === 'task') out.taskId = value === '-' ? null : value;
    if (key === 'work_item') out.workItemId = value === '-' ? null : value;
    if (key === 'expects_json') out.expectsJson = value === 'true';
  }
  if (ctxIdx >= 0) {
    const jsonStart = prompt.indexOf('\n', ctxIdx) + 1;
    const jsonEnd = insIdx >= 0 ? insIdx : prompt.length;
    try {
      out.context = JSON.parse(prompt.slice(jsonStart, jsonEnd).trim()) as Record<string, unknown>;
    } catch {
      out.context = {};
    }
  }
  if (insIdx >= 0) out.instruction = prompt.slice(insIdx + INSTRUCTION.length).trim();
  return out;
}

/** 从模型文本中提取 JSON 对象/数组, 容忍 ```json 围栏与前后说明。 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(trimmed))) candidates.push(m[1].trim());
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}
