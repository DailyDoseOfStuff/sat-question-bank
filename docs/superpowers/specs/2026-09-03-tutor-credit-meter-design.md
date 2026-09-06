# AI tutor, metered in credits — design

**Date:** 2026-09-03
**Scope:** the credit meter, and the tutor restored on top of it.
**Not in scope:** Stripe/payments, bring-your-own-key. Each gets its own spec. This
design must not preclude either, and Section 11 records the seams they attach to.

## 1. Why this exists

The AI tutor was removed in `62483050`, not because it was broken but because every
call cost money and nothing bounded who could spend it. It is recoverable in full from
`git show 62483050^:src/index.js`, and it was already hardened:

- gated behind `whoami()` (Supabase token → user id, not a client-supplied header),
- rate limited through the `CHAT_RL` binding,
- 64KB request cap, history clamped to `.slice(-12)` turns of `.slice(0, 4000)` chars,
- **the system prompt lived in the Worker**, and the question was pasted into a
  Worker-owned system line, so a student could not instruct the model by typing.

So the work here is not "build a chatbot". It is "build the meter that makes it
affordable to turn back on", and restore the endpoint against that meter.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Unit of account | **A credit = one conversation** | Maps to the thing actually being bought — "I got stuck, I asked, I understood". A message count is the vendor's unit, not the student's. |
| When a credit is spent | **On the first message**, not on opening the panel | Opening the tutor to look at it costs nothing, so a misclick is free and the panel can be opened to show the credit balance. |
| Conversation boundary | **One question = one conversation** | The only boundary a student already understands, and the panel was always scoped to one question. Without a boundary a credit buys infinite messages. |
| Resuming | **Free, forever** | Navigate away and back, or return next week — same question, same conversation, no second charge. |
| Turn cap | **20 per conversation** | The sole reason is to give a credit a knowable worst-case cost (Section 9). It is not a product feature. |
| Free tier | **5 credits / calendar week** | Weekly contact builds the habit that sells the subscription; a week-long ceiling bounds exposure far better than a monthly one. |
| Paid tier | **200 credits / calendar month** | A hard, computable ceiling on cost per subscriber before a price is ever set. |
| Rollover | **None** | The grant *sets* the balance rather than adding to it. Otherwise a dormant account accrues a balance that makes the paid tier look pointless. |
| Grant mechanism | **Lazily, on spend** | No cron, no scheduled worker, no drift. A user who does not visit for three months costs nothing to maintain and is correct the moment they return. |

## 3. Data model

Two new D1 tables, added to `schema.sql` and a migration.

```sql
CREATE TABLE IF NOT EXISTS credits (
  user_id         TEXT PRIMARY KEY,
  plan            TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'pro'
  balance         INTEGER NOT NULL DEFAULT 0,
  granted_through TEXT NOT NULL DEFAULT '',      -- period key of the last grant
  updated_at      TEXT
);

-- The existence of a row IS the receipt that a credit was spent for this
-- (user, question). There is no separate ledger and nothing to join.
CREATE TABLE IF NOT EXISTS conversations (
  user_id     TEXT NOT NULL,
  question_id TEXT NOT NULL,
  turns       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
```

`granted_through` holds an ISO period key — `'2026-W36'` for a weekly plan,
`'2026-09'` for a monthly one. Comparing it to the current key is the whole reset
mechanism.

**Both keys are computed in UTC**, and the week is ISO (Monday-anchored). This differs
deliberately from the dashboard, which keys activity on the *local* calendar day so an
11pm answer belongs to the day the student was sitting there. That is the right call for
a chart the student reads about their own evening, and the wrong one for a balance: a
period boundary that moves with the client is a period boundary a client can move. The
server is the only clock that counts money.

Plan sizes are policy and live in code, not the database. A config table here would be
two rows nobody ever edits, and a schema migration to change a number:

```js
const PLANS = {
  free: { credits: 5,   period: 'week'  },
  pro:  { credits: 200, period: 'month' }
};
const TURN_CAP = 20;
const MAX_TOKENS = 800;
```

