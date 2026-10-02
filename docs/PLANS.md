# Plans: Free, Pro and early bird

How SHOOTS decides which plan an account is on, when early access starts and
ends, and how paid Pro (Razorpay) plugs in. The code that implements all of
this is `src/utils/plan.ts`; every Pro check on the server goes through it.

**The one rule to remember: Pro is always a dated term, never permanent.**
Free Pro (an early-bird term or an admin grant) lasts **6 months**; paid Pro
(later, via Razorpay) lasts **12 months** for ₹799. Every term has an end
date, and when it passes the account drops to Free.

## The plans

| | Free | Pro |
|---|---|---|
| Price | ₹0, forever | ₹799 / year (no checkout yet) |
| Shoots you create | 3 in total, any status | Unlimited |
| Shoots you're crew on | Unlimited | Unlimited |
| Analytics | Last 12 months | Full history |
| Earnings history page | No | Yes |
| Delivery timeline on client links | No | Yes |
| SHOOTS branding on client links | Shown | Hidden |

The limits live in `plan.ts` (`FREE_SHOOT_LIMIT`, `FREE_ANALYTICS_MONTHS`).
The app and landing page only describe them; the server enforces them and
answers `402 PRO_REQUIRED` when a Free account hits one. Dropping to Free
never deletes anything: shoots over the limit stay, but new shoots and Pro
features are blocked until Pro is running again.

## How an account's plan is decided

An account can hold more than one Pro term at once. `getPlan(user)` looks at
every term, keeps the ones still running, and reports the one that **ends
last**. It returns `{ tier, source, proUntil, lapsed }`.

| Source | Term | Starts | Ends |
|---|---|---|---|
| `early_access` | Early-bird term | The day the account activated, if before early access ended | 6 months later |
| `admin` | Admin grant | When an admin grants it | 6 months later by default, or a date the admin picks |
| `subscription` | Paid year *(Razorpay, not built yet)* | Payment (or the end of the current term) | 12 months later |
| `null` | Free | When no term is running | n/a |

When nothing is running, `lapsed` says which term ended last and when, so the
app can say "your free early-bird Pro ended on …".

`GET /auth/me` returns `isPro`, `planSource`, `proUntil`, `proDaysLeft` and
`proLapsed`, plus `earlyAccess` (still open?) and `earlyAccessEndsAt`. The
admin users list shows `pro · until …`, `pro · early bird · until …`,
`free · early bird ended …`, `free` or `invited`.

Term lengths live in `TERM_MONTHS` in `plan.ts` (`early_access: 6`,
`admin: 6`, `subscription: 12`). Change them there and the backend follows;
the app, admin panel and landing page copy say "6 months" in text, so update
those too.

## Activation: when the early-bird term starts

An account is **activated** the first time a password is set on it. That
stamps `users.activated_at`, once; nothing ever moves it afterwards, so a
later password reset can't restart a free term.

| How the account became usable | Where `activated_at` is set |
|---|---|
| Signs up (verify email, set password) | `POST /auth/reset-password` |
| Accepts a crew invite (sets password from the invite link) | `POST /auth/reset-password` |
| Registered directly with a password | `POST /auth/register` |
| Sets a first password from settings | `PUT /auth/me` |
| Admin creates the account with a password, or sets one | `POST`/`PUT /admin/users` |
| Older account signing in with no date yet (safety net) | `POST /auth/login` |

Rows that exist without a password are **not activated**: crew invited by
someone else, and signups that never clicked the verification link. They're
judged on the day they actually activate.

`created_at` is deliberately **not** used. A crew invite creates the row the
moment someone types an email, often weeks before that person ever opens
SHOOTS. Using `created_at` would start (and use up) free Pro for people
who were only invited, and hand it to people who join after early access.

## Early access: start and end

- **Start.** There is no start date. Early access has been open since launch
  and stays open until an end date is set. Every account activated in that
  time is an early bird.
- **End.** An admin sets the end date in *Admin → Settings → Early access*
  (stored in `app_settings` as `early_access_ends_at`, cached for 30 seconds).
  It can be in the future (scheduled) or removed again to reopen.
- **Each early bird's free Pro** runs 6 months from their own activation
  date, not from the end of early access. Someone who joined on 10 Oct 2026
  is on Free from 10 Apr 2027 unless they pay.
- **After the end date.** Anyone who activates on or after it starts on Free,
  including crew who were invited during early access but accept later.
- **Moving the date.** Pulling the date earlier takes free Pro away from
  people who activated after the new date. The admin panel asks for
  confirmation when the date is in the past.

### Examples (early access ends 1 Jan 2027, 00:00 IST)

| Person | What happened | Plan |
|---|---|---|
| Asha | Signed up 10 Oct 2026 | Pro until 10 Apr 2027, then Free unless she pays |
| Ravi | Invited as crew 20 Dec 2026, set his password 28 Dec 2026 | Pro until 28 Jun 2027 |
| Meena | Invited as crew 20 Dec 2026, set her password 5 Jan 2027 | Free |
| Karan | Entered his email on signup 30 Dec 2026, verified 2 Jan 2027 | Free |
| Neel | Signed up 3 Jan 2027, admin granted Pro that day | Pro until 3 Jul 2027 |
| Asha, later | Admin grants her Pro on 1 Mar 2027 | Pro until 1 Sep 2027 (the later of her two terms) |

### Admin grants

- **Grant 6 months Pro** (users list) or ticking *Pro member* (edit page)
  gives 6 months from that moment.
- The edit page has a *Pro until* date for a different end.
- Re-saving the edit form never extends a running grant; only a changed date
  does. Granting again after a grant has ended starts a new 6 months.
