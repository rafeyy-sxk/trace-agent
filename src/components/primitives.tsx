'use client';

import { useEffect, useState } from 'react';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

const TONE_STYLE: Record<Tone, { background: string; color: string; border: string }> = {
  neutral: { background: 'var(--bg-subtle)', color: 'var(--text-muted)', border: 'var(--border)' },
  accent: { background: 'var(--accent-soft)', color: 'var(--accent-text)', border: 'transparent' },
  ok: { background: 'var(--ok-soft)', color: 'var(--ok)', border: 'transparent' },
  warn: { background: 'var(--warn-soft)', color: 'var(--warn)', border: 'transparent' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', border: 'transparent' },
  info: { background: 'var(--info-soft)', color: 'var(--info)', border: 'transparent' },
};

export function Badge({
  children,
  tone = 'neutral',
  mono = false,
}: {
  children: React.ReactNode;
  tone?: Tone;
  mono?: boolean;
}) {
  const style = TONE_STYLE[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap ${mono ? 'mono' : ''}`}
      style={{ background: style.background, color: style.color, border: `1px solid ${style.border}` }}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="faint text-[10px] font-medium uppercase tracking-wider">{label}</span>
      <span className="mono text-sm font-semibold tabular-nums">{value}</span>
      {hint ? <span className="faint text-[10px]">{hint}</span> : null}
    </div>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('trace-agent-theme', next);
    } catch {
      // Private mode. The theme still applies for this page.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="focus-ring surface grid h-8 w-8 place-items-center rounded-md transition-colors hover:brightness-95"
    >
      <span aria-hidden className="text-xs">
        {theme === 'dark' ? '☀' : '☾'}
      </span>
    </button>
  );
}

/** A copy button that confirms in place rather than firing a toast. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="focus-ring rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:brightness-95"
      style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  count,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-[11px] font-medium select-none">
        <span aria-hidden className="faint inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="muted">{summary}</span>
        {count !== undefined ? <span className="faint mono">({count})</span> : null}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

export function JsonBlock({ text, maxHeight = 320 }: { text: string; maxHeight?: number }) {
  return (
    <pre
      className="scroll-thin mono overflow-auto rounded-md p-2.5 text-[11px] leading-relaxed"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', maxHeight }}
    >
      {text}
    </pre>
  );
}
