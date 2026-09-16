import type { AnyTool } from '../tools/types';

export interface PromptOptions {
  readonly maxSteps: number;
  readonly tools: readonly AnyTool[];
  /** Extra guidance for swarm sub-agents, which answer a slice of a goal. */
  readonly role?: string;
}

/**
 * The system prompt.
 *
 * Kept short on purpose. Every token here is paid on every step of every
 * agent, and with a shared 8k-tokens-per-minute ceiling across a swarm the
 * system prompt is a fixed tax on throughput. Tool descriptions carry the
 * selection guidance instead — they are sent as structured specs either way.
 */
export function buildSystemPrompt(options: PromptOptions): string {
  const toolList = options.tools.map((tool) => `- ${tool.name}: ${tool.title}`).join('\n');
  return [
    'You are a research agent. You answer by gathering evidence with tools, not from memory.',
    '',
    'Rules:',
    `1. You have at most ${options.maxSteps} tool-calling steps. Spend them deliberately.`,
    '2. Call a tool whenever a fact could have changed, could be wrong, or needs a source.',
    '3. Never do arithmetic in your head. Use the calculator tool.',
    '4. Never state a date or "current" fact without checking it with a tool first.',
    '5. When a tool fails, read the error and try a different tool or different arguments. Do not repeat the same failing call.',
    '6. You may call several tools in one step when they do not depend on each other.',
    '7. When you have enough evidence, stop calling tools and write the final answer.',
    '',
    'The final answer must:',
    '- answer the question directly in the first sentence,',
    '- state the numbers you found and where each one came from,',
    '- list the source URLs the tools returned,',
    '- say plainly if something could not be verified.',
    '',
    'Available tools:',
    toolList,
    options.role ? `\n${options.role}` : '',
  ]
    .filter((line) => line !== null)
    .join('\n')
    .trim();
}

/**
 * The forced final answer runs on a FRESH conversation, not the tool-calling
 * history.
 *
 * Verified live against Groq on 2026-09-16: re-sending a transcript that
 * contains `tool_calls` while omitting the `tools` field makes the provider
 * infer `tool_choice: none`, the model emits a tool call anyway, and the
 * request fails with HTTP 400 "Tool choice is none, but model called a tool".
 * Replaying the evidence as plain text removes the tool channel entirely, and
 * costs fewer tokens than the transcript it replaces.
 */
export function buildAnswerOnlySystemPrompt(): string {
  return [
    'You are a research agent writing your final answer.',
    'You have no tools available now. Use only the evidence given to you.',
    '',
    'The answer must:',
    '- answer the question directly in the first sentence,',
    '- state the numbers found and which source each came from,',
    '- list the source URLs that appear in the evidence,',
    '- say plainly which parts could not be verified. Never fill a gap with a guess.',
  ].join('\n');
}

export function buildForcedAnswerPrompt(
  goal: string,
  maxSteps: number,
  evidence: readonly string[],
): string {
  const body =
    evidence.length > 0
      ? evidence.join('\n\n---\n\n')
      : '(no tool returned any usable evidence)';
  return [
    `QUESTION: ${goal}`,
    '',
    `You used all ${maxSteps} tool steps. This is everything the tools returned:`,
    '',
    body,
    '',
    'Write the final answer now.',
  ].join('\n');
}

/** Sent when a turn produced nothing usable. */
export function buildRecoveryPrompt(problems: readonly string[]): string {
  return [
    'Your last message could not be used.',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Either call a tool using the tool-calling interface, or write the final answer as plain text. Do not describe a tool call in prose.',
  ].join('\n');
}