- **Remove Pro** ends the grant immediately. It doesn't touch an early-bird
  term that is still running.

### Admin dashboard numbers

*Settings → Early access* shows:

- **Early birds, Pro running**: activated before the end date, still inside their 6 months.
- **Early birds, Pro ended**: their free 6 months are over (Free unless another term is running).
- **Joined after end date**: activated on or after it, never early birds.
- **Invited, not joined**: rows with no `activated_at`. Each becomes an early
  bird only if they activate before the end date.

## Rolling this change out

Two columns are new: `users.activated_at` and `users.pro_until`. Order
matters, because the new backend code reads both:

1. `npm run db:push` adds them (nullable, no data change).
2. `npx tsx src/scripts/backfill-plan-dates.ts` shows what will change; run it
   again with `--apply` to write:
   - every existing account with a password gets `activated_at` = the
     rollout (the moment the script runs), so everyone on SHOOTS at launch
     gets the full free term from that day and nobody drops to Free on
     launch day;
   - every existing admin grant gets `pro_until` = 6 months from the run.

   Placeholder rows stay empty.
3. Deploy the backend, then the app and admin panel.

**Done on 2 Oct 2026**: 6 accounts activated at the rollout (free Pro until
2 Apr 2027) and 3 admin grants dated. The terms were first 12 months and cut
to 6 the same day; the 3 grants were moved from 2 Oct 2027 to 2 Apr 2027.
The columns were added with the two `ALTER TABLE`
statements in the migration rather than `db:push`, because of the warning
below.

> **Warning about `npm run db:push`.** drizzle-kit doesn't recognise the
> existing `team_members_user_id_member_id_unique` constraint and offers to
> **truncate `team_members`** to "add" it. The constraint already exists and
> the live schema matches the code, so answer **No** (or don't run push) —
> truncating deletes everyone's Circle.

Until step 2 runs, undated admin grants keep working (treated as running) and
accounts without `activated_at` are on Free, so run it straight after step 1.

## Adding paid Pro with Razorpay

The plan resolver already handles several terms and picks the one that ends
last, so a paid year is one more term. The rest is new work. Recommended shape:

### Data

```text
subscriptions
  id                         uuid pk
  user_id                    uuid → users.id
  provider                   'razorpay'
  provider_subscription_id   text unique        -- sub_XXXX
  plan_code                  'pro_yearly'
  status                     text               -- mirrors Razorpay status
  current_period_start       timestamptz
  current_period_end         timestamptz
  cancel_at_period_end       boolean
  created_at / updated_at

payment_events
  event_id                   text pk            -- X-Razorpay-Event-Id, for idempotency
  type                       text
  payload                    jsonb
  received_at                timestamptz
```

### Entitlement

Add a `subscription` term to `resolvePlan`, ending at `current_period_end`,
while `status` is `active` (or `authenticated` / `pending` within a short
grace window). Keep it in `plan.ts` so every gate (shoot limit, analytics,
timeline, share-link branding) picks it up with no other changes.

**Paying before free Pro ends.** Start the paid year where the current
term ends, not on the payment date, so nobody loses the free months they have
left. For a Razorpay Subscription, set `start_at` to the current `proUntil`;
for a one-off yearly payment, set the new period's end to
`max(now, proUntil) + 12 months`.

### Flow

1. One-time setup: create a yearly Plan in Razorpay for ₹799 (amounts are in
   paise, so `79900`). Decide first whether ₹799 includes GST.
2. `POST /billing/subscriptions` (signed in): create a Razorpay Subscription
   for the plan, store it as `created`, return its id.
3. The app opens Razorpay Checkout with that subscription id.
4. On success, the app sends `razorpay_payment_id`, `razorpay_subscription_id`
   and `razorpay_signature` to `POST /billing/subscriptions/verify`. The server
   checks the HMAC-SHA256 signature with the key secret before trusting it.
5. Webhooks are the source of truth: `POST /billing/razorpay/webhook` verifies
   `X-Razorpay-Signature` against the **raw** request body with the webhook
   secret, skips event ids already in `payment_events`, then updates the
   subscription: `subscription.activated` / `subscription.charged` extend
   `current_period_end`; `subscription.halted`, `subscription.cancelled` and
   `subscription.completed` end it at the period end.

### Things to get right

- **Raw body.** `src/index.ts` applies `express.json()` globally. Mount the
  webhook route with `express.raw({ type: 'application/json' })` *before*
  that, or the signature check will always fail.
- **Renewal reminders.** `proDaysLeft` is already on `/auth/me`, and the plan
  page warns in the last 30 days. Add emails 30 and 7 days before `proUntil`
  once checkout exists, so early birds can pay before dropping to Free.
- **Paid term length.** `TERM_MONTHS.subscription` (12) is what a paid term
  should use; don't reuse the 6-month free terms for it.
- **Don't double-sell.** Someone with a running term can pay early (the paid
  year stacks after it, see above), but don't let them start two
  subscriptions at once.
- **Secrets.** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
  `RAZORPAY_WEBHOOK_SECRET` go in the backend env only. Use test-mode keys
  until launch.
- **Legal pages.** Terms section 7 and the Privacy Policy say no billing is
  running and no payment data is collected. Update both, name Razorpay as a
  processor, and decide on a refund and cancellation policy before launch.
- **App UI.** The plan page (`shoots-app/src/app/settings/billing`) is
  read-only today. It needs an Upgrade button for Free and expiring accounts,
  and a "renews on / cancel" view for subscribers.
