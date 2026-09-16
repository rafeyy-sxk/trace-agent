import { emptyUsage } from '../agent/types';
import { GroqRateLimitError, type ChatFn, type TokenUsage } from '../groq/types';
import type { TokenBudget } from './budget';
import { estimateCallTokens, type BudgetGate } from './gate';

const MERGE_ANSWER_CHARS = 900;

/** The minimum an agent must expose to be merged. */
export interface MergeContribution {
  readonly id: string;
  readonly title: string;
  readonly answer: string | null;
}

export interface MergeOptions {
  readonly goal: string;
  readonly records: readonly MergeContribution[];
  readonly model: string;
  readonly chat: ChatFn;
  readonly gate: BudgetGate;
  readonly budget: TokenBudget;
  readonly toolSpecTokens: number;
  readonly synthesize: boolean;
  readonly signal?: AbortSignal;
}

export interface MergeResult {
  readonly text: string;
  readonly contributingAgents: readonly string[];
  readonly synthesized: boolean;
  readonly usage: TokenUsage;
}

/**
 * Assemble the final answer.
 *
 * The deterministic merge always exists and is always correct: it is the
 * agents' own answers with attribution. Synthesis is one extra model call on
 * top of that, and if it fails the deterministic merge is what ships — the
 * merged answer is never missing because a nice-to-have call was rate limited.
 */
export async function mergeAnswers(options: MergeOptions): Promise<MergeResult | null> {
  const successful = options.records.filter(
    (record) => record.answer !== null && record.answer.trim().length > 0,
  );
  if (successful.length === 0) return null;

  const contributingAgents = successful.map((record) => record.id);
  const sections = successful.map(
    (record) =>
      `### ${record.title}  \n_${record.id}_\n\n${record.answer as string}`,
  );
  const deterministic = [
    `**${successful.length} of ${options.records.length} agents returned an answer.**`,
    '',
    ...sections,
  ].join('\n\n');

  if (!options.synthesize) {
    return {
      text: deterministic,
      contributingAgents,
      synthesized: false,
      usage: emptyUsage(),
    };
  }

  const digest = successful
    .map(
      (record) =>
        `[${record.id}] ${record.title}: ${(record.answer as string).slice(0, MERGE_ANSWER_CHARS)}`,
    )
    .join('\n\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        'You merge findings from parallel research agents into one answer. ' +
        'Use only what the agents reported. Cite the agent id in square brackets after each claim. ' +
        'If agents disagree, say so explicitly instead of picking one.',
    },
    {
      role: 'user' as const,
      content: `QUESTION: ${options.goal}\n\nAGENT FINDINGS:\n\n${digest}\n\nWrite the merged answer.`,
    },
  ];

  const maxTokens = 900;
  const estimate = estimateCallTokens(messages, maxTokens, 0);
  try {
    const reservation = await options.gate.acquire(estimate, options.signal);
    try {
      const response = await options.chat({
        model: options.model,
        messages,
        temperature: 0.2,
        maxTokens,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.budget.settle(reservation, response.usage.totalTokens);
      const text = response.content.trim();
      if (text.length === 0) throw new Error('synthesis returned nothing');
      return {
        text: `${text}\n\n---\n\n<details><summary>Per-agent findings</summary>\n\n${deterministic}\n\n</details>`,
        contributingAgents,
        synthesized: true,
        usage: response.usage,
      };
    } catch (error) {
      if (error instanceof GroqRateLimitError) {
        options.budget.settle(reservation, estimate);
        options.budget.penalise(error.retryAfterMs);
      } else {
        options.budget.release(reservation);
      }
      throw error;
    }
  } catch {
    return {
      text: deterministic,
      contributingAgents,
      synthesized: false,
      usage: emptyUsage(),
    };
  }
}