**Transcripts are not stored.** The deleted endpoint already took history from the
client on every call; that stays, with the client keeping history in `localStorage`
keyed by question id. The server stores only `turns`, which is the one part that must
be authoritative because it bounds cost.

## 4. The credit lifecycle

Every step is a single conditional `UPDATE`. SQLite makes each one atomic on its own,
so there is no read-then-write race and no need for a transaction.

**Grant** — fires at most once per period, evaluated on first use within it:

```sql
UPDATE credits
   SET balance = ?1, granted_through = ?2, updated_at = ?3
 WHERE user_id = ?4 AND granted_through <> ?2;
```

**Spend** — succeeds only if there is something to spend:

```sql
UPDATE credits
   SET balance = balance - 1, updated_at = ?
 WHERE user_id = ? AND balance > 0;
```

The caller checks `meta.changes === 1`. `changes === 0` means the balance was zero and
the request is refused with 402 — the check and the decrement are the same statement,
so two concurrent first messages cannot both succeed on one credit.

**Row creation.** A user with no `credits` row (never used the tutor) gets one via
`INSERT OR IGNORE` with `balance = 0, granted_through = ''`, which the grant then fills
on the same request. The `users` upsert that already runs for every authenticated
request is the natural place to seed it.

**Refund.** If the provider call fails *on a first message*, the credit is restored and
the `conversations` row deleted, returning the user to exactly the state they were in.
Only the request that created the row may refund it; a failure on turn 7 refunds
nothing, because nothing was charged.

## 5. Request flow

```
POST /api/chat  { question_id, messages: [...] }
  |
  ├─ whoami()                        → 401 if no valid Supabase token
  ├─ CHAT_RL.limit({key: user.id})   → 429
  ├─ Content-Length > 64KB           → 413
  ├─ load question by question_id    → 400 if unknown
  ├─ INSERT OR IGNORE credits row    (no-op after the user's first ever request)
  ├─ read conversations(user, qid)
  |     ├─ exists → turns >= TURN_CAP ? 409 : continue, free
  |     └─ absent → grant if due; spend → 402 if changes === 0;
  |                 INSERT conversations
  ├─ build messages server-side (Section 6)
  ├─ POST provider /chat/completions
  |     └─ failure → refund if first message; 502
  ├─ UPDATE conversations SET turns = turns + 1
  └─ 200 { reply, credits_remaining, turns_left }
```

Rate limiting stays **alongside** credits, not instead of them. `CHAT_RL` bounds
requests per second; credits bound spend per period. A weekly budget does nothing to
stop a burst that exhausts it in four seconds and hammers the provider on the way.

`credits_remaining` rides back on the chat response so the UI updates without a second
round trip.

## 6. Context is built by the Worker, not sent by the client

The deleted endpoint accepted `str(b.context, 4000)` — four thousand characters of
client-supplied text, pasted into a Worker-owned system line. That was defensible
because of where it was pasted, but it let the client decide both what the tutor sees
and how large the prompt is.

Metering requires `question_id` on the request anyway. So the Worker now reads the
question from D1 and builds the context itself, from `stem_html`, `choices_json`,
`correct_answer` and `explanation_html`. `b.context` is deleted outright.

Three things fall out of this at no cost: the client cannot inflate the prompt, cannot
choose what the tutor is told, and the tutor is guaranteed to be looking at the same
question the credit was charged against.

The HTML→text step already exists — `toText()` in `public/index.html`, written for the
Copy-for-AI export, which handles the three things a naive tag strip loses (`<img>` →
`[image: url]`, table shape, line breaks). It moves to a shared module so the Worker
and the export use one implementation rather than two that drift.

## 7. New endpoint

`GET /api/credits` → `{ plan, balance, resets_at }`, applying any due grant first so
the number shown is the number that will be spent. Used to render the pill on load.

## 8. UI

`#ai-panel` is restored from `62483050^:public/index.html`, plus:

- a credit pill in the panel header — `4 credits left`, and on a resumed conversation
  `Resumed · 13 turns left` rather than a credit count, since nothing will be charged;
