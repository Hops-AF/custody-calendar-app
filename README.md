# Custody Calendar (iOS & Android)

A React Native / Expo app for tracking child custody schedules and generating custody reports. This is the native mobile version of the [self-contained web app](https://github.com/Hops-AF/custody-calendar).

## Features

- **Configure parents and children** — set a primary parent and any number of children
- **Custody entries** — record date ranges, which children are present, and notes
- **Guided household setup** — add parents, children, and per-child recurring schedules in a four-step intake flow
- **Calendar view** — a color-coded month grid with per-child filters, split-color sibling schedules, cross-month range selection, and same-child conflict detection
- **iOS-style navigation** — fixed tabs for Calendar, My Days, Entries, Reports, and Settings
- **Daily plans** — browse a date without editing; inspect per-child ownership, missing exchange details, and overlapping entries. Creating a range requires an explicit parent choice and Save.
- **My Days** — a simplified child-facing view of today and upcoming changes, without parent notes
- **Daily plan sharing** — open the system share sheet with a factual snapshot of the selected date; no parent notes or implied agreement
- **Focused entry editing** — virtualized entry summaries open into a dedicated editor with native date and time pickers
- **Schedule generator** — auto-create entries for common arrangements:
  - Every Other Weekend (~80/20)
  - Every Other Weekend + Midweek (~70/30)
  - Joint / Alternating Weekly (50/50)
  - 2-2-3 rotation (50/50)
- **Reporting & analysis** — custom range, quarter, or presets (YTD, last 12 months, calendar year), with per-parent custody-day counts and percentages, filterable by child
- **CSV export** — share a report via the native share sheet
- **Visible local saving** - save status, retryable errors, and a last-good recovery copy
- **Complete backup and restore** - JSON files with household, entries, schedules, settings, and retained history; preview before replacement
- **Undo and local history** - recover recent household changes, including deleted entries and replaced schedules
- **Exchange reminders** - opt-in local notifications with private lock-screen text by default
- **Shared family workspace** - optional email-code accounts, invitations, a separate shared calendar, two-parent approvals, and shared history. Requires a configured backend; see [shared setup and release gates](SHARED_SETUP.md).

## How custody days are counted

Each selected calendar date counts as one custody day for each included child. Explicit entries take precedence; dates without an explicit entry are attributed to the primary parent in reports. If the same child is assigned to two parents on one date, that child-day is flagged and excluded from the percentage until corrected. Different children may legitimately have different parents on the same date and are shown as a split-color calendar day.

## Tech stack

- [Expo](https://expo.dev/) (SDK 55) + React Native
- `@react-native-async-storage/async-storage` — local persistence
- `@react-native-community/datetimepicker` — native date picker
- `expo-file-system` + `expo-sharing` - report exports and complete JSON backups
- `expo-document-picker` - backup selection and restore preview
- `expo-notifications` - local exchange reminders; no push server or account required

## Protect your data

The personal calendar saves automatically **on this device only**. The optional shared workspace is separate and does not back up your personal calendar. Wait for **Saved on this device** before closing. If a save fails, keep the app open, retry saving, or export a complete backup of the current in-memory household. Uninstalling the app, clearing its storage, or losing the device may lose local data. Neither undo history nor the recovery copy is an external backup.

Use **Settings > Save complete backup**, then save the JSON file somewhere you trust using the system share sheet. Keep a copy outside this device. The app can confirm that it prepared a file, but cannot confirm that you saved it externally. Backups contain private notes, contact details, and retained history and are not encrypted by the app.

Use **Settings > Restore backup file** to choose that JSON file. The app validates its format and previews the date and household counts before asking to replace your data. Invalid files leave your household unchanged. A successful restore retains the previous household in local history, subject to the size limits below. Imported reminders start off; enable them on the destination device after reviewing the schedule.

**CSV, ICS, and the child-facing HTML page are reports or sharing formats, not complete restorable backups.** The separate self-contained web app has its own storage behavior; these mobile backups are not a web-import format.

### Undo, recovery, and limits

- The header undo button reverses the latest household change. Settings > Review changes restores the household to just before a selected change; newer household changes are replaced, and that restoration is itself undoable.
- History includes up to 20 changes. Older snapshots are discarded when storage limits require it. Consecutive typing in a field is grouped. Reporting and navigation preferences do not create undo entries.
- Reset household starts setup again but retains local history and a recovery copy. It is **not permanent erasure** of private data.
- If startup cannot read or validate a save, the recovery screen offers retry, the last-good copy, or a backup file. It does not silently create a fresh household over unreadable data.
- Saves are serialized; the previous valid save is copied before the main record is replaced. This protects against some failures, not device loss or every storage failure.
- Current safety limits: 1 MB household, 1.8 MB stored document including history, 4 MB import file, 5,000 entries, and 500 schedule assignments. Changes that cannot retain their required undo snapshot are rejected rather than silently losing recovery.
- History is local, editable data, not an independently verified record of agreement or an audit trail.

### Exchange reminders

Enable reminders in Settings and allow notifications when prompted. Choose 15 minutes, one hour, or one day before the exchange. Names and meeting places remain hidden unless explicitly enabled; parent notes are never included.

Reminders use each child's effective custody schedule, including primary-parent defaults and holiday overrides. A reminder requires a genuine parent transition and a valid exchange time on the incoming entry. Conflicting assignments and missing times are flagged rather than guessed. A return to the primary parent without an explicit timed entry cannot generate a reminder.

The app keeps the earliest 48 reminders within the next 90 days, refreshing while open and when returning to the foreground. Open it regularly to extend that window. Editing a schedule replaces stale reminders; disabling reminders cancels them. A reminder tap opens the exchange date. Times follow the device's current time zone, not a separately configured household zone. Device notification settings, Focus modes, and operating-system delivery behavior can affect alerts, so do not rely on them as the only exchange reminder.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Xcode](https://developer.apple.com/xcode/) for the iOS Simulator, and/or [Android Studio](https://developer.android.com/studio) for the Android emulator
- The [Expo Go](https://expo.dev/go) app if you want to run on a physical device

### Install

```bash
git clone https://github.com/Hops-AF/custody-calendar-app.git
cd custody-calendar-app
npm install
```

### Run

```bash
npm start        # start the Metro dev server (then press i / a)
npm run ios      # open directly in the iOS Simulator
npm run android  # open directly in the Android emulator
```

Scan the QR code with the Expo Go app to run on a physical device.

## Project structure

- `App.js` - application UI, calendar, and report export
- `local-store.js` / `use-household-store.js` - versioned persistence, validation, backup, undo, and recovery
- `reminder-plan.js` / `use-reminders.js` - custody-aware planning and local notification scheduling
- `reliability-ui.js` - backup, history, reminder settings, and recovery screens
- `custody-engine.js` — tested per-child custody ownership and reporting logic
- `custody-engine.test.js` — ownership, conflict, split-schedule, and percentage tests
- `index.js` — Expo entry point

## Notes

- The personal calendar remains local. The optional Shared family workspace requires backend setup and explicit two-parent approval; it does not synchronize the personal calendar. Sharing a daily snapshot does not notify or record approval from the other parent. Parent notes remain in personal records and CSV exports, but are omitted from My Days, child pages, and shared-workspace uploads. My Days is a presentation mode, not an access-control boundary; other tabs remain available on the device.
- UI regression tests cover seven-column calendar alignment, color contrast, primary-parent defaults, conflicting entries, and note-free sharing.
- Data lives only on the device. Use **Save complete backup** for recoverable backups; use CSV for reports.
- Run `npm test` for custody calculations, calendar logic, storage failures, backup validation, undo, and reminder planning. These tests do not prove notification delivery or on-device UI behavior.
- See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for first-release validation and outstanding device checks.
- This project currently uses a canary Expo SDK build; if `npm install` reports peer-dependency conflicts, run `npm install --legacy-peer-deps`.
