'use client';

import type { TraceEvent } from '@/lib/agent/types';
import { formatDuration, formatOffset, formatTokens, hostOf, prettyJson, truncateMiddle } from '@/lib/ui/format';
import { groupTrace, STATUS_TONE, type StepGroup } from '@/lib/ui/group';
import { Badge, CopyButton, Disclosure, JsonBlock, Stat } from './primitives';

const TOOL_LABEL: Record<string, string> = {
  wikipedia: 'Wikipedia',
  fetch_url: 'Fetch URL',
  arxiv_search: 'arXiv',
  calculator: 'Calculator',
  current_datetime: 'Date & time',
};

function ToolCallCard({
  call,
  startedAt,
}: {
  call: StepGroup['calls'][number];
  startedAt: number;
}) {
  const result = call.result;
  const failed = result !== null && !result.ok;

  return (
    <div
      className="enter rounded-md border"
      style={{
        borderColor: failed ? 'var(--danger)' : 'var(--border)',
        background: 'var(--surface-raised)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <Badge tone={failed ? 'danger' : 'accent'} mono>
          {TOOL_LABEL[call.tool] ?? call.tool}
        </Badge>
        {result === null ? (
          <span className="faint live-dot text-[11px]">running…</span>
        ) : (
          <>
            <span className="faint mono text-[11px] tabular-nums">
              {formatDuration(result.durationMs)}
            </span>
            {failed ? (
              <Badge tone="danger">{result.error?.kind ?? 'failed'}</Badge>
            ) : (
              <Badge tone="ok">ok</Badge>
            )}
            <span className="faint mono ml-auto text-[10px] tabular-nums">
              {formatOffset(result.at, startedAt)}
            </span>
          </>
        )}
      </div>

      <div className="space-y-2 px-2.5 pb-2.5">
        <div>
          <div className="faint mb-1 text-[10px] font-medium uppercase tracking-wider">
            Arguments
          </div>
          <JsonBlock text={prettyJson(call.args ?? {})} maxHeight={160} />
        </div>

        {result ? (
          <>
            <div>
              <div className="faint mb-1 text-[10px] font-medium uppercase tracking-wider">
                {failed ? 'Error returned to the model' : 'Observation the model saw'}
              </div>
              <JsonBlock text={result.observation} maxHeight={220} />
            </div>
            {result.ok && result.result !== undefined ? (
              <Disclosure summary="Raw typed result">
                <JsonBlock text={prettyJson(result.result)} maxHeight={320} />
              </Disclosure>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function StepCard({ group, startedAt }: { group: StepGroup; startedAt: number }) {
  return (
    <li className="enter relative pl-7">
      <span
        className="absolute left-0 top-1 grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
      >
        {group.step}
      </span>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Step {group.step}</span>
        {group.modelLatencyMs !== null ? (
          <span className="faint mono text-[11px] tabular-nums">
            model {formatDuration(group.modelLatencyMs)}
          </span>
        ) : null}
        {group.usage ? (
          <span className="faint mono text-[11px] tabular-nums">
            {formatTokens(group.usage.promptTokens)} in · {formatTokens(group.usage.completionTokens)} out
          </span>
        ) : null}
        {group.finishReason ? <Badge>{group.finishReason}</Badge> : null}
      </div>

      {group.notices.map((notice, index) => (
        <div
          key={`${notice.code}-${index}`}
          className="mb-2 rounded-md px-2.5 py-1.5 text-[11px]"
          style={{
            background: notice.level === 'warn' ? 'var(--warn-soft)' : 'var(--info-soft)',
            color: notice.level === 'warn' ? 'var(--warn)' : 'var(--info)',
          }}
        >
          <span className="mono font-semibold">{notice.code}</span> — {notice.message}
        </div>
      ))}

      {group.thought ? (
        <div className="mb-2">
          <Disclosure summary="Model reasoning" defaultOpen>
            <div
              className="whitespace-pre-wrap rounded-md px-2.5 py-2 text-[12px] leading-relaxed"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
            >
              {group.thought}
            </div>
          </Disclosure>
        </div>
      ) : null}

      <div className="space-y-2">
        {group.calls.map((call) => (
          <ToolCallCard key={call.callId} call={call} startedAt={startedAt} />
        ))}
      </div>
    </li>
  );
}

export function TraceView({
  events,
  live,
  compact = false,
}: {
  events: readonly TraceEvent[];
  live: boolean;
  compact?: boolean;
}) {
  const trace = groupTrace(events);
  const startedAt = trace.header?.at ?? events[0]?.at ?? Date.now();

  if (!trace.header && events.length === 0) return null;

  return (
    <div className="space-y-4">
      {!compact && trace.header ? (
        <div className="surface flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg px-4 py-3">
          <Stat label="Model" value={trace.header.model} />
          <Stat label="Step budget" value={String(trace.header.maxSteps)} />
          <Stat label="Steps used" value={String(trace.steps.length)} />
          <Stat label="Tokens" value={formatTokens(trace.usage.totalTokens)} />
          {trace.finished ? (
            <>
              <Stat label="Wall clock" value={formatDuration(trace.finished.wallMs)} />
              <Stat label="Tool calls" value={String(trace.finished.toolCalls)} />
            </>
          ) : null}
          <div className="ml-auto">
            <Badge tone={STATUS_TONE[trace.status]}>
              {live && trace.status === 'running' ? (
                <span className="live-dot">● running</span>
              ) : (
                trace.status
              )}
            </Badge>
          </div>
        </div>
      ) : null}

      <ol className="space-y-5">
        {trace.steps.map((group) => (
          <StepCard key={group.step} group={group} startedAt={startedAt} />
        ))}
      </ol>

      {trace.finalAnswer ? (
        <div
          className="enter rounded-lg border p-4"
          style={{ borderColor: 'var(--ok)', background: 'var(--ok-soft)' }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ok)' }}>
              Final answer
            </span>
            <span className="faint mono text-[11px]">step {trace.finalAnswer.step}</span>
            <div className="ml-auto">
              <CopyButton value={trace.finalAnswer.text} />
            </div>
          </div>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
            {trace.finalAnswer.text}
          </div>

          {trace.finalAnswer.toolsUsed.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="faint text-[10px] font-medium uppercase tracking-wider">
                Tools used
              </span>
              {trace.finalAnswer.toolsUsed.map((tool) => (
                <Badge key={tool} mono>
                  {TOOL_LABEL[tool] ?? tool}
                </Badge>
              ))}
            </div>
          ) : null}

          {trace.finalAnswer.citations.length > 0 ? (
            <div className="mt-3">
              <div className="faint mb-1.5 text-[10px] font-medium uppercase tracking-wider">
                Sources the tools actually returned
              </div>
              <ul className="space-y-1">
                {trace.finalAnswer.citations.map((citation) => (
                  <li key={citation.url} className="text-[11px] leading-snug">
                    <a
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="focus-ring underline decoration-dotted underline-offset-2"
                      style={{ color: 'var(--accent-text)' }}
                    >
                      {truncateMiddle(citation.title, 90)}
                    </a>
                    <span className="faint mono ml-1.5">{hostOf(citation.url)}</span>
                    <span className="faint ml-1.5">via {citation.tool}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {trace.finished?.error ? (
        <div
          className="rounded-lg border p-3 text-[12px]"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)', color: 'var(--danger)' }}
        >
          {trace.finished.error}
        </div>
      ) : null}
    </div>
  );
}
