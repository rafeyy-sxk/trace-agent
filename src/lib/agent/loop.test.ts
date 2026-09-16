import { describe, expect, it, vi } from 'vitest';
import { scriptedChat } from '@/test/mocks';
import { GroqRateLimitError, GroqToolUseError } from '../groq/types';
import { calculatorTool, datetimeTool } from '../tools';
import type { AnyTool } from '../tools/types';
import { collectRun, runAgent, type AgentOptions } from './loop';
import type { TraceEvent } from './types';

const TOOLS = [calculatorTool, datetimeTool] as unknown as readonly AnyTool[];

function baseOptions(overrides: Partial<AgentOptions> & Pick<AgentOptions, 'chat'>): AgentOptions {
  return {
    goal: 'test goal',
    model: 'test-model',
    tools: TOOLS,
    maxSteps: 4,
    ...overrides,
  };
}

async function drain(options: AgentOptions) {
  const events: TraceEvent[] = [];
  const trace = await collectRun(options, (event) => events.push(event));
  return { trace, events };
}

describe('agent loop — stop condition', () => {
  it('should stop the moment the model answers without calling a tool', async () => {
    const chat = scriptedChat([{ content: 'Tokyo has 14 million residents.' }]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn }));

    expect(trace.status).toBe('completed');
    expect(trace.answer).toBe('Tokyo has 14 million residents.');
    expect(trace.steps).toBe(1);
    expect(chat.callCount()).toBe(1);
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('run_finished');
  });

  it('should run tools then answer, recording every step in order', async () => {
    const chat = scriptedChat([
      {
        reasoning: 'I should compute this exactly.',
        toolCalls: [{ name: 'calculator', args: { expression: '14000000 - 8300000' } }],
      },
      { content: 'The difference is 5,700,000.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn }));

    expect(trace.status).toBe('completed');
    expect(trace.steps).toBe(2);
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'run_started',
      'step_started',
      'model_call',
      'thought',
      'tool_call',
      'tool_result',
      'step_started',
      'model_call',
      'final_answer',
      'run_finished',
    ]);
    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.ok).toBe(true);
    expect(result?.type === 'tool_result' && result.observation).toContain('5,700,000');
  });

  it('should feed a tool failure back to the model instead of ending the run', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1/0' } }] },
      { content: 'That calculation is undefined.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn }));

    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.ok).toBe(false);
    expect(trace.status).toBe('completed');
    const toolMessage = chat.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('Division by zero');
  });
});

describe('agent loop — step budget', () => {
  it('should never exceed the step budget however long the model keeps calling tools', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
    ]);
    const { trace, events } = await drain(
      baseOptions({ chat: chat.fn, maxSteps: 3, forceFinalAnswer: false }),
    );

    expect(trace.steps).toBe(3);
    expect(trace.status).toBe('budget-exhausted');
    expect(events.filter((event) => event.type === 'step_started')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(3);
    expect(chat.callCount()).toBe(3);
  });

  it('should spend one final tool-free call to produce an answer when the budget runs out', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
      { content: 'Best answer from what I gathered: 4.' },
    ]);
    const { trace } = await drain(baseOptions({ chat: chat.fn, maxSteps: 2 }));

    expect(trace.status).toBe('budget-exhausted');
    expect(trace.answer).toBe('Best answer from what I gathered: 4.');
    const lastRequest = chat.requests.at(-1);
    expect(lastRequest?.tools).toBeUndefined();
  });

  it('should cap the number of tool calls accepted in a single step', async () => {
    const chat = scriptedChat([
      {
        toolCalls: [
          { name: 'calculator', args: { expression: '1+1' }, id: 'a' },
          { name: 'calculator', args: { expression: '2+2' }, id: 'b' },
          { name: 'calculator', args: { expression: '3+3' }, id: 'c' },
        ],
      },
      { content: 'done' },
    ]);
    const { events } = await drain(
      baseOptions({ chat: chat.fn, maxToolCallsPerStep: 2 }),
    );
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
    const notice = events.find((event) => event.type === 'notice');
    expect(notice?.type === 'notice' && notice.code).toBe('tool-calls-capped');
  });
});

