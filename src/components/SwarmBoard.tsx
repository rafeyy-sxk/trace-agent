'use client';

import { useState } from 'react';
import { formatDuration, formatTokens } from '@/lib/ui/format';
import {
  AGENT_STATE_LABEL,
  AGENT_STATE_TONE,
  type AgentBoardEntry,
  type SwarmBoardState,
} from '@/lib/ui/swarm-state';
import { TraceView } from './TraceView';
import { Badge, CopyButton, Disclosure, Stat } from './primitives';

/** The rolling token window, drawn as the thing it is: a ceiling being approached. */
function BudgetMeter({ state }: { state: SwarmBoardState }) {
  const budget = state.budget;
  const ceiling = budget?.ceiling ?? state.tokenCeiling;
  const spent = budget?.spentInWindow ?? 0;
  const ratio = ceiling > 0 ? Math.min(1, spent / ceiling) : 0;
  const tone = ratio > 0.9 ? 'var(--danger)' : ratio > 0.65 ? 'var(--warn)' : 'var(--ok)';

  return (
    <div className="surface rounded-lg px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold">Token budget</span>
        <span className="faint text-[11px]">rolling 60 second window</span>
        <span className="mono ml-auto text-sm font-semibold tabular-nums">
          {formatTokens(spent)}{' '}
          <span className="faint font-normal">/ {formatTokens(ceiling)}</span>
        </span>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--bg-subtle)' }}
        role="meter"
        aria-valuenow={spent}
        aria-valuemin={0}
        aria-valuemax={ceiling}
        aria-label="Tokens spent in the last 60 seconds"
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${ratio * 100}%`, background: tone }}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        <Stat label="Running" value={String(budget?.running ?? 0)} />
        <Stat label="Held at gate" value={String(budget?.waitingOnBudget ?? 0)} />
        <Stat label="Queued" value={String(budget?.queued ?? 0)} />
        <Stat label="Concurrency cap" value={String(state.concurrency)} />
        {budget && budget.cooldownMs > 0 ? (
          <Stat label="Cooldown" value={formatDuration(budget.cooldownMs)} hint="after a 429" />
        ) : null}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  expanded,
  onToggle,
}: {
  agent: AgentBoardEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tone = AGENT_STATE_TONE[agent.state];
  const isLive = agent.state === 'running' || agent.state === 'waiting-on-budget';

  return (
    <div
      className="surface enter overflow-hidden rounded-lg"
      style={{
        borderColor:
          agent.state === 'failed'
            ? 'var(--danger)'
            : agent.state === 'done'
              ? 'var(--ok)'
              : 'var(--border)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="focus-ring w-full px-3 py-2.5 text-left transition-colors hover:brightness-95"
      >
        <div className="flex items-start gap-2">
          <span className="faint mono mt-0.5 text-[10px] tabular-nums">
            {String(agent.index + 1).padStart(2, '0')}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{agent.title}</div>
            <div className="faint mt-0.5 line-clamp-2 text-[11px] leading-snug">{agent.goal}</div>
          </div>
          <Badge tone={tone}>
            {isLive ? <span className="live-dot">● {AGENT_STATE_LABEL[agent.state]}</span> : AGENT_STATE_LABEL[agent.state]}
          </Badge>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
          <span className="faint mono tabular-nums">step {agent.currentStep}</span>
          <span className="faint mono tabular-nums">{agent.toolCalls} tool calls</span>
          <span className="faint mono tabular-nums">{formatTokens(agent.usage.totalTokens)} tok</span>
          {agent.attempt > 1 ? <Badge tone="warn">attempt {agent.attempt}</Badge> : null}
          {agent.rateLimitHits > 0 ? <Badge tone="warn">{agent.rateLimitHits}× 429</Badge> : null}
          {agent.currentTool ? <Badge tone="accent" mono>{agent.currentTool}</Badge> : null}
          {agent.wallMs > 0 ? (
            <span className="faint mono ml-auto tabular-nums">{formatDuration(agent.wallMs)}</span>
          ) : null}
        </div>

        {agent.detail && agent.state !== 'done' ? (
          <div className="faint mt-1.5 line-clamp-2 text-[10px]">{agent.detail}</div>
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t px-3 py-3">
          {agent.answer ? (
            <div className="mb-3">
              <div className="faint mb-1 text-[10px] font-medium uppercase tracking-wider">
                Answer
              </div>
              <div className="whitespace-pre-wrap text-[12px] leading-relaxed">{agent.answer}</div>
            </div>
          ) : null}
          {agent.error ? (
            <div className="mb-3 text-[11px]" style={{ color: 'var(--danger)' }}>
              {agent.error}
            </div>
          ) : null}
          <Disclosure summary="Full trace" count={agent.events.length}>
            <TraceView events={agent.events} live={agent.state === 'running'} compact />
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}

function Ledger({ state }: { state: SwarmBoardState }) {
  const ledger = state.report?.ledger;
  if (!ledger) return null;
  return (
    <div className="surface rounded-lg px-4 py-3">
      <div className="mb-3 text-xs font-semibold">Run ledger</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Dispatched" value={String(ledger.dispatched)} />
        <Stat label="Completed" value={String(ledger.completed)} />
        <Stat label="Failed" value={String(ledger.failed)} />
        <Stat label="Cancelled" value={String(ledger.cancelled)} />
        <Stat label="429s seen" value={String(ledger.rateLimitHits)} />
        <Stat
          label="Retries absorbed"
          value={String(ledger.retriesAbsorbed)}
          hint="extra attempts by agents that then succeeded"
        />
        <Stat
          label="Max concurrency"
          value={`${ledger.maxConcurrencyReached} / ${ledger.configuredConcurrency}`}
          hint="measured, not configured"
        />
        <Stat label="Wall clock" value={formatDuration(ledger.wallMs)} />
        <Stat label="Model calls" value={String(ledger.modelCalls)} />
        <Stat label="Tool calls" value={String(ledger.toolCalls)} />
        <Stat label="Total tokens" value={formatTokens(ledger.usage.totalTokens)} />
        <Stat
          label="Peak in window"
          value={`${formatTokens(ledger.peakTokensInWindow)} / ${formatTokens(ledger.tokenCeiling)}`}
          hint={`provider limit ${formatTokens(ledger.declaredTokenLimit)}`}
        />
        <Stat
          label="Time held at gate"
          value={formatDuration(ledger.budgetWaitMs)}
          hint="summed across agents"
        />
      </div>
    </div>
  );
}

export function SwarmBoard({ state, live }: { state: SwarmBoardState; live: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (state.agents.length === 0 && !state.swarmId) return null;

  const done = state.agents.filter((agent) => agent.state === 'done').length;
  const failed = state.agents.filter((agent) => agent.state === 'failed').length;

  return (
    <div className="space-y-4">
      <div className="surface flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg px-4 py-3">
        <Stat label="Agents" value={String(state.agents.length)} />
        <Stat label="Done" value={String(done)} />
        <Stat label="Failed" value={String(failed)} />
        <Stat label="Model" value={state.model || '—'} />
        {state.planSource ? (
          <Stat
            label="Plan"
            value={state.planSource === 'model' ? 'model-written' : 'deterministic fallback'}
            {...(state.planError ? { hint: state.planError } : {})}
          />
        ) : null}
        {live ? (
          <div className="ml-auto">
            <Badge tone="info">
              <span className="live-dot">● live</span>
            </Badge>
          </div>
        ) : null}
      </div>

      <BudgetMeter state={state} />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {state.agents.map((agent) => (
          <AgentCard
            key={agent.agentId}
            agent={agent}
            expanded={expanded === agent.agentId}
            onToggle={() => setExpanded(expanded === agent.agentId ? null : agent.agentId)}
          />
        ))}
      </div>

      {state.merged ? (
        <div
          className="rounded-lg border p-4"
          style={{ borderColor: 'var(--ok)', background: 'var(--ok-soft)' }}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ok)' }}>
              Merged answer
            </span>
            <Badge tone={state.merged.synthesized ? 'accent' : 'neutral'}>
              {state.merged.synthesized ? 'synthesised by a model call' : 'assembled without a model call'}
            </Badge>
            <div className="ml-auto">
              <CopyButton value={state.merged.text} />
            </div>
          </div>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{state.merged.text}</div>
        </div>
      ) : null}

      <Ledger state={state} />

      {state.streamError ? (
        <div
          className="rounded-lg border p-3 text-[12px]"
          style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)', color: 'var(--danger)' }}
        >
          {state.streamError}
        </div>
      ) : null}
    </div>
  );
}
