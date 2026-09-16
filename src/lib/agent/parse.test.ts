import { describe, expect, it } from 'vitest';
import { buildResponse } from '@/test/mocks';
import type { ChatRequest } from '../groq/types';
import {
  extractBalancedJson,
  parseJsonLoose,
  parseModelStep,
  recoverFromFailedGeneration,
  recoverToolCallFromText,
  repairTruncatedJson,
  resolveToolName,
  stripCodeFences,
} from './parse';

const request: ChatRequest = { model: 'test-model', messages: [] };
const TOOLS = ['wikipedia', 'calculator', 'fetch_url'];

describe('JSON recovery', () => {
  it('should strip a fenced code block', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('should find a balanced object even when a brace appears inside a string', () => {
    const text = 'here you go: {"url":"https://x.com/a{b}c","n":1} and that is all';
    expect(extractBalancedJson(text)).toBe('{"url":"https://x.com/a{b}c","n":1}');
  });

  it('should repair a trailing comma', () => {
    const parsed = parseJsonLoose('{"a":1,}');
    expect(parsed?.value).toEqual({ a: 1 });
    expect(parsed?.repaired).toBe(true);
  });

  it('should return null for text that holds no JSON at all', () => {
    expect(parseJsonLoose('the answer is 42')).toBeNull();
  });

  it('should recover a tool call written as prose', () => {
    const recovered = recoverToolCallFromText(
      'I will look this up.\n```json\n{"tool":"wikipedia","args":{"query":"Tokyo"}}\n```',
      TOOLS,
    );
    expect(recovered).toEqual({ name: 'wikipedia', args: { query: 'Tokyo' } });
  });

  it('should not invent a tool that does not exist', () => {
    expect(recoverToolCallFromText('{"tool":"rm_rf","args":{}}', TOOLS)).toBeNull();
  });
});

describe('parseModelStep', () => {
  it('should read a native tool call', () => {
    const step = parseModelStep(
      buildResponse(request, { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] }),
      TOOLS,
    );
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]?.origin).toBe('native');
    expect(step.problems).toHaveLength(0);
    expect(step.finalAnswer).toBeNull();
  });

  it('should repair malformed native arguments and say that it did', () => {
    const step = parseModelStep(
      buildResponse(request, {
        toolCalls: [{ name: 'calculator', args: '```json\n{"expression":"2+2",}\n```' }],
      }),
      TOOLS,
    );
    expect(step.toolCalls[0]?.args).toEqual({ expression: '2+2' });
    expect(step.toolCalls[0]?.origin).toBe('repaired-json');
    expect(step.problems[0]?.code).toBe('repaired-json');
  });

  it('should report arguments it cannot parse at all instead of guessing', () => {
    const step = parseModelStep(
      buildResponse(request, { toolCalls: [{ name: 'calculator', args: 'not json <<>>' }] }),
      TOOLS,
    );
    expect(step.toolCalls).toHaveLength(0);
    expect(step.problems[0]?.code).toBe('unparseable-arguments');
  });

  it('should recover a tool call the model wrote into its message text', () => {
    const step = parseModelStep(
      buildResponse(request, { content: '{"tool":"wikipedia","args":{"query":"Tokyo"}}' }),
      TOOLS,
    );
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]?.origin).toBe('recovered-from-text');
    expect(step.problems[0]?.code).toBe('recovered-from-text');
  });

  it('should treat plain prose as the final answer', () => {
    const step = parseModelStep(
      buildResponse(request, { content: 'Tokyo has about 14 million residents.' }),
      TOOLS,
    );
    expect(step.finalAnswer).toBe('Tokyo has about 14 million residents.');
    expect(step.toolCalls).toHaveLength(0);
  });

  it('should flag an empty turn rather than treating it as an answer', () => {
    const step = parseModelStep(buildResponse(request, { content: '' }), TOOLS);
    expect(step.finalAnswer).toBeNull();
    expect(step.problems[0]?.code).toBe('empty-response');
  });
});