- at zero balance the panel does not open a composer. It states when credits reset and
  points at **Copy for AI**, which already exists, already works, and costs nothing.
  A free user who runs out still has a path, and it is the path that demonstrates what
  the subscription buys;
- at the turn cap, the composer is replaced by a line saying the thread is finished.

## 9. Cost model

This is the number the meter exists to bound, so it is written down rather than
assumed. Worst case for **one credit**, per turn:

| part | bound | source |
|---|---|---|
| system prompt | ~500 tok | fixed, Worker-owned |
| question context | ~1,500 tok | stem + choices + answer + rationale, longest rows |
| history | 12 × 4,000 chars ≈ 12,000 tok | existing `.slice(-12)` / `.slice(0, 4000)` clamps |
| completion | 800 tok | `MAX_TOKENS` |

≈ **14,000 in / 800 out per turn**, × 20 turns = **280,000 in / 16,000 out per credit**,
absolute worst case. Multiply by the provider's current per-token rates to get cost per
credit; multiply that by 200 to get the monthly ceiling per subscriber, and by ~21 (5/week)
for a free user. Set the subscription price above the former with margin.

Two things to hold onto. The realistic average is far below the ceiling — most
conversations are three or four turns, not twenty, and history only reaches 12 turns at
the very end of a long one. And the ceiling is what makes a price defensible: without
the turn cap and the clamps, there is no largest possible bill.

## 10. Verification

This is money logic, so it gets a runnable check rather than a manual pass.
`tools/test_credits.mjs`, run against `wrangler dev` with the local D1:

1. First message on a question spends exactly one credit.
2. Second message on the *same* question spends zero.
3. First message on a *different* question spends one.
4. Balance at zero returns 402, and the response carries a reset date.
5. The grant applies once per period — two calls in the same week grant once.
6. A user whose `granted_through` is last week is granted on their next call.
7. Turn 21 on one conversation returns 409.
8. A forced provider failure on a first message leaves the balance unchanged and
   creates no `conversations` row.
9. Two concurrent first messages against a balance of 1 result in exactly one 200 and
   one 402.

Failure modes and their codes:

| condition | status |
|---|---|
| no/invalid Supabase token | 401 |
| out of credits | 402 + `resets_at` |
| unknown `question_id` | 400 |
| turn cap reached | 409 |
| body over 64KB | 413 |
| rate limited | 429 |
| provider error or timeout | 502 (refunded if first message) |

## 11. Out of scope, and the seams they attach to

- **Stripe / payments.** `credits.plan` is the entitlement field; a webhook sets it to
  `'pro'` or back to `'free'` and clears `granted_through` so the new grant applies
  immediately. Nothing else in this design changes.
- **Top-up packs.** A second column spent after `balance` and never reset. The grant
  statement already sets only `balance`, so purchased credits survive it untouched.
- **BYOK.** The provider call keeps the OpenAI-compatible `/chat/completions` shape it
  already used, so routing to a user's own key is a swap of base URL and key plus a
  branch that skips the spend. The security decision (key stored server-side and
  encrypted, versus never leaving the browser) is deferred to that spec.
- **Streaming.** Deferred: it needs SSE plumbing through the Worker, and it muddies
  refund-on-failure, since a call can fail after partial output has already been sent.
  With completions capped at 800 tokens the wait is tolerable without it.
- **Server-side transcripts.** See below.
- **Credit expiry.** Nothing expires. There is no rollover, so nothing accumulates to
  expire.

## 12. Known soft spot

The client supplies conversation history, so a user can fabricate prior assistant turns
and steer the tutor off-topic. The blast radius is one conversation they paid for, and
the clamps bound the context regardless, so this is a cost question rather than a safety
one — and the meter is what bounds the cost. It does mean the tutor can be talked into
non-SAT work.

Storing transcripts server-side closes it. That is real storage for a benefit measured
in credits a user already spent, so it is not worth it now. It is recorded here so the
next person does not discover it as a surprise.
