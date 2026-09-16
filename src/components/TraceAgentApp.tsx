'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunTrace, TraceEvent } from '@/lib/agent/types';
import { LIMITS } from '@/lib/config';
import { decodeTrace, encodeTrace, type ShareFidelity } from '@/lib/share';
import { reduceSwarm, type StreamEnvelope } from '@/lib/ui/swarm-state';
import { useEventStream } from '@/lib/ui/useEventStream';
import { GoalForm, type RunSettings } from './GoalForm';
import { SwarmBoard } from './SwarmBoard';
import { TraceView } from './TraceView';
import { Badge, ThemeToggle } from './primitives';
import type { Mode } from './types';

const DEFAULT_SETTINGS: RunSettings = {
  goal: '',
  maxSteps: LIMITS.singleRunDefaultSteps,
  agents: LIMITS.swarmDefaultAgents,
  concurrency: LIMITS.swarmDefaultConcurrency,
  maxStepsPerAgent: LIMITS.swarmDefaultStepsPerAgent,
};

const SHARE_FIDELITY_NOTE: Record<ShareFidelity, string> = {
  full: 'Link copied. It carries the complete trace.',
  'no-raw-results': 'Link copied. Raw tool payloads were dropped to fit the URL; every step and observation is intact.',
  'trimmed-observations': 'Link copied. Raw payloads were dropped and long observations clipped to fit the URL.',
  'too-large': 'This trace is too large for a URL. Use "Download JSON" instead.',
};

