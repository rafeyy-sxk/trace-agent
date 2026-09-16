'use client';

import { LIMITS } from '@/lib/config';
import type { Mode } from './types';

export interface RunSettings {
  readonly goal: string;
  readonly maxSteps: number;
  readonly agents: number;
  readonly concurrency: number;
  readonly maxStepsPerAgent: number;
}

const EXAMPLES: Record<Mode, readonly string[]> = {
  single: [
    'What is the current population of Tokyo and how does it compare to New York, with sources',
    'How many days until the next summer solstice, and what is that in hours',
    'Find two recent arXiv papers on speculative decoding and summarise what they claim',
  ],
  swarm: [
    'Give me a complete briefing on the current state of nuclear fusion energy',
    'Everything that matters about the Antikythera mechanism',
    'A full picture of how large language models are trained today',
  ],
};

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="faint text-[10px] font-medium uppercase tracking-wider">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className="focus-ring mono w-full rounded-md border px-2 py-1.5 text-xs tabular-nums disabled:opacity-50"
        style={{ background: 'var(--surface)', color: 'var(--text)' }}
      />
      {hint ? <span className="faint text-[10px]">{hint}</span> : null}
    </label>
  );
}

export function GoalForm({
  mode,
  onModeChange,
  settings,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  settings: RunSettings;
  onChange: (settings: RunSettings) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = <K extends keyof RunSettings>(key: K, value: RunSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <form
      className="surface space-y-3 rounded-xl p-4"
      style={{ boxShadow: 'var(--shadow)' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <div
        className="inline-flex rounded-lg p-0.5"
        style={{ background: 'var(--bg-subtle)' }}
        role="tablist"
        aria-label="Run mode"
      >
        {(['single', 'swarm'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={mode === candidate}
            disabled={busy}
            onClick={() => onModeChange(candidate)}
            className="focus-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={
              mode === candidate
                ? { background: 'var(--surface)', color: 'var(--text)', boxShadow: 'var(--shadow)' }
                : { color: 'var(--text-muted)' }
            }
          >
            {candidate === 'single' ? 'One agent' : 'Swarm'}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="goal" className="faint mb-1 block text-[10px] font-medium uppercase tracking-wider">
          Goal
        </label>
        <textarea
          id="goal"
          rows={3}
          value={settings.goal}
          maxLength={LIMITS.goalMaxChars}
          disabled={busy}
          placeholder={
            mode === 'single'
              ? 'Ask something that needs looking up…'
              : 'Ask something broad enough to split across many agents…'
          }
          onChange={(event) => update('goal', event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className="focus-ring w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed disabled:opacity-60"
          style={{ background: 'var(--surface)', color: 'var(--text)' }}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES[mode].map((example) => (
          <button
            key={example}
            type="button"
            disabled={busy}
            onClick={() => update('goal', example)}
            className="focus-ring rounded border px-2 py-1 text-left text-[11px] transition-colors hover:brightness-95 disabled:opacity-50"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
          >
            {example.length > 62 ? `${example.slice(0, 62)}…` : example}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {mode === 'single' ? (
          <NumberField
            label="Step budget"
            value={settings.maxSteps}
            min={1}
            max={LIMITS.singleRunMaxSteps}
            disabled={busy}
            onChange={(value) => update('maxSteps', value)}
            hint="hard cap on tool rounds"
          />
        ) : (
          <>
            <NumberField
              label="Agents"
              value={settings.agents}
              min={1}
              max={LIMITS.swarmMaxAgents}
              disabled={busy}
              onChange={(value) => update('agents', value)}
              hint={`up to ${LIMITS.swarmMaxAgents}`}
            />
            <NumberField
              label="Concurrency"
              value={settings.concurrency}
              min={1}
              max={LIMITS.swarmMaxConcurrency}
              disabled={busy}
              onChange={(value) => update('concurrency', value)}
              hint="agent loops live at once"
            />
            <NumberField
              label="Steps / agent"
              value={settings.maxStepsPerAgent}
              min={1}
              max={LIMITS.swarmMaxStepsPerAgent}
              disabled={busy}
              onChange={(value) => update('maxStepsPerAgent', value)}
              hint="fewer steps, more agents"
            />
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || settings.goal.trim().length < 3}
          className="focus-ring rounded-md px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {busy ? 'Running…' : mode === 'single' ? 'Run agent' : `Run ${settings.agents} agents`}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring rounded-md border px-3 py-2 text-xs font-medium"
            style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
        ) : null}
        <span className="faint hidden text-[10px] sm:inline">⌘↵ to run</span>
      </div>
    </form>
  );
}
