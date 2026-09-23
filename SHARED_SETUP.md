# Phase Two: Shared Co-parenting

Implemented locally, not connected to a live Supabase project. No real family data has been uploaded. Keep this in a test build until the live-service checks below pass.

## Connect the service

1. Create a dedicated Supabase development project. Choose its region and billing plan deliberately; the app does not provision either. Start with invented families.
2. Apply the files in `supabase/migrations` in filename order through the SQL editor or your migration workflow. Use a dedicated Auth project: account deletion removes that project's signed-in Auth user.
3. Enable email authentication and confirmation. Configure custom SMTP first: Supabase's built-in sender uses fixed link-only templates ("Follow the link below to sign in") that cannot be edited without custom SMTP, so app sign-in cannot work on it. Then edit **both** the **Magic link or OTP** template (existing accounts) and the **Confirm sign up** template (first sign-in creates the account) to show `{{ .Token }}`. The app verifies emailed codes, not browser links. Then add a migration or run once: `revoke execute on function public.rls_auto_enable() from public, anon, authenticated;` if the project was created with automatic RLS (clears two Security Advisor warnings). Configure production email delivery, suitable OTP expiry, rate limits, and abuse protection before launch. See [Supabase email OTP setup](https://supabase.com/docs/guides/auth/auth-email-passwordless).
4. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local`, using `.env.example` as the field reference. Never embed a service-role key, secret key, database password, or personal access token.
5. Restart Expo with `npx expo start --clear`. Rebuild native development clients for the added SecureStore/Crypto dependencies. Expo Go is not release validation.
6. Run the live checks below before connecting real families. Row-level policies and transactional functions are required, not optional. See [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

Without configuration, the app shows "Shared service not connected." There is no public demo database or simulated synchronization fallback.

## Sharing boundaries

- Shared: two parent names, child names, colors, custody dates, selected children, holiday flags, exchange times/places, explicit request reasons, membership, and shared decisions.
- Not uploaded: private entry notes, home-address fields, phone numbers, reporting preferences, recovery history, or backup files. Exchange places can themselves be sensitive and are shown in the preview.
- Shared data is not end-to-end encrypted. Backend administrators can access it. Do not claim otherwise in privacy disclosures.
- The creator explicitly selects their parent identity. The invited parent must accept the starting schedule; joining alone is not approval.
- The personal calendar stays separate. It is not overwritten, uploaded automatically, or synchronized to the shared workspace. Its local reminders, reports, and backups still use only the personal plan.
- Household names, children, colors, and primary-parent order are established in the starting plan. After acceptance, this version supports period/exception requests, not shared household-structure edits or recurring-rule editing.
- Children and caregivers do not receive shared accounts in this phase. A parent has full workspace visibility; do not invite a child or caregiver as a parent.

## Access and decisions

- Email-code sign-in supports both new and existing accounts. Native sessions use SecureStore, in bounded chunks to accommodate older Keychain item limits. See [Expo SecureStore](https://docs.expo.dev/versions/v55.0.0/sdk/securestore/).
- Invitations are bound to a verified email, single use, and expire in seven days. Only the random secret's hash is stored server-side. Creating another invitation revokes earlier invitations for the workspace.
- Share the code through the system share sheet. Generating an invitation is not the same as sending it. Email verification establishes email-account control, not legal parenthood.
- Owners can revoke invitations, remove the other parent, or delete the workspace after confirmation. Co-parents can leave. Revocation stops future server access, not existing screenshots, exports, or information already viewed.
- Either parent can propose changes. Only the other can accept or decline; authors can withdraw their own non-initial requests. Silence never becomes acceptance.
- Acceptance is transactional: lock the workspace, check the base revision, update the plan, increment the revision, record the decision, and mark competing pending requests stale. Before/after data stays in request history.
- A counterproposal is another pending request. It does not accept or automatically withdraw the original.

## Synchronization limits

- Refresh on opening, foregrounding, and every 30 seconds while active, plus manual refresh. The last successful check is visible. This is polling, not real-time push.
- Shared state is returned as a consistent database snapshot. A proposal retry keeps its request ID to avoid duplication. After an uncertain response, refresh before retrying other actions.
- Offline changes/approvals are not queued. Network failures never count as confirmed decisions. Shared memory state clears on failed synchronization, sign-out, account switching, or lost access. Solo mode remains available offline. There is no durable shared draft/outbox.
- Requests include pending and recent resolved items, up to 300 total. Activity shows the latest 100 events. Older records remain on the server until workspace deletion.
- Shared push/reminders, shared reports/backup export, protected child access, activities, conversations, and expenses are not part of this implementation.

## Deletion and retention

- In-app account deletion requires an actual sign-in in the last 15 minutes. Sign out and verify a fresh code if needed; token refresh alone does not satisfy the check.
- Deletion removes the Auth user and their memberships. Sole-member workspaces are deleted. With another member remaining, ownership transfers if needed and the shared plan, names, and decision history stay available to that parent. Pending requests by the deleted account are withdrawn; user references are nulled and invitations revoked.
- Deleting a workspace removes its live plan, memberships, requests, invitations, and events for both parents.
- Cloud account deletion does not erase personal device data or exported copies. Local reset remains recoverable, not a secure erase.
- Before public launch, document provider backup retention/deletion timelines, support escalation, dispute handling, and privacy terms. Live database deletion is not a promise of immediate removal from backups or external copies. Shared history is not a tamper-proof legal record.

## Verification

`npm test` runs the actual migrations in isolated PostgreSQL (PGlite) with an invented Auth schema and three fictional users. No cloud service is contacted. Tests cover RLS isolation, denied direct writes, invitations, initial consent, self-approval denial, server input validation, pending/declined/withdrawn states, stale revisions, retry IDs, revocation, history, and deletion.

September 10, 2026 checks: all 82 tests pass, and iOS/Android bundle exports succeed. These are not signed native builds or live two-device verification. Simulator inspection of phase two was blocked by the locked Mac. The full dependency audit reports 33 affected packages (22 moderate, 11 high, zero critical); dependency/security cleanup remains a public-release gate.

Remaining live release gates:

- [x] Apply migrations to a dedicated Supabase development project; run its security advisor. Done September 23, 2026 on `custody-calendar-dev` (East US), applied as one transaction. Anonymous reads, writes, and RPC calls verified denied from outside. Advisor: 0 errors; remaining warnings are the intended signed-in RPCs (SECURITY DEFINER with internal membership checks) and the intended policy-less `custody_private.invitations`.
- [ ] Test real OTP delivery/expiry/throttling, session restoration, sign-out, and recovery with two accounts on separate devices.
- [ ] Invite, join, review/accept the starting plan, propose, counterpropose, decline, withdraw, and accept; verify synchronization on both devices.
- [ ] Race approvals and access removal through independent clients. Serial PGlite tests do not prove concurrent network behavior.
- [ ] Interrupt connections during writes; verify no false success or duplicates. Switch accounts during a slow response.
- [ ] Revoke access while another device is open; verify refresh hides data and direct API requests fail.
- [ ] Test account deletion against real Supabase Auth tables, including sole-member deletion and two-parent ownership transfer.
- [ ] Test keyboards, large text, screen readers, smaller/larger screens, and secure-session persistence in signed builds.
- [ ] Complete remaining first-release gates in `RELEASE_CHECKLIST.md`, including the remaining dependency-advisory review and physical-device checks. (The Expo canary migration is complete: SDK 57.)
- [ ] Publish support, privacy, retention, and account-deletion disclosures before submission.
