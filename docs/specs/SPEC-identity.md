# Spec: `identity`

**Milestone:** M2 · **Depends on:** `settings` · **Used by:** every module (the `Actor`), `picking`/`packing`/`qa`
(station actors on the floor), `operations` (email health) · **State:** done ·
**Issue:** [#21](https://github.com/isaacvarg/woolrus/issues/21)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `identity`.

## Objective

Decide who can get in and who is acting. Admins invite people and give them roles. Floor staff share rugged tablets
("stations") and switch onto any of them in seconds with a PIN or a badge scan, without a Google or email sign-in
on the tablet. Every action is attributed to the right person and station.

- **SRS:** FR-SET-04 (invite users, assign roles, deactivate), NFR-SEC-02 (sign-in limited to invited users),
  FR-SET-03 (language, theme, sidebar, log out, persisted per user), §7.1 defect #3 (any account gets full access).
- **decisions.md:** stations, PINs and badges with idle lock after `Settings.stationIdleLockMinutes`; the email
  provider open item, decided here as **Resend** (2026-10-20).
- **Users:** Admins manage users, invitations and stations. Everyone signs in personally on their own device or
  desktop, or unlocks a shared station.
- **Why now:** M2 puts real staff on the floor. `picking` and `packing` need many people on a few shared
  tablets, with each tap attributed to the right person.

### Two ways to act

| | Personal sign-in | Station |
|---|---|---|
| Device | Your own desktop or phone | A shared tablet registered by an admin |
| How | Google, Discord or magic link (Better Auth session) | Tap your name + PIN, or scan your badge |
| Lasts | Better Auth session lifetime | Until idle lock, manual lock, or the next person unlocks |
| Actor | `{ userId, roles, stationId: null }` | `{ userId, roles, stationId }` |
| Permissions | The user's roles | **The same:** the user's roles, nothing added or removed (decided 2026-10-20) |

Any user can unlock any active station. The station only says *where* the action happened.

### User stories

1. As an admin, I invite `ana@…` as Picker + Packer. She gets an email, signs in with Google or a magic link, and
   lands in the app with exactly those roles. Someone without an invitation can't sign in at all.
2. As an admin, I change a user's roles, or deactivate someone who left. A deactivated user is signed out
   everywhere at once, dropped from any station, and can't sign back in.
3. As an admin, I set a user's 6-digit PIN and issue them a badge, which I print.
4. As an admin, I sign in on a new tablet, choose **Make this a station**, and name it "Pack 2". My personal session
   on that tablet ends, and the tablet now shows the station lock screen.
5. As a packer, I walk up to any station, tap my name and enter my PIN, or scan my badge. I'm working as myself in
   two seconds, and my actions record me and "Pack 2".
6. As a packer, I leave the tablet. After the idle-lock time it locks itself. If I come back sooner, the next person
   can still switch onto it, which locks me out.
7. As anyone, I pick English or Spanish, light/dark/high-contrast, and collapse the sidebar. My choices follow me
   to every device and station.
8. As an admin, I see every station, who is on it now and when it was last used, and I can rename or revoke it.

## Scope

**In:**
- Users admin: list, change roles, deactivate/reactivate, set/clear PIN, issue/revoke badge.
- Invitations: create, resend, revoke, list. Sent by email.
- Sign-in hardening: refuse deactivated users; only send magic links to known or invited addresses; translated
  sign-in page with Google, Discord (when configured) and magic link.
- Stations: register this device, rename, revoke, list. Lock screen, unlock by PIN or badge, switch user, manual
  lock, idle lock enforced on the server.
- Resolving the actor from either a personal session or a station.
- Email: `EmailSender` adapter, Resend implementation, log implementation for dev, email settings + a "Send test
  email" action, invitation and magic-link templates in en/es, an `email` entry in `/api/health`.
- User preferences (FR-SET-03) and log out.

**Out (owned elsewhere or later):**
- Native Android station auth (bearer device token). The design keeps it possible: the station token is opaque and
  could later travel in a header.
- Password sign-in, 2FA, SSO beyond Google/Discord.
- Per-station role restrictions (e.g. "this tablet is packing only").
- Releasing a locked user's order claims: claims expire lazily (`workflow`).
- Email for anything other than invitations and sign-in (customer notifications are SRS §7.2).
- The client-IP rate-limit config for production (deploy concern, tracked for go-live).

## Design

### Actor resolution (`apps/web/src/server/actor.ts`)

`resolveActor(headers)` becomes the one rule for both modes, in this order:

1. **Better Auth session** (cookie or bearer) for an active user → personal actor, `stationId: null`.
2. Else a **station cookie** (`woolrus_station`, httpOnly, Secure outside dev, SameSite=Lax, 400-day max age) whose
   SHA-256 matches an active `Station.tokenHash` → look up the station's open activation:
   - none, or the user is inactive → **locked**;
   - `lastActivityAt + stationIdleLockMinutes < now` → end it (`IDLE`) and return **locked** (lazy, like claims;
     no job);
   - else → station actor `{ userId, roles, stationId }`, and `Station.lastSeenAt` is updated (at most once a
     minute).
3. Else → signed out.

The `authed` middleware returns `UNAUTHORIZED` with `errors.station.locked` (vs `errors.unauthenticated`) so the
client knows to show the lock screen rather than the sign-in page. Station-only procedures (unlock, status) use a
separate `stationDevice` middleware that requires a valid station cookie but no unlocked user.

A device with a station cookie never shows the personal sign-in page: `(app)` routes redirect to `/station` when
locked. If a personal session and a station cookie are both present (an admin signed in on a station), the personal
session wins for that request. Registering a station signs out the session, so this only happens if someone signs
in on purpose, and unlocking the station by PIN or badge signs it out too, so the worker who unlocks is the one
acting (ship review, 2026-10-20).

### Services (`packages/core/src/identity/`)

| Function | Permission | Notes |
|---|---|---|
| `listUsers(db, actor, { search?, page, pageSize })` | `user.manage` | Name order, 50 a page (max 100), search by name or email. Name, email, roles, active, `hasPin`, `hasBadge`, `pinLockedUntil`, last activity. Never `pinHash` or badge hash |
| `updateUserRoles(db, actor, { userId, roles })` | `user.manage` | ≥ 1 role. Audited with before/after |
| `deactivateUser(db, actor, { userId })` | `user.manage` | `active=false`, delete their Better Auth sessions, end their open activations (`MANUAL`), audited. Idempotent |
| `reactivateUser(db, actor, { userId })` | `user.manage` | Audited |
| `setPin(db, actor, { userId, pin })` | `user.manage` | Hash with scrypt (Node `crypto`, per-user salt), reset failed attempts/lock. Audited as `user.pin.set`, never the PIN |
| `clearPin(db, actor, { userId })` | `user.manage` | Audited |
| `issueBadge(db, actor, { userId })` | `user.manage` | New random code, `WRB-` + 20 Crockford base32 chars. Stores **SHA-256 of it** in `badgeCode`, so a DB read can't make badges. Returns the code **once** for printing. Replaces any old badge |
| `revokeBadge(db, actor, { userId })` | `user.manage` | Audited |
| `listInvitations` / `createInvitation` / `resendInvitation` / `revokeInvitation` | `user.manage` | Below |
| `listStations` / `registerStation` / `renameStation` / `revokeStation` | `station.manage` | Below |
| `stationStatus(db, station)` | station device | Station name, active user (if any), and the unlock tiles: active users with a PIN, name + initials only |
| `unlockWithPin(db, station, { userId, pin })` / `unlockWithBadge(db, station, { code })` | station device | Below |
| `lockStation(db, actor)` / `touchStation(db, actor)` | station actor | Manual lock; activity ping |
| `getPreferences` / `updatePreferences(db, actor, patch)` | any signed-in user | `locale`, `theme`, `sidebarCollapsed` |

**Last-admin guard:** `updateUserRoles` and `deactivateUser` refuse (`CONFLICT`, `errors.users.lastAdmin`) any change
that would leave no active Admin. An admin can't deactivate themselves or remove their own Admin role
(`errors.users.self`). `ADMIN_EMAILS` still bootstraps an admin on first sign-in.

### Invitations

- `createInvitation({ email, roles, idempotencyKey })`: email is lowercased; ≥ 1 role; expires after **7 days**.
  Refused with `CONFLICT` if a user with that email exists (`errors.users.alreadyExists`). The `email` column is
  unique, so re-inviting a revoked or expired address reuses the row: roles, inviter and expiry are reset, and
  `revokedAt`/`acceptedAt` are cleared. In the same transaction it enqueues an `email.send` job (`enqueue(tx, …)`),
  so the email exists only if the invitation commits.
- `resendInvitation({ id })`: open or expired invitations only; extends expiry 7 days and enqueues another email.
- `revokeInvitation({ id })`: sets `revokedAt`; the sign-in hook then refuses that email.
- Status in the list is derived: `pending` / `expired` / `accepted` / `revoked`.
- Acceptance stays in the existing Better Auth `user.create` hooks (roles copied, `acceptedAt` set).
- The email says who invited them and links to `/sign-in?email=<address>`, which pre-fills the magic-link field.

### Sign-in hardening (`apps/web/src/server/auth.ts`)

- `session.create.before`: refuse when the user is inactive (`errors.auth.deactivated` shown on the sign-in page).
- `sendMagicLink` sends only to an existing active user, an open invitation, or an `ADMIN_EMAILS` address.
  Otherwise it does nothing and logs at `info`. The page always says "check your email" so it doesn't reveal
  who has an account. This stops our Resend account being used to email arbitrary addresses.
- Magic links are sent right after the response (Next's `after()`), not as a job, through the same
  `EmailSender`: the response time is then the same whether or not anything is sent, so it can't reveal who
  has an account either (ship review, 2026-10-20).
- `user.create.before` also needs a verified email: Better Auth creates OAuth accounts with whatever the
  provider reports, and Discord reports unverified addresses, so an invitation or the `ADMIN_EMAILS`
  bootstrap could otherwise be claimed by naming the address. Magic-link sign-ups are verified (ship review,
  2026-10-20).
- The sign-in page moves to `@woolrus/i18n` strings and shows Discord when it's configured.

### Stations

- **Register** (`registerStation({ name })`, personal session with `station.manage` only): creates the `Station`
  with a random 32-byte token (stores the SHA-256), sets the station cookie on the response, signs out the
  caller's personal session, and redirects to `/station`. Names are unique, 1–40 chars.
- **Unlock with PIN:** the user must be active and have a PIN that isn't locked. A wrong PIN increments
  `pinFailedAttempts`; at **5** the PIN is locked for **15 minutes** (`errors.station.pinLocked`, with the unlock
  time). The right PIN resets the count. Wrong-PIN and unknown-user responses are the same
  `errors.station.badPin` so the tiles can't be used to probe.
- **Unlock with badge:** hash the scanned code, match `badgeCode`, and the user must be active. Unknown badge →
  `errors.station.badBadge`. The lock screen keeps a focused input for HID scanners (code + Enter).
- **On unlock:** in one transaction, end the station's open activation (`SWITCHED_USER` if a different user, else
  just keep it), open a new one with `method`, set `lastActivityAt = now`, and audit `station.unlock`.
- **Idle lock:** the server enforces it as described above. The client tracks pointer/key/scan input, calls
  `station.touch` at most once a minute while there is input, and shows the lock screen at the deadline it got from
  the last response. Background refetches and SSE don't count as activity.
- **Manual lock:** a **Lock** button in the nav ends the activation (`MANUAL`). On a station it replaces **Log out**.
- **Revoke:** `active=false`, ends the open activation (`STATION_REVOKED`). The device's next request finds no
  station, so it clears the cookie and shows the personal sign-in page.
- Every mutation by a station actor already records `stationId` in `AuditEvent` and `OrderStageEvent`.

### PIN rules (contracts)

Exactly 6 digits. Reject all-same (`000000`) and straight runs (`123456`, `654321`). The admin form can type one or
**Generate** a random valid PIN, shown once for the admin to hand over.

### Email (`packages/core/src/adapters/email/`)

- `EmailSender { send({ to, subject, html, text, idempotencyKey }): Promise<void> }`.
- `ResendEmailSender`: `fetch` `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and
  `Idempotency-Key`. **No SDK dependency.** 4xx → permanent failure (logged, not retried); 429/5xx → throw so
  pg-boss retries (3 attempts, exponential backoff).
- `LogEmailSender`: logs recipient + subject (and the link in dev) at `warn`. Used whenever Resend isn't configured.
  Health reports `email: "unconfigured"` then, which is fine in dev and a go-live blocker in production.
- `getEmailSender(db)` picks one from Settings: `emailFrom` (e.g. `Woolrus <no-reply@example.com>`) + secret
  `resendApiKey`.
- Templates live in core (`identity/emails.ts`), plain HTML + text with strings from `@woolrus/i18n` in the
  recipient's locale (the user's `locale`, or `en` for invitations).
- Worker job `email.send` with payload `{ to, template, params, locale, idempotencyKey }`. The payload never holds
  a magic-link URL (those are sent directly, never queued).
- Settings → Integrations gets an **Email** card: `emailFrom`, the `resendApiKey` secret (Set / Not set, as for the
  others) and **Send test email** to the admin's own address (`settings.manage`).

### API (oRPC)

| Procedure | Route |
|---|---|
| `users.list` / `users.updateRoles` / `users.deactivate` / `users.reactivate` | `GET /users`, `PUT /users/{id}/roles`, `POST /users/{id}/deactivate`, `…/reactivate` |
| `users.setPin` / `users.clearPin` | `PUT /users/{id}/pin`, `DELETE /users/{id}/pin` |
| `users.issueBadge` / `users.revokeBadge` | `POST /users/{id}/badge`, `DELETE /users/{id}/badge` |
| `invitations.list` / `create` / `resend` / `revoke` | `GET/POST /invitations`, `POST /invitations/{id}/resend`, `DELETE /invitations/{id}` |
| `stations.list` / `register` / `rename` / `revoke` | `GET/POST /stations`, `PATCH /stations/{id}`, `DELETE /stations/{id}` |
| `station.status` / `unlockPin` / `unlockBadge` / `lock` / `touch` | `GET /station`, `POST /station/unlock/pin`, `…/unlock/badge`, `POST /station/lock`, `POST /station/touch` |
| `me.get` (adds `stationName`, `idleLockAt`) / `me.updatePreferences` | `GET /me`, `PATCH /me/preferences` |
| `settings.sendTestEmail` | `POST /settings/email/test` |

No output schema has a field for a PIN, a PIN hash, a badge hash or a station token. `issueBadge` returns the
badge code once. `register` sets the cookie and never returns the token in the body.

### UI

- `/users` (nav: **Users**, `user.manage`): users table with role chips and status, a row menu (Edit roles,
  Set PIN, Issue badge, Deactivate/Reactivate), and an Invitations tab with **Invite user**. **Issue badge**
  opens a print view: name, a QR code of the badge code, and the code as text (decision 5).
- `/stations` (nav: **Stations**, `station.manage`): list with name, current user, last seen, active. Rename,
  Revoke, and **Make this device a station**.
- `/station`: full-screen, touch-first lock screen. Large name tiles (sorted by most recent use on this station),
  a PIN pad, and an always-focused badge input. Shows the station name. Tablet-sized targets (≥ 48 px).
- Nav footer: current user, station name when on one, a preferences menu (language, theme), sidebar collapse, and
  Log out or Lock. Preferences save to the user and set the `locale` cookie; theme sets `data-theme` on `<html>`.
- All strings in en + es; React Aria primitives from `components/ui`.

### Schema changes (ask-first: listed here for approval)

- `Settings.emailFrom String?` and `Settings.resendApiKeyEnc String?`, plus `resendApiKey` in the `SecretName` enum.
- `StationActivation.lastActivityAt DateTime` (timestamptz, default now()).
- `User.badgeCode` keeps its column and unique index but now holds a SHA-256 hex digest (comment updated; no data
  to migrate).

One new dependency: `qrcode` (+ `@types/qrcode`) in `apps/web`, for badge QR codes (decision 5).

### Files expected to change

`packages/core/src/identity/**` (+ tests), `packages/core/src/adapters/email/**`, `packages/core/src/jobs.ts`,
`packages/core/src/settings/{service,integration}.ts`, `packages/core/src/index.ts`,
`packages/contracts/src/{users,invitations,stations,me,settings,index}.ts`, `packages/db/prisma/schema/{auth,system}.prisma`
+ a migration, `apps/web/src/server/{actor,auth,orpc,router}.ts`, `apps/web/src/app/{sign-in,station}/**`,
`apps/web/src/app/(app)/{users,stations,layout}.tsx` and related, `apps/web/src/app/(app)/settings/**` (Email card),
`apps/web/src/app/api/health/route.ts`, `apps/worker/src/**` (email job), `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/{users,stations}.spec.ts`, `docs/decisions.md` (email provider = Resend).

## Success criteria

1. **Invite-only:** an email with no open invitation (and not in `ADMIN_EMAILS`) can't create an account, and no
   magic-link email is sent for it. A revoked or expired invitation behaves the same. An accepted invitation gives
   exactly its roles.
2. **Deactivation:** after `users.deactivate`, the user's existing session cookie and bearer token get
   `UNAUTHORIZED` on the next request, their station activation is ended, and signing in again is refused.
3. **Last admin:** demoting or deactivating the only active Admin fails with `errors.users.lastAdmin`; acting on
   yourself fails with `errors.users.self`.
4. Every `users.*`, `invitations.*` and `stations.*` procedure succeeds for Admin and fails with `FORBIDDEN` for
   Picker, Packer, QA and Shipper (allowed + forbidden test each).
5. **Station actor:** after a PIN unlock, mutations carry `stationId` in `AuditEvent` and `OrderStageEvent`, and the
   actor has exactly the user's role permissions (a Picker can't pack; an Admin can open settings).
6. **Switching:** unlocking as B while A is active ends A's activation with `SWITCHED_USER`; A's next request from
   that station acts as B, never as A.
7. **Idle lock:** with `lastActivityAt` older than the idle limit, the next request returns `errors.station.locked`
   and the activation ends with `IDLE`; `station.touch` within the limit keeps it open; a background read doesn't
   extend it. Uses a fake clock, no sleeps.
8. **PIN lockout:** 5 wrong PINs lock that user's PIN for 15 minutes on every station; wrong PIN and unknown user
   give the same error; a correct PIN resets the counter.
9. **No secrets out:** a test serializes every response and audit row from a session that sets a PIN, issues a
   badge, registers a station and sets the Resend key. It finds no PIN, no PIN hash, no badge hash and no station
   token, and the badge code appears only in the `issueBadge` response.
10. **Revoked station:** after `stations.revoke`, the device's next request finds no station and gets the
    sign-in page; its activation ended with `STATION_REVOKED`.
11. **Email:** creating an invitation enqueues exactly one `email.send` job in the same transaction (rolled back
    with it). The Resend adapter sends the right request and idempotency key (recorded fixture). 429/5xx retry and
    4xx doesn't. With no key, the log sender is used and health shows `email: "unconfigured"`.
12. **Preferences:** changing language and theme persists on the user, and survives sign-out and a different
    device or station.
13. **E2E (desktop):** an admin invites a user; the test reads the invitation, signs in as the invitee via the
    logged magic link, and sees only their role's nav. The admin deactivates them and their open page bounces to
    sign-in.
14. **E2E (tablet):** an admin issues a badge and the print view shows a QR code and the text code; the admin
    registers the device as a station; the lock screen shows; a packer unlocks with a PIN
    and then switches to another user via badge scan (typed into the input); the clock advances past the idle
    limit and the lock screen returns.
15. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus the Playwright suite.

## Decisions (2026-10-20)

1. **Email provider:** Resend, through its HTTP API (no SDK). Recorded in `docs/decisions.md` when this ships.
2. **Unlock:** tap your name + PIN, or scan your badge alone. PINs needn't be unique.
3. **PIN and badge are admin-managed.** Users can't set or change their own PIN.
4. **Station permissions = the user's roles**, including Admin. The station only adds `stationId`.
   Reconfirmed at the ship review (2026-10-20) knowing the risk: a photographed admin badge or a guessed admin
   PIN gives full admin powers on any station. Not requiring a personal session for admin actions is deliberate.
5. **Badges are QR codes**, rendered server-side as SVG with the `qrcode` package (new dependency, approved with
   this spec), error correction level **Q** (~25% of the code can be damaged and still scan). The badge code's
   characters (uppercase Crockford base32 + `-`) fit QR's compact alphanumeric mode. The text code is printed
   under the QR as a fallback.
6. **Idle lock is global** (`Settings.stationIdleLockMinutes`), the same for Admins as for everyone else.
7. **Personal sessions** keep Better Auth's default: 7 days, extended with use.
8. **Invitation emails are in English.** No language picker.

## Open questions

None.
