# The first real AI run

Everything in carbon's AI has been built and tested offline, against
recorded and generated answers. This page covers the first run against the
real Claude API on your machine: what to type, what you'll see, and what it
costs. Allow about ten minutes and less than $0.10.

The model is `claude-haiku-5-5` throughout: $0.10 per million input tokens,
$0.50 per million output tokens. Cache reads are 0.1× the input price and
5-minute cache writes 1.25×. Prompts over 100k tokens cost 5×, but carbon
never sends one.

## 0. The key

carbon looks for the key in two places, in this order:

1. **The system keyring** (Secret Service: GNOME Keyring, KeePassXC and so
   on). Store it once. `secret-tool` asks for the key, so it never lands in
   your shell history:

   ```sh
   secret-tool store --label='carbon: Anthropic API key' service carbon account anthropic-api-key
   ```

   On Arch/Omarchy, `secret-tool` comes with `libsecret`.

2. **`ANTHROPIC_API_KEY`** in the environment, if the keyring has no key.

carbon never writes the key to the world directory, a log or a fixture, and
never prints it. The scripts say only where they found it ("using the key
from the system keyring"). carbon also refuses to send any request that
contains the key, or anything shaped like an Anthropic key. This guards
against a key pasted into an entity by accident.

**To check without spending anything:** run `npm run smoke:ai`. With no key
found, it prints how to add one and exits 0.

## 1. `npm run smoke:ai`: does it work at all?

```sh
npm run smoke:ai
```

It runs three small requests through carbon's real gateway, the same code the
app uses:

1. a critique of Glide, which writes the shared prompt prefix to the cache
2. a critique of Cinder Wasp, which should read that prefix from the cache
3. a streamed Fill spread of 3 candidates, which tests streaming and the
   partial-JSON parser

**Expected output** (your numbers will differ):

```
AI smoke test: using the key from the system keyring.

carbon AI smoke test (claude-haiku-5-5)
  ok    critique glide: 1 notes · in 1,350 · cache read 0 · cache write 1,800 · out 420 · $0.00058 · 2.1 s
  ok    critique cinder-wasp: 0 notes · in 1,400 · cache read 1,800 · cache write 0 · out 310 · $0.00031 · 1.6 s
  ok    spread (fill, 3): 3 candidates, 3 streamed · in 2,100 · cache read 1,800 · … · $0.0021 · 6.0 s

  spend: $0.00300
  caching: the second critique read 1,800 tokens from the cache
  verdict: OK
```

**What each part means:**

| Part | Meaning |
|---|---|
| `ok` / `FAIL` | The call's outcome. A failure gives the error code and a hint on the next line |
| `in` | Uncached input tokens |
| `cache read` / `cache write` | Prompt-cache tokens. The second critique should read what the first one wrote |
| `out` | Output tokens, thinking included (Haiku 5.5 thinks adaptively by default) |
| `N streamed` | Candidates that reached the UI while the answer was still arriving. It should equal the candidate count |
| `verdict` | `OK`, or how many calls failed. The command exits 1 on any failure |

**Expected cost:** under $0.01, usually about $0.003. It's capped at $0.05.

**If something fails:**

| Code | What to do |
|---|---|
| `no_key` | The key was rejected (401) or may not use this model (403). Check it in the Console |
| `bad_request` | The API rejected the request's shape. This is a carbon bug: save the line |
| `rate_limited`, `server` | Already retried 4 times with backoff. Run it again later |
| `network` | `api.anthropic.com` can't be reached. Check the network or proxy |
| `refused` | The model declined (`stop_reason: refusal`). Unlikely on the sample world; save the line |
| `truncated` | The answer hit `max_tokens`. Save the line; the limits are in `src/main/ai/settings.ts` |

**If caching read nothing** on the second critique, the requests still work,
just at full price. Haiku 5.5 caches prefixes of 512 tokens or more, and
carbon's shared prefix (role, world digest, taste) is well over that. A first
run can miss when the two calls land on different servers. Run it again: the
second run should read the cache.

## 2. `npm run eval`: how good are the prompts?

```sh
npm run eval
```

This runs 21 cases covering every moment against the eval world
(`evals/worlds/flawed/`): the sample world plus five seeded flaws and four
clean controls. It writes a report to `evals/reports/<time>-live.md` and
`evals/reports/latest-live.md`, and prints it.

**The metrics** (SYSTEM §8), measured on the model's raw answers before
carbon filters anything:

| Metric | Target | What a miss means |
|---|---|---|
| Schema validity | 100% | An answer didn't match its JSON schema |
| References resolve | 100% | An answer named an entity that doesn't exist |
| No duplicate names | ≥ 95% | Suggestions reused existing names |
| Critique recall on seeded flaws | ≥ 0.9 | Critique missed a pure-number item, a duplicate, a rule break or a bad relation |
| Critique precision on clean entities | ≥ 0.8 | Critique raised notes on sound entities |
| Spread diversity | name overlap < 0.15, identity/verb overlap < 0.3 | A spread's candidates are too alike |
| Largest request | < 100,000 tokens | It never comes close: the packer stays under 95k |
| Self-consistency | ≤ 10% | The critic raised notes on fields the fill had just written: the writer and the critic disagree about the quality bar (SYSTEM §8a) |

**Self-consistency** is a separate set of three cases (`consistency-*`): fill
an entity, accept every proposal, then critique it. The metric is the share
of the critique's notes that land on fields the fill just wrote. Live, both
calls go through the real gateway (6 more calls, well under $0.01). With
`--replay` or `--dry` it runs from the fixtures in
`evals/fixtures/consistency/`, through the real prompt builders and parsers.
One of those fixtures reproduces the conflict the critique fix addressed: a
pure-number identity that the critic flags. The report's Details line names
each note that landed on a just-filled field.

The report also gives the cache read rate, each case's tokens, cost and
latency, and the total spend.

**Reading the result:**

- `# Prompt evals: PASS`: every metric met its target, and every case ran.
  The command exits 0.
- `# Prompt evals: FAIL`: the command exits 1. The report shows either a
  metric marked **fail**, or a line like **"2 cases could not run"** listing
  each case with its error (401, network, refusal, truncation), or **"N
  cases did not start"** when the `--max-usd` cap stopped the run early. A
  run where cases couldn't reach the model, or never started, never passes.
- On a first run, a miss on recall, precision or diversity is a finding about
  the prompts, not a crash. Those three have never been measured against the
  real model. Note which cases missed. The prompts are in
  `src/core/prompts/*.ts` and `src/core/spreads/prompt.ts`.

**Expected cost:** about $0.02–0.05 for all 21 cases, plus the
self-consistency cases. The two spreads and the
spec draft are most of it. It's capped at $1 by default; change the cap with
`--max-usd`, e.g. `npm run eval -- --max-usd 0.25`. Once the spend passes the
cap, no further cases start.

**Useful flags:**

- `--only critique` runs only the cases whose id contains `critique`.
- `--dry` runs offline, with answers generated from each request's schema.
  It costs nothing and checks the pipeline only; its quality metrics mean
  nothing.

## 3. `npm run eval -- --record`: save real answers as fixtures

```sh
npm run eval -- --record
```

This is the same live run as above, but it also saves every exchange to
`evals/fixtures/recorded/`. Each file holds the request body and the answer.
Request headers, where the key travels, are never saved, and every file is
scanned for the key (and for anything shaped like a key) before it's
written. A file that contains one is refused.

**Expected cost:** the same as `npm run eval`, about $0.02–0.05.

Then:

1. **Look at the recordings** (`git diff --stat evals/fixtures/recorded`) and
   commit them:

   ```sh
   git add evals/fixtures/recorded && git commit -m "Evals: recorded fixtures from claude-haiku-5-5"
   ```

2. **Check the replay:** `npm run eval -- --replay` should give the same
   metrics as the live run, offline and at no cost. From now on, replay is
   the regression check for prompt changes: a change goes in only if replay
   (and then a live run) doesn't drop a metric.

A recording is matched to a request by a hash of the request. Once a prompt
or the eval world changes, its old recordings no longer match. Those cases
then fall back to schema-generated answers, which makes their metrics
meaningless. Record again after such changes.

## 4. In the app

With a key in the keyring or the environment, `carbon` starts with the AI on.
The status line shows spend against the session budget (`$0.00 / $2.00`).

- `ctrl+l` opens the AI log, with every call's tokens, cache use, cost and
  latency. `enter` on a row shows the exact prompt that was sent.
- The budget defaults to $2 per session and $20 per month. Click the status
  to change it; it's stored in `carbon.json` → `ai.budget`. At the limit, the
  AI pauses until you raise it.
- `ctrl+shift+a` turns the AI off for the session.

## Summary of costs

| Step | Expected | Cap |
|---|---|---|
| `npm run smoke:ai` | ~$0.003 | $0.05 |
| `npm run eval` | ~$0.02–0.05 | $1 (`--max-usd`) |
| `npm run eval -- --record` | ~$0.02–0.05 | $1 (`--max-usd`) |
| **The whole first run** | **under $0.10** | |

These are estimates from the offline runs' token counts plus an allowance
for thinking tokens. The real figures are in each report and in the AI log.
