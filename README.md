# trace-agent

**A swarm of tool-using agents with nothing hidden.** You give it one goal, it splits that goal
across many agents running in parallel, and every agent's reasoning is rendered live — the thought,
the tool it chose, the exact arguments, the raw result, the latency, the tokens.

The hard part is not fanning out. The hard part is that **Groq's free tier allows 8,000 tokens per
minute**, and naively firing 100 agents at it produces a wall of 429s and a run that never finishes.
So the real feature of this project is the **scheduler that makes the fan-out work anyway**: a
rolling-window token budget that holds agents at a gate instead of letting them get rejected, a
concurrency cap that is measured rather than assumed, and a retry path that honours the provider's
own `retry-after` and never silently drops an agent.

It also runs in single-agent mode, where one agent works one goal and its whole trace is inspectable,
downloadable and replayable from a URL.

---

## The scheduler, which is the point

| Limit | How it is enforced | Where |
|---|---|---|
| **Tokens per minute** | A rolling 60-second window. Every model call reserves a pessimistic upper-bound estimate *before* dispatch and is reconciled against real usage after. A call that would cross the ceiling waits at a FIFO gate. | `src/lib/swarm/budget.ts`, `src/lib/swarm/gate.ts` |
| **Concurrent agents** | A counting semaphore. The ledger reports the **highest concurrency actually observed**, not the number configured. | `src/lib/swarm/concurrency.ts` |
| **Attempts per agent** | A 429 re-queues the whole agent after the provider's own `retry-after`, and puts every other agent behind a cooldown. An agent that exhausts its attempt cap is reported **failed** — never dropped, never left running. | `src/lib/swarm/scheduler.ts` |

Three details that matter:

- **The ceiling calibrates itself.** Groq returns `x-ratelimit-limit-tokens` on every response. The
  budget adopts that number instead of trusting a constant compiled into the app. The fallback of
  8,000 is only used until the first live response arrives.
- **10% headroom by default.** Our window and the provider's window are not phase-aligned. Aiming at
  exactly 100% reliably produces 429s.
- **Estimates are deliberately pessimistic** — 3.2 characters per token plus the full completion cap
  plus the serialised tool specs. Over-counting is the safe direction when the number decides whether
  to dispatch.

### The honest limitation

The ceiling is enforced against **pre-flight estimates**, reconciled against real usage afterwards.
If a call costs materially more than its estimate, the window absorbs the overage and delays the next
dispatch rather than rejecting it retroactively. That is why 429s are still handled properly rather
than assumed away: the gate makes them rare, it does not make them impossible. In the live 20-agent
run below they were not rare.

A second honest limitation: **a re-queued agent restarts from scratch.** Partial progress inside an
agent is not resumed, so an absorbed 429 costs the tokens that agent had already spent.

---

## What is actually here

### Two modes

- **One agent** — plan → act → observe → repeat, with a hard step budget and an explicit stop
  condition. Every step streams to the UI as it happens.
- **Swarm** — a planner splits the goal into N independent sub-goals (N configurable up to 100), each
  gets its own agent, and all of their traces stream onto one live board with a shared token meter
  and a final computed ledger.

### Five tools, all keyless, no API key of any kind

| Tool | What it does |
|---|---|
| `wikipedia` | Search plus the lead summary of the top article, in one call |
| `fetch_url` | Fetch a public page and extract readable text |
| `arxiv_search` | Search arXiv preprints; titles, authors, abstracts, links |
| `calculator` | Exact arithmetic via a hand-written parser — **never `eval`** |
| `current_datetime` | Current date and time in any IANA timezone, with a day offset |

Every tool validates its arguments with **zod**, returns a **typed** result, and has its own timeout.
The JSON Schema shown to the model is **generated from the same zod schema** that validates the call,
so the contract advertised and the contract enforced cannot drift apart.

### Guardrails

- **Step budget.** The loop cannot exceed it. When it runs out, the agent spends one final
  tool-free call to produce a real answer from the evidence it gathered.
- **Per-tool timeout**, plus a wall-clock timeout and a byte cap on every outbound HTTP request.
- **SSRF refusal**, in three layers — see below.
- **A final answer that cites the tool results it used.** Citations are extracted from the tool
  results themselves, not from what the model claims. A model asked to list its sources will invent
  one; a URL physically present in a tool result is a URL the tool really returned.

