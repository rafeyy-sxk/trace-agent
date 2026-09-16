import { z } from 'zod/v4';
import { evaluateExpression } from '../math/expression';
import type { Tool } from './types';

export const calculatorSchema = z.object({
  expression: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'An arithmetic expression, e.g. "(1200 + 340) / 7" or "sqrt(2) * 10". ' +
        'Supports + - * / % ^, parentheses, and the functions ' +
        'sqrt abs min max floor ceil round ln log exp sin cos tan, ' +
        'plus the constants pi and e.',
    ),
});

export type CalculatorArgs = z.infer<typeof calculatorSchema>;

export interface CalculatorResult {
  readonly expression: string;
  readonly value: number;
  /** Rendered with thousands separators for the UI. */
  readonly formatted: string;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    return value.toLocaleString('en-US');
  }
  const rounded = Number(value.toPrecision(12));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

export const calculatorTool: Tool<CalculatorArgs, CalculatorResult> = {
  name: 'calculator',
  title: 'Calculator',
  description:
    'Evaluate an arithmetic expression exactly. Use this for every calculation ' +
    'instead of doing arithmetic yourself — it does not guess. Supports + - * / % ^, ' +
    'parentheses, sqrt/abs/min/max/floor/ceil/round/ln/log/exp/sin/cos/tan/pow, and pi/e.',
  schema: calculatorSchema,
  timeoutMs: 1_000,
  async execute(args) {
    const value = evaluateExpression(args.expression);
    return { expression: args.expression, value, formatted: formatNumber(value) };
  },
  observe(result) {
    return `${result.expression} = ${result.formatted}`;
  },
};