describe('tool name recovery — the provider rejected the model output', () => {
  const TOOL_SET = ['wikipedia', 'fetch_url', 'arxiv_search', 'calculator', 'current_datetime'];

  it('should resolve a truncated name the provider refused', () => {
    // Observed live on 2026-09-16: Groq 400 tool_use_failed for "wiki...".
    expect(resolveToolName('wiki...', TOOL_SET)).toBe('wikipedia');
    expect(resolveToolName('Wikipedia', TOOL_SET)).toBe('wikipedia');
    expect(resolveToolName('fetch-url', TOOL_SET)).toBe('fetch_url');
    expect(resolveToolName('arxiv', TOOL_SET)).toBe('arxiv_search');
  });

  it('should refuse to guess when the candidate is ambiguous or unrelated', () => {
    expect(resolveToolName('c', TOOL_SET)).toBeNull();
    expect(resolveToolName('delete_everything', TOOL_SET)).toBeNull();
    expect(resolveToolName('', TOOL_SET)).toBeNull();
    // Two tools starting with the same normalised prefix must not resolve.
    expect(resolveToolName('a', ['alpha_one', 'alpha_two'])).toBeNull();
    expect(resolveToolName('alpha', ['alpha_one', 'alpha_two'])).toBeNull();
  });

  it('should rebuild the intended call from the failed generation blob', () => {
    const blob = '{"name": "wiki...", "arguments": {"limit":5,"query":"Tokyo population 2025"}}';
    const recovered = recoverFromFailedGeneration(blob, TOOL_SET);
    expect(recovered).toEqual({
      name: 'wikipedia',
      args: { limit: 5, query: 'Tokyo population 2025' },
      rawName: 'wiki...',
    });
  });

  it('should return nothing when there is no blob or no usable name', () => {
    expect(recoverFromFailedGeneration(null, TOOL_SET)).toBeNull();
    expect(recoverFromFailedGeneration('not json', TOOL_SET)).toBeNull();
    expect(recoverFromFailedGeneration('{"arguments":{}}', TOOL_SET)).toBeNull();
    expect(recoverFromFailedGeneration('{"name":"unknown_thing"}', TOOL_SET)).toBeNull();
  });

  it('should parse arguments that arrive as a JSON string', () => {
    const recovered = recoverFromFailedGeneration(
      '{"name":"calculator","arguments":"{\\"expression\\":\\"2+2\\"}"}',
      TOOL_SET,
    );
    expect(recovered?.args).toEqual({ expression: '2+2' });
  });
});

describe('truncated JSON repair — a token cap cut the answer off', () => {
  it('should salvage the complete elements from a plan cut mid-object', () => {
    // The exact shape seen live: reasoning ate the completion budget and the
    // array was cut inside the third element.
    const truncated =
      '{"subgoals":[{"title":"Overview","goal":"Summarise the field."},' +
      '{"title":"Funding","goal":"Find the public money spent."},' +
      '{"title":"Timel';
    const repaired = repairTruncatedJson(truncated);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired as string) as { subgoals: unknown[] };
    expect(parsed.subgoals).toHaveLength(2);
  });

  it('should be reachable through parseJsonLoose', () => {
    const truncated = '{"subgoals":[{"title":"A","goal":"first"},{"title":"B","goal":"seco';
    const parsed = parseJsonLoose(truncated);
    expect(parsed?.repaired).toBe(true);
    expect((parsed?.value as { subgoals: unknown[] }).subgoals).toHaveLength(1);
  });

  it('should leave already-complete JSON untouched', () => {
    expect(repairTruncatedJson('{"a":[1,2]}')).toBe('{"a":[1,2]}');
  });

  it('should discard a partial element rather than guess at it', () => {
    const repaired = repairTruncatedJson('{"items":[{"id":1},{"id":');
    const parsed = JSON.parse(repaired as string) as { items: Array<{ id: number }> };
    expect(parsed.items).toEqual([{ id: 1 }]);
  });

  it('should return null when nothing complete was produced', () => {
    expect(repairTruncatedJson('{"subgoals":[{"title":"onl')).toBeNull();
    expect(repairTruncatedJson('no json here')).toBeNull();
  });

  it('should not be confused by brackets inside strings', () => {
    const repaired = repairTruncatedJson('{"a":[{"s":"a}b]c"},{"s":"part');
    const parsed = JSON.parse(repaired as string) as { a: Array<{ s: string }> };
    expect(parsed.a).toEqual([{ s: 'a}b]c' }]);
  });
});