/** Rebuild a RunTrace from the live event list so a finished run can be shared. */
function traceFromEvents(events: readonly TraceEvent[]): RunTrace | null {
  const started = events.find((event) => event.type === 'run_started');
  const finished = events.find((event) => event.type === 'run_finished');
  const answer = events.find((event) => event.type === 'final_answer');
  if (!started || started.type !== 'run_started') return null;
  return {
    version: 1,
    runId: started.runId,
    goal: started.goal,
    model: started.model,
    status: finished?.type === 'run_finished' ? finished.status : 'failed',
    startedAt: started.at,
    finishedAt: finished?.type === 'run_finished' ? finished.at : started.at,
    wallMs: finished?.type === 'run_finished' ? finished.wallMs : 0,
    steps: finished?.type === 'run_finished' ? finished.steps : 0,
    usage:
      finished?.type === 'run_finished'
        ? finished.usage
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    answer: answer?.type === 'final_answer' ? answer.text : null,
    citations: answer?.type === 'final_answer' ? answer.citations : [],
    events,
    ...(finished?.type === 'run_finished' && finished.error ? { error: finished.error } : {}),
  };
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TraceAgentApp() {
  const [mode, setMode] = useState<Mode>('single');
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_SETTINGS);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<RunTrace | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const single = useEventStream<TraceEvent>();
  const swarm = useEventStream<StreamEnvelope>();
  const active = mode === 'single' ? single : swarm;
  const busy = active.state === 'connecting' || active.state === 'streaming';

  // Replay: the trace lives in the URL fragment, so it never reaches a server.
  useEffect(() => {
    const token = window.location.hash.startsWith('#t=') ? window.location.hash.slice(3) : null;
    if (!token) return;
    void decodeTrace(decodeURIComponent(token))
      .then((trace) => {
        setReplayed(trace);
        setMode('single');
        setSettings((current) => ({ ...current, goal: trace.goal }));
      })
      .catch((error: unknown) => {
        setReplayError(error instanceof Error ? error.message : 'The shared trace could not be read.');
      });
  }, []);

  useEffect(() => {
    if (!shareNote) return;
    const timer = setTimeout(() => setShareNote(null), 5_000);
    return () => clearTimeout(timer);
  }, [shareNote]);

  const singleEvents = replayed ? replayed.events : single.events;
  const swarmState = useMemo(() => reduceSwarm(swarm.events), [swarm.events]);

  const run = useCallback(() => {
    setReplayed(null);
    setReplayError(null);
    setShareNote(null);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    if (mode === 'single') {
      void single.start('/api/run', { goal: settings.goal.trim(), maxSteps: settings.maxSteps });
    } else {
      void swarm.start('/api/swarm', {
        goal: settings.goal.trim(),
        agents: settings.agents,
        concurrency: Math.min(settings.concurrency, settings.agents),
        maxStepsPerAgent: settings.maxStepsPerAgent,
      });
    }
  }, [mode, settings, single, swarm]);

  const share = useCallback(async () => {
    const trace = replayed ?? traceFromEvents(single.events);
    if (!trace) {
      setShareNote('There is no finished run to share yet.');
      return;
    }
    const payload = await encodeTrace(trace);
    if (payload.fidelity === 'too-large') {
      setShareNote(SHARE_FIDELITY_NOTE['too-large']);
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}#t=${encodeURIComponent(payload.token)}`;
    window.history.replaceState(null, '', `#t=${encodeURIComponent(payload.token)}`);
    try {
      await navigator.clipboard.writeText(url);
      setShareNote(SHARE_FIDELITY_NOTE[payload.fidelity]);
    } catch {
      setShareNote('The link is now in the address bar; copying to the clipboard was blocked.');
    }
  }, [replayed, single.events]);

  const loadFile = useCallback((file: File) => {
    void file
      .text()
      .then(async (text) => {
        const parsed: unknown = JSON.parse(text);
        const { isRunTrace } = await import('@/lib/share');
        if (!isRunTrace(parsed)) throw new Error('That file is not a trace-agent run.');
        setReplayed(parsed);
        setMode('single');
        setReplayError(null);
      })
      .catch((error: unknown) => {
        setReplayError(error instanceof Error ? error.message : 'That file could not be read.');
      });
  }, []);

  const hasSingleRun = singleEvents.length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="mono text-lg font-bold tracking-tight">trace-agent</h1>
          <p className="muted mt-1 max-w-2xl text-[13px] leading-relaxed">
            A tool-using agent with nothing hidden. Every step is shown as it happens: the model
            reasoning, the tool it picked, the exact arguments, the raw result, the latency and the
            tokens. Swarm mode runs many agents at once under one rolling token budget.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-3 lg:sticky lg:top-6">
          <GoalForm
            mode={mode}
            onModeChange={setMode}
            settings={settings}
            onChange={setSettings}
            onSubmit={run}
            onCancel={active.cancel}
            busy={busy}
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void share()}
              disabled={mode !== 'single' || (!hasSingleRun && !replayed)}
              className="focus-ring rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
              style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}
            >
              Copy share link
            </button>
            <button
              type="button"
              disabled={mode === 'single' ? !hasSingleRun : !swarmState.report}
              onClick={() => {
                if (mode === 'single') {
                  const trace = replayed ?? traceFromEvents(single.events);
                  if (trace) downloadJson(`${trace.runId}.json`, trace);
                } else if (swarmState.report) {
                  downloadJson(`${swarmState.report.swarmId}.json`, swarmState.report);
                }
              }}
              className="focus-ring rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
              style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}
            >
              Download JSON
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="focus-ring rounded-md border px-2.5 py-1.5 text-[11px] font-medium"
              style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}
            >
              Load a trace
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) loadFile(file);
                event.target.value = '';
              }}
            />
          </div>

          {shareNote ? <p className="faint text-[11px] leading-snug">{shareNote}</p> : null}
          {replayError ? (
            <p className="text-[11px] leading-snug" style={{ color: 'var(--danger)' }}>
              {replayError}
            </p>
          ) : null}
          {replayed ? (
            <div className="flex items-center gap-2">
              <Badge tone="info">replay</Badge>
              <span className="faint text-[11px]">
                Showing a saved run, not a live one.
              </span>
            </div>
          ) : null}
        </div>

        <main className="min-w-0">
          {active.error ? (
            <div
              className="mb-4 rounded-lg border p-3 text-[12px]"
              style={{
                borderColor: 'var(--danger)',
                background: 'var(--danger-soft)',
                color: 'var(--danger)',
              }}
            >
              {active.error}
            </div>
          ) : null}

          {mode === 'single' ? (
            hasSingleRun ? (
              <TraceView events={singleEvents} live={busy} />
            ) : (
              <EmptyState mode={mode} />
            )
          ) : swarmState.agents.length > 0 || swarmState.swarmId ? (
            <SwarmBoard state={swarmState} live={busy} />
          ) : (
            <EmptyState mode={mode} />
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyState({ mode }: { mode: Mode }) {
  return (
    <div
      className="rounded-xl border border-dashed px-6 py-12 text-center"
      style={{ borderColor: 'var(--border-strong)' }}
    >
      <p className="text-sm font-medium">
        {mode === 'single' ? 'No run yet' : 'No swarm yet'}
      </p>
      <p className="faint mx-auto mt-2 max-w-md text-[12px] leading-relaxed">
        {mode === 'single'
          ? 'Give the agent a goal. Each step appears here the moment it happens — the reasoning, the tool call with its exact arguments, the raw result, the time and the tokens.'
          : 'Give the swarm a broad goal. It is split into independent sub-goals, each handed to its own agent, and all of their traces stream onto one board under a shared token ceiling.'}
      </p>
    </div>
  );
}
