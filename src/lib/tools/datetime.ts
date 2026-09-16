import { z } from 'zod/v4';
import type { Tool } from './types';

export const datetimeSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('An IANA timezone such as "Asia/Tokyo" or "America/New_York". Defaults to UTC.'),
  offset_days: z
    .number()
    .int()
    .min(-36_500)
    .max(36_500)
    .optional()
    .describe('Shift the answer by this many days. Use -1 for yesterday, 7 for a week out.'),
});

export type DatetimeArgs = z.infer<typeof datetimeSchema>;

export interface DatetimeResult {
  readonly timezone: string;
  readonly iso: string;
  readonly localTime: string;
  readonly date: string;
  readonly weekday: string;
  readonly unixSeconds: number;
  readonly offsetDays: number;
  readonly utcOffset: string;
}

export class UnknownTimezoneError extends Error {
  constructor(timezone: string) {
    super(`"${timezone}" is not a recognised IANA timezone`);
    this.name = 'UnknownTimezoneError';
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new UnknownTimezoneError(timezone);
  }
}

/** "GMT+9" -> "+09:00". Intl gives us the former; humans read the latter. */
function utcOffsetFor(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);
  if (!match) return '+00:00';
  const sign = match[1] as string;
  const hours = (match[2] as string).padStart(2, '0');
  const minutes = match[3] ?? '00';
  return `${sign}${hours}:${minutes}`;
}

const DAY_MS = 86_400_000;

export const datetimeTool: Tool<DatetimeArgs, DatetimeResult> = {
  name: 'current_datetime',
  title: 'Date & Time',
  description:
    'Get the current date and time in any IANA timezone, optionally offset by a ' +
    'number of days. Call this before answering anything that depends on "today", ' +
    '"now", "this year" or a relative date — your training data has a cutoff, this does not.',
  schema: datetimeSchema,
  timeoutMs: 1_000,
  async execute(args, context) {
    const timezone = args.timezone ?? 'UTC';
    assertTimezone(timezone);
    const offsetDays = args.offset_days ?? 0;
    const now = context.now ? context.now() : new Date();
    const target = new Date(now.getTime() + offsetDays * DAY_MS);

    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(target);

    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(target);

    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    }).format(target);

    return {
      timezone,
      iso: target.toISOString(),
      localTime,
      date,
      weekday,
      unixSeconds: Math.floor(target.getTime() / 1000),
      offsetDays,
      utcOffset: utcOffsetFor(target, timezone),
    };
  },
  observe(result) {
    return `${result.weekday} ${result.date} ${result.localTime.split(', ')[1] ?? ''} in ${result.timezone} (UTC${result.utcOffset}) | ISO ${result.iso}`.replace(
      /\s+/g,
      ' ',
    );
  },
};