### SSRF protection

`src/lib/net/ssrf.ts` refuses an outbound URL at three layers, because any one alone is bypassable:

1. **Shape** — scheme must be `http`/`https`; no credentials in the authority; hostname suffixes like
   `localhost`, `.local`, `.internal` and the cloud-metadata hostnames are refused.
2. **Literal** — an IP written into the URL is classified against a readable range table
   (`src/lib/net/ip.ts`): loopback, RFC1918, CGNAT, link-local (including `169.254.169.254`),
   multicast, reserved, IPv6 unique-local, and the IPv4-mapped / NAT64 / 6to4 wrappers used to smuggle
   `127.0.0.1` past a naive v6 check.
3. **DNS** — the hostname is resolved and **every** returned address must be public unicast.

**Redirects are re-validated hop by hop.** A guard that only checks the first URL is not a guard.

### Visible reasoning

`openai/gpt-oss-*` models return a `reasoning` field. That is the text shown as the model's thought —
it is the model's own output, not a summary this app generated.

### Replay and sharing

A finished single-agent run serialises to JSON. It can be **downloaded**, **re-loaded from a file**,
or **shared as a URL** — gzipped and base64url-encoded into the URL *fragment*, so a shared trace
never touches a server. There is no database and no storage in this project, and none is claimed.

Browsers cap URL length, so sharing degrades in named steps and tells you which one it took: full →
raw tool payloads dropped → long observations clipped → too large (use Download JSON).

---

## Running it

```bash
pnpm install
cp .env.example .env.local     # then put your key in it
pnpm dev                       # http://localhost:3000
```

Get a free Groq key at <https://console.groq.com/keys>. `GROQ_API_KEY` is the only variable required.

### The model is discovered at runtime, never hardcoded

Providers retire models. A hardcoded id is a time bomb that goes off long after the commit that
planted it. On each run the app calls `https://api.groq.com/openai/v1/models`, filters out everything
that cannot serve a tool-using chat turn (speech, text-to-speech, the prompt-injection classifiers,
anything inactive or with a tiny context window), ranks what is left, and uses the best available.
`GET /api/models` shows you exactly what it resolved.

Set `TRACE_AGENT_MODEL` to pin a specific id. It is still validated against the live list, so a pin
to a retired model fails immediately with a clear error rather than at call time.

### `GROQ_BASE_URL` is deliberately ignored

The provider URL is a source constant in `src/lib/groq/endpoint.ts`. An env-configurable base URL on a
path that carries an API key is a credential-exfiltration primitive: anything that can set one
environment variable could point every authenticated request at a host it controls. There is a test
that sets `GROQ_BASE_URL` to a hostile value and asserts the request still goes to `api.groq.com`.

---

## Deploying

Vercel-ready as-is: no filesystem writes at runtime, no long-running processes, streaming through the
Web Streams API as NDJSON. Set `GROQ_API_KEY` in the project settings.

The API routes run on the **Node runtime**, not Edge, because the SSRF guard resolves hostnames with
`node:dns/promises` before any outbound request. A guard that silently degrades is not a guard.

**One caveat worth knowing before you deploy a swarm:** `maxDuration` is set to 300 seconds. A large
swarm on an 8,000-tokens-per-minute key takes longer than that — the 20-agent run below took over 20
minutes. Under the free tier a swarm of that size will be cut off by the platform timeout. Run large
swarms locally, or raise `maxDuration` on a plan that permits it, or use a key with a higher rate
limit.

---

## Layout

```
src/
  app/
    api/run/route.ts          POST — stream one agent run as NDJSON
    api/swarm/route.ts        POST — plan, fan out, stream every agent
    api/models/route.ts       GET  — the model resolved from the live list
  components/                 the UI: trace view, swarm board, goal form
  lib/
    agent/                    the loop, output parsing and repair, trace types
    swarm/                    budget, FIFO gate, semaphore, planner, scheduler, merge
    groq/                     client with 429 backoff, live model discovery
    net/                      SSRF guard, IP classification, guarded fetch
    tools/                    the five tools and the registry
    text/                     HTML and Atom extraction
    ui/                       pure reducers the components render
  test/                       the no-network guard, virtual clock, mocks
```