describe('agent loop — malformed model output', () => {
  it('should recover a tool call the model wrote as prose and keep going', async () => {
    const chat = scriptedChat([
      { content: '{"tool": "calculator", "args": {"expression": "6*7"}}' },
      { content: 'It is 42.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn }));

    const notice = events.find((event) => event.type === 'notice');
    expect(notice?.type === 'notice' && notice.code).toBe('recovered-from-text');
    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.observation).toContain('42');
    expect(trace.status).toBe('completed');
  });

  it('should tell the model what went wrong and spend another step when a turn is empty', async () => {
    const chat = scriptedChat([{ content: '' }, { content: 'Recovered answer.' }]);
    const { trace } = await drain(baseOptions({ chat: chat.fn }));

    expect(trace.status).toBe('completed');
    expect(trace.answer).toBe('Recovered answer.');
    const recovery = chat.requests[1]?.messages.at(-1);
    expect(recovery?.role).toBe('user');
    expect(recovery?.content).toContain('could not be used');
  });

  it('should surface unparseable tool arguments as a warning and still finish', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: 'this is not json' }] },
      { content: 'Answered without the tool.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn }));

    const notice = events.find(
      (event) => event.type === 'notice' && event.code === 'unparseable-arguments',
    );
    expect(notice).toBeDefined();
    expect(trace.status).toBe('completed');
  });
});

describe('agent loop — failure and cancellation', () => {
  it('should end as rate-limited when the model call raises a 429 the client did not absorb', async () => {
    const chat = scriptedChat([{ throws: new GroqRateLimitError('{}', 2_000) }]);
    const { trace } = await drain(baseOptions({ chat: chat.fn }));
    expect(trace.status).toBe('rate-limited');
    expect(trace.error).toContain('rate limit');
  });

  it('should end as cancelled when the signal aborts before a step', async () => {
    const controller = new AbortController();
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
    ]);
    const options = baseOptions({ chat: chat.fn, signal: controller.signal, maxSteps: 5 });
    const iterator = runAgent(options);
    await iterator.next();
    controller.abort();
    let final = await iterator.next();
    while (!final.done) final = await iterator.next();
    expect(final.value.status).toBe('cancelled');
  });

  it('should report a model failure as a failed run rather than throwing', async () => {
    const chat = scriptedChat([{ throws: new Error('connection reset') }]);
    const { trace } = await drain(baseOptions({ chat: chat.fn }));
    expect(trace.status).toBe('failed');
    expect(trace.error).toContain('connection reset');
  });
});

describe('agent loop — accounting and citations', () => {
  it('should sum token usage across every model call', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }], usage: { prompt: 100, completion: 20 } },
      { content: 'two', usage: { prompt: 150, completion: 10 } },
    ]);
    const { trace } = await drain(baseOptions({ chat: chat.fn }));
    expect(trace.usage.promptTokens).toBe(250);
    expect(trace.usage.completionTokens).toBe(30);
    expect(trace.usage.totalTokens).toBe(280);
  });

  it('should produce a serialisable trace that survives a JSON round trip', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'current_datetime', args: { timezone: 'UTC' } }] },
      { content: 'Checked the clock.' },
    ]);
    const { trace } = await drain(baseOptions({ chat: chat.fn }));
    const roundTripped = JSON.parse(JSON.stringify(trace)) as typeof trace;
    expect(roundTripped.events.length).toBe(trace.events.length);
    expect(roundTripped.answer).toBe(trace.answer);
    expect(roundTripped.version).toBe(1);
  });

  it('should pass the injected tool context through to the tool', async () => {
    const now = vi.fn(() => new Date('2030-01-02T03:04:05.000Z'));
    const chat = scriptedChat([
      { toolCalls: [{ name: 'current_datetime', args: { timezone: 'UTC' } }] },
      { content: 'done' },
    ]);
    const { events } = await drain(baseOptions({ chat: chat.fn, toolContext: { now } }));
    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.observation).toContain('2030-01-02');
    expect(now).toHaveBeenCalled();
  });
});

