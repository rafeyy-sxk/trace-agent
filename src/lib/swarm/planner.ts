import { z } from 'zod/v4';
import type { ChatFn } from '../groq/types';
import { parseJsonLoose } from '../agent/parse';
import type { SubGoal } from './types';

/**
 * Split one goal into N independent sub-goals.
 *
 * "Independent" is the load-bearing word: the agents run in parallel and never
 * see each other's output, so a plan with a dependency in it produces an agent
 * researching something it cannot know yet. The prompt says so, and the
 * deterministic fallback below is independent by construction.
 */

const planSchema = z.object({
  subgoals: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        goal: z.string().min(8).max(400),
      }),
    )
    .min(1),
});

export const MAX_AGENTS = 100;

/**
 * Angles used when the model cannot produce a plan. Not filler: each one is a
 * genuinely different research question, so a fallback swarm still returns
 * different findings per agent rather than N copies of one search.
 */
const FALLBACK_ANGLES: readonly { title: string; lens: string }[] = [
  { title: 'Core facts', lens: 'Establish the core facts and definitions, with sources.' },
  { title: 'Key numbers', lens: 'Find the most important quantities and figures, with sources and dates.' },
  { title: 'History', lens: 'Trace how this came to be, with dates and sources.' },
  { title: 'Current state', lens: 'Establish the present-day situation as of today, with sources.' },
  { title: 'Comparisons', lens: 'Compare this against the closest comparable cases, with sources.' },
  { title: 'Causes', lens: 'Identify the causes and drivers behind this, with sources.' },
  { title: 'Effects', lens: 'Identify the consequences and downstream effects, with sources.' },
  { title: 'Criticism', lens: 'Find the strongest criticisms, objections or counter-evidence, with sources.' },
  { title: 'Research', lens: 'Find scientific papers or technical literature on this, with citations.' },
  { title: 'Geography', lens: 'Establish where this applies and how it differs by place, with sources.' },
  { title: 'People', lens: 'Identify the people and organisations central to this, with sources.' },
  { title: 'Terminology', lens: 'Define the specialist terms involved and how they are used, with sources.' },
  { title: 'Data sources', lens: 'Identify the authoritative datasets or primary sources on this and what they say.' },
  { title: 'Common errors', lens: 'Find widely repeated claims about this that are wrong, and the correction.' },
  { title: 'Open questions', lens: 'Identify what is genuinely unsettled or disputed, with sources.' },
  { title: 'Timeline', lens: 'Build a dated timeline of the most significant events, with sources.' },
  { title: 'Scale', lens: 'Establish the magnitude and scale involved, with numbers and sources.' },
  { title: 'Outlook', lens: 'Find documented projections or forecasts, with sources and their dates.' },
];

export function fallbackPlan(goal: string, count: number): SubGoal[] {
  const wanted = Math.max(1, Math.min(MAX_AGENTS, count));
  return Array.from({ length: wanted }, (_unused, index) => {
    const angle = FALLBACK_ANGLES[index % FALLBACK_ANGLES.length] as (typeof FALLBACK_ANGLES)[number];
    const round = Math.floor(index / FALLBACK_ANGLES.length);
    const title = round === 0 ? angle.title : `${angle.title} (${round + 1})`;
    return {
      id: `agent_${index + 1}`,
      index,
      title,
      goal: `${angle.lens}\n\nOverall question: ${goal}`,
    };
  });
}

export interface PlanOptions {
  readonly goal: string;
  readonly count: number;
  readonly model: string;
  readonly chat: ChatFn;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
}

export interface PlanResult {
  readonly subGoals: readonly SubGoal[];
  readonly source: 'model' | 'fallback';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly error?: string;
}

function buildPlannerPrompt(goal: string, count: number): string {
  return [
    `Break this research goal into exactly ${count} INDEPENDENT sub-goals.`,
    '',
    `GOAL: ${goal}`,
    '',
    'Rules:',
    '- Each sub-goal must be answerable on its own, without the output of any other sub-goal.',
    '- Each must cover a different angle. No two may be paraphrases of each other.',
    '- Each must be a concrete research instruction, not a topic heading.',
    '- Together they should cover the goal well enough that merging the answers answers it.',
    '',
    'Reply with JSON only, in exactly this shape, and nothing else:',
    '{"subgoals":[{"title":"short label","goal":"the full research instruction"}]}',
  ].join('\n');
}

/**
 * Ask the model for a plan. Always returns a usable plan of exactly `count`
 * sub-goals: a model failure downgrades to the deterministic angles rather
 * than failing the run, and `source` records which happened.
 */
export async function planSubGoals(options: PlanOptions): Promise<PlanResult> {
  const count = Math.max(1, Math.min(MAX_AGENTS, options.count));
  if (count === 1) {
    return {
      subGoals: [{ id: 'agent_1', index: 0, title: 'Full goal', goal: options.goal }],
      source: 'fallback',
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  try {
    const response = await options.chat({
      model: options.model,
      messages: [
        { role: 'system', content: 'You output JSON only. No prose, no code fences.' },
        { role: 'user', content: buildPlannerPrompt(options.goal, count) },
      ],
      temperature: 0.4,
      maxTokens: options.maxTokens ?? Math.min(4_000, 120 + count * 60),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const parsed = parseJsonLoose(response.content);
    if (!parsed) throw new Error('planner returned no parseable JSON');
    const validated = planSchema.safeParse(parsed.value);
    if (!validated.success) {
      throw new Error(`planner JSON did not match the schema: ${validated.error.issues[0]?.message}`);
    }

    const filled = [...validated.data.subgoals];
    if (filled.length < count) {
      // Top up from the deterministic angles rather than running fewer agents.
      const padding = fallbackPlan(options.goal, count - filled.length);
      filled.push(...padding.map((item) => ({ title: item.title, goal: item.goal })));
    }

    return {
      subGoals: filled.slice(0, count).map((item, index) => ({
        id: `agent_${index + 1}`,
        index,
        title: item.title,
        goal: item.goal,
      })),
      source: 'model',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    };
  } catch (error) {
    return {
      subGoals: fallbackPlan(options.goal, count),
      source: 'fallback',
      promptTokens: 0,
      completionTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
