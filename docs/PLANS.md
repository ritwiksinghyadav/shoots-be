# Plans: Free, Pro and early bird

How SHOOTS decides which plan an account is on, when early access starts and
ends, and how paid Pro (Razorpay) plugs in. The code that implements all of
this is `src/utils/plan.ts`; every Pro check on the server goes through it.

**The one rule to remember: Pro is always a dated term, never permanent.**
Free Pro (an early-bird term or an admin grant) lasts **6 months**; paid Pro
(via Razorpay) lasts **12 months** for ₹799. Every term has an end
date, and when it passes the account drops to Free.

## The plans

| | Free | Pro |
|---|---|---|
| Price | ₹0, forever | ₹799 for 12 months, one-time (Razorpay) |
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
| `paid` | Paid year (Razorpay) | Payment, or the end of the current term if one is running | 12 months later |
| `null` | Free | When no term is running | n/a |

When nothing is running, `lapsed` says which term ended last and when, so the
app can say "your free early-bird Pro ended on …".

`GET /auth/me` returns `isPro`, `planSource`, `proUntil`, `proDaysLeft` and
`proLapsed`, plus `earlyAccess` (still open?) and `earlyAccessEndsAt`. The
admin users list shows `pro · until …`, `pro · early bird · until …`,
`free · early bird ended …`, `free` or `invited`.

Term lengths live in `TERM_MONTHS` in `plan.ts` (`early_access: 6`,
`admin: 6`, `paid: 12`). Change them there and the backend follows;
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

## Paid Pro with Razorpay

Built 2 Oct 2026. **One-time payment, no auto-renewal, no GST charged.** ₹799
(`PRO_PRICE_PAISE = 79900` in `plan.ts`) buys 12 months. The server sets the
price; the app only displays it.

### Data

- `payments`: one row per Razorpay order, kept forever (survives account
  deletion via `user_id → set null` plus an `email` snapshot). Holds order,
  payment and refund ids, amount in paise, method, status, the Pro period it
  bought, who refunded it, and the raw Razorpay payment entity.
  Status: `created → paid → refunded | partially_refunded`, or `failed`
  (a later successful attempt on the same order can still become `paid`).
- `users.paid_pro_until`: end of the paid term, denormalised so plan checks
  stay a single-row read. `resolvePlan` treats it as the `paid` source.

### Flow (`src/routes/billing.ts`, `src/utils/billing.ts`)

1. `POST /billing/orders` creates a Razorpay order for ₹799 and a `created`
   row. An unpaid order from the last 30 minutes is reused.
2. The app (`/settings/billing`, `ProCheckoutButton`) opens Razorpay Checkout.
3. `POST /billing/verify` checks the HMAC signature, fetches the payment from
   Razorpay, captures it if only authorised, and marks it paid.
4. `POST /billing/webhook` (raw body, `X-Razorpay-Signature`) handles
   `payment.captured` / `order.paid` (grant), `payment.failed`, and
   `refund.created` / `refund.processed` (refunds made in the dashboard too).

Steps 3 and 4 usually both happen. Every state change is one SQL statement
guarded by the row's current status, so a payment or refund is applied once.

**Stacking.** The paid year starts at the latest of: now, the end of any
running admin or early-bird term, and the current `paid_pro_until`. Paying
early never loses days.

**Refunds.** *Admin → Payments → Refund* refunds whatever hasn't been
refunded yet through Razorpay, then takes the payment's months back off
`paid_pro_until` (later stacked payments move earlier by the same amount). A
partial refund from the dashboard is recorded but leaves Pro alone. The
published policy (bnwapphub.com/shoots/refund) promises a full refund within
7 days; the admin button warns when a payment is older than that.

### Setup

- Env (backend only): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`. Without the keys, `/billing/orders` answers
  `503 BILLING_UNAVAILABLE`. Use test keys until KYC is approved.
- Razorpay dashboard → Webhooks: `https://<backend>/api/v1/billing/webhook`,
  events `payment.captured`, `payment.failed`, `order.paid`,
  `refund.created`, `refund.processed`, with the webhook secret above.
- Migration `drizzle/0013_payments.sql` (one new table, one nullable column).
  Apply it with `psql` or the Neon SQL editor, not `db:push` (see the
  warning above).
- CSP: `shoots-app/src/proxy.ts` allows `https://*.razorpay.com` for scripts,
  frames, images and connections on `/settings/billing` only.

### Not built yet

- Renewal reminder emails 30 and 7 days before `proUntil`.
- Invoices/receipts beyond Razorpay's own payment email.