describe('agent loop — defects found during live verification', () => {
  it('should not re-run an identical tool call, and should tell the model it repeated itself', async () => {
    // Live run 2026-09-16: the model issued the same fetch_url call five times
    // in a row because the first result was disappointing, burning the whole
    // step budget on one URL.
    const repeated = { name: 'calculator', args: { expression: '2+2' } };
    const chat = scriptedChat([
      { toolCalls: [repeated] },
      { toolCalls: [repeated] },
      { toolCalls: [repeated] },
      { content: 'Fine, it is 4.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn, maxSteps: 5 }));

    const duplicateNotices = events.filter(
      (event) => event.type === 'notice' && event.code === 'duplicate-tool-call',
    );
    expect(duplicateNotices).toHaveLength(2);

    // Three tool_result events, but only one actual execution.
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(3);
    const finished = events.at(-1);
    expect(finished?.type === 'run_finished' && finished.toolCalls).toBe(1);

    const replayed = chat.requests[2]?.messages.at(-1);
    expect(replayed?.content).toContain('You already made this exact call');
    expect(trace.status).toBe('completed');
  });

  it('should ask for the forced answer on a clean conversation with no tool machinery', async () => {
    // Live run 2026-09-16: re-sending the tool-call transcript with `tools`
    // omitted made Groq answer HTTP 400 "Tool choice is none, but model called
    // a tool", and a run with six real tool results ended as `failed`.
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
      { content: 'Two, from the calculator.' },
    ]);
    const { trace } = await drain(baseOptions({ chat: chat.fn, maxSteps: 1 }));

    const finalRequest = chat.requests.at(-1);
    expect(finalRequest?.tools).toBeUndefined();
    expect(finalRequest?.messages).toHaveLength(2);
    expect(finalRequest?.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(finalRequest?.messages.some((message) => message.tool_calls !== undefined)).toBe(false);
    // The evidence is replayed as plain text instead.
    expect(finalRequest?.messages[1]?.content).toContain('calculator');
    expect(finalRequest?.messages[1]?.content).toContain('1+1 = 2');
    expect(trace.answer).toBe('Two, from the calculator.');
  });

  it('should keep a budget-exhausted run honest when the final answer call fails', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
      { throws: new Error('HTTP 400 from the provider') },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn, maxSteps: 1 }));

    expect(trace.status).toBe('budget-exhausted');
    expect(trace.error).toContain('HTTP 400');
    expect(events.some((event) => event.type === 'notice' && event.code === 'final-answer-call-failed')).toBe(true);
    // The evidence it did gather is still in the trace.
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
  });
});

describe('agent loop — provider rejects the model tool call', () => {
  it('should recover the intended tool, run it, and keep going', async () => {
    const chat = scriptedChat([
      {
        throws: new GroqToolUseError(
          '{}',
          '{"name": "calc...", "arguments": {"expression": "6*7"}}',
          "attempted to call tool 'calc...' which was not in request.tools",
        ),
      },
      { content: 'It is 42, from the calculator.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn, maxSteps: 4 }));

    expect(
      events.some((event) => event.type === 'notice' && event.code === 'provider-rejected-tool-call'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'notice' && event.code === 'tool-name-recovered')).toBe(true);

    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.tool).toBe('calculator');
    expect(result?.type === 'tool_result' && result.observation).toContain('42');
    expect(trace.status).toBe('completed');
    expect(trace.answer).toBe('It is 42, from the calculator.');
  });

  it('should tell the model the exact valid names when the intent cannot be recovered', async () => {
    const chat = scriptedChat([
      {
        throws: new GroqToolUseError('{}', '{"name":"launch_missiles","arguments":{}}', 'not in request.tools'),
      },
      { content: 'Answering without tools.' },
    ]);
    const { trace, events } = await drain(baseOptions({ chat: chat.fn, maxSteps: 4 }));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
    const correction = chat.requests[1]?.messages.at(-1);
    expect(correction?.role).toBe('user');
    expect(correction?.content).toContain('calculator');
    expect(correction?.content).toContain('current_datetime');
    expect(trace.status).toBe('completed');
  });

  it('should never append a message referencing a tool_call the provider refused', async () => {
    const chat = scriptedChat([
      {
        throws: new GroqToolUseError('{}', '{"name": "calc...", "arguments": {"expression":"1+1"}}', 'rejected'),
      },
      { content: 'Two.' },
    ]);
    await drain(baseOptions({ chat: chat.fn, maxSteps: 4 }));
    const followUp = chat.requests[1]?.messages ?? [];
    expect(followUp.some((message) => message.role === 'tool')).toBe(false);
    expect(followUp.some((message) => message.tool_calls !== undefined)).toBe(false);
  });
});