---

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm test
```

**225 tests across 13 files, no network, no API key** (plus 10 opt-in live tests, skipped by default). The setup file replaces the global `fetch`
with a thrower, so a test that reaches the internet fails loudly and by name instead of becoming
slow and flaky. Every module that makes requests takes an injected `fetchImpl` precisely so that
guard can stay on.

Scheduler tests run on a **virtual clock** (`src/test/clock.ts`). Holding 100 agents against a
60-second rolling window is not something you can wait out in a test suite, and shrinking the window
to milliseconds would be testing a different system. Time is simulated, so the budget arithmetic
under test is exact and deterministic.

What the suite covers: every tool (happy path, malformed arguments, timeout, and the SSRF refusal
specifically), the guarded fetch including redirect re-validation, the agent loop (step budget, stop
condition, malformed model output recovered, cancellation), the swarm scheduler (100 agents under a
low budget with the rolling window asserted, a 429 storm, the concurrency cap, a permanently failing
agent, cancellation), the Groq client's 429 backoff and model ranking, both API routes with `fetch`
mocked, trace sharing, and the HTML extractor against a real 1.9 MB Wikipedia page.

There is one **opt-in live** suite, `src/lib/net/ssrf-live.test.ts`, skipped unless
`TRACE_AGENT_LIVE=1`. It proves the SSRF refusals against real listening sockets rather than mocks.

Exit codes, all measured on 2026-09-16:

```
pnpm typecheck  0
pnpm lint       0
pnpm test       0     225 passed | 10 skipped (235)
next build      0
```

---

## Measured, not estimated

Every number below was produced by the app and read out of its own event stream. Nothing here is
rounded up.

### Single agent — "What is the current population of Tokyo and how does it compare to New York, with sources"

`openai/gpt-oss-120b`, step budget 6. Run of 2026-09-16.

| | |
|---|---|
| Steps used | 6 of 6 |
| Model calls | 7 |
| Tool calls | 6 across 3 tools (`wikipedia`, `fetch_url`, `calculator`) |
| Tokens | 19,663 |
| Citations extracted from tool results | 6 |
| 429s absorbed by the client | 2, each a ~120 s wait, both visible in the trace |
| Wall clock | 373 s, of which roughly 245 s was rate-limit waiting |
| Final status | `budget-exhausted` — the step budget ran out and the forced final answer produced a real answer |

It found Tokyo 14,254,039 (May 2025) and New York City 8,584,629 (2025 estimate) by fetching both
Wikipedia articles, then used the calculator for the difference (5,669,410) and the ratio (1.66)
rather than doing the arithmetic in its head. Both figures were confirmed by hand against the same
pages afterwards.

### Swarm — 20 agents, "Give me a complete briefing on the current state of nuclear fusion energy"

20 agents, concurrency 8, 2 steps each, on a free-tier key. Run of 2026-09-16.

| | |
|---|---|
| Dispatched | 20 |
| Completed | 20 |
| Failed | 0 |
| Cancelled | 0 |
| **429s seen** | **0** |
| Retries absorbed | 0 (none were needed) |
| Max concurrency reached | 8 of 8 configured — measured, not assumed |
| Model calls | 59 |
| Tool calls | 37 |
| Total tokens | 90,858 (66,217 prompt, 24,641 completion) |
| **Peak tokens in any 60 s window** | **7,197 against a 7,200 ceiling** |
| Provider limit reported by the header | 8,000/min |
| Time agents spent held at the gate | 6,006,227 ms summed across all 20 |
| Wall clock | 968,956 ms — 16 min 9 s |
| Citations collected | 48 |
| Merged answer | 28,893 characters, synthesised by one extra model call, all 20 agents contributing |

**Zero rate limits across 59 model calls and 90,858 tokens on an 8,000-tokens-per-minute key, with
the window peaking at 7,197 of 7,200.** That is the scheduler doing its job. The cost is honest and
visible: 16 minutes of wall clock, most of it agents waiting at the gate.

**The same run also exposed a defect, which is reported here rather than hidden.** The planner call
fell back to the deterministic plan, because its completion budget was sized for the JSON and the
model spent 764 of those tokens on chain-of-thought before writing any. The swarm still completed —
that is what the fallback is for — but the plan was generic instead of goal-specific. Fixed, with a
larger reasoning allowance, explicit truncation detection, and a repair that salvages complete
entries from JSON cut off mid-array.

### Swarm — 6 agents, after the planner fix

| | |
|---|---|
| Plan source | **model-written** (was `fallback` before the fix) |
| Dispatched / completed / failed | 6 / 6 / 0 |
| 429s seen | 0 |
| Max concurrency reached | 4 of 4 |
| Model calls | 13 |
| Tool calls | 6 |
| Total tokens | 15,906 |
| Peak tokens in a 60 s window | 6,930 of 7,200 |
| Wall clock | 126 s |

---

## What is NOT here

Stated plainly so nobody has to discover it:

- **No persistence.** No database, no accounts, no run history. A trace lives in your browser and in
  whatever JSON you download.
- **No authentication and no rate limiting of your own endpoints.** If you deploy this publicly, your
  Groq key funds anyone who finds it.
- **No browser E2E suite.** There is no Playwright spec and no CI workflow in this repository.
  The tests above are unit and integration tests run by vitest.
- **No streaming of tokens within a single model response.** Events stream at step granularity, not
  token granularity.
- **HTML extraction is a heuristic**, not a DOM. It drops non-content elements, prefers the densest
  semantic container, and filters out serialised data blobs. It is good on articles and
  documentation; it will not be right on every page.
- **The arXiv Atom reader is not a general XML parser.** It pulls named fields out of a known,
  machine-generated feed.
- **The FIFO budget gate has head-of-line blocking.** A large request at the front of the queue holds
  up smaller ones behind it. That trade was taken deliberately: predictable ordering beats
  opportunistic throughput when the whole point is a legible ledger.

---

## Defects found by running it for real, and fixed

Every one of these was found by pointing the app at live Groq and reading the trace, not by reading
the code. Each has a regression test named after what went wrong.

1. **The finished run never reached the client.** `run_finished` was recorded into the trace but not
   *yielded*. A generator's return value never reaches `for await`, so a streaming client would sit
   at "running" forever.
2. **A full Wikipedia article came back as 377 characters of navigation chrome.** One embedded
   template-JSON blob overflowed the character budget, and the accumulator `break`ed on it instead of
   skipping it — discarding the entire rest of the article. Fixed with a prose filter and an
   accumulator that skips rather than stops.
3. **The agent fetched the same URL five times in a row**, burning the whole step budget, because the
   first result was disappointing. There is now a duplicate-call guard that replays the previous
   result and tells the model it repeated itself.
4. **The forced final answer failed with HTTP 400.** Re-sending the tool-call transcript with `tools`
   omitted makes Groq infer `tool_choice: none`; the model emits a tool call anyway and the request
   is rejected. A run with six real tool results ended as `failed`. The forced answer now runs on a
   fresh conversation carrying the evidence as plain text.
5. **Groq rejected the model's own tool call** — it emitted `"wiki..."` instead of `"wikipedia"` and
   the provider returned `400 tool_use_failed`. That is bad model output, not a broken request. The
   intended call is now recovered from the provider's `failed_generation` blob when the name resolves
   unambiguously, and the run continues.
6. **A two-minute rate-limit stall was invisible.** The client absorbed a 429 and slept 122 seconds
   while the trace showed nothing at all. For an app whose entire claim is that nothing is hidden,
   that was a defect. Backoff now emits a notice into the trace.
7. **The scheduler could not see a rate limit.** The agent loop absorbed a 429 into a trace status
   rather than throwing, so the swarm applied generic exponential backoff and silently ignored the
   provider's own `retry-after`. The retry-after now travels with the trace.
8. **The 20-agent swarm planned itself generically.** The planner's completion budget did not account
   for chain-of-thought, which on these models is charged to completion, so its JSON was cut off and
   a 20-agent plan silently degraded to the deterministic fallback. Fixed with a reasoning allowance,
   an explicit `finish_reason=length` diagnosis, and a conservative repair that salvages the complete
   entries from a truncated array and discards the partial one rather than guessing at it.

---

## Licence

MIT.
