# Custody Calendar (iOS & Android)

A React Native / Expo app for tracking child custody schedules and generating custody reports. This is the native mobile version of the [self-contained web app](https://github.com/Hops-AF/custody-calendar).

## Features

- **Configure parents and children** — set a primary parent and any number of children
- **Custody entries** — record date ranges, which children are present, and notes
- **Guided household setup** — add parents, children, and per-child recurring schedules in a four-step intake flow
- **Calendar view** — a color-coded month grid with per-child filters, split-color sibling schedules, cross-month range selection, and same-child conflict detection
- **Schedule generator** — auto-create entries for common arrangements:
  - Every Other Weekend (~80/20)
  - Every Other Weekend + Midweek (~70/30)
  - Joint / Alternating Weekly (50/50)
  - 2-2-3 rotation (50/50)
- **Reporting & analysis** — custom range, quarter, or presets (YTD, last 12 months, calendar year), with per-parent custody-day counts and percentages, filterable by child
- **CSV export** — share a report via the native share sheet
- **Automatic persistence** — all data is saved locally on the device (AsyncStorage); nothing is lost when you close the app

## How custody days are counted

Each selected calendar date counts as one custody day for each included child. Explicit entries take precedence; dates without an explicit entry are attributed to the primary parent in reports. If the same child is assigned to two parents on one date, that child-day is flagged and excluded from the percentage until corrected. Different children may legitimately have different parents on the same date and are shown as a split-color calendar day.

## Tech stack

- [Expo](https://expo.dev/) (SDK 55) + React Native
- `@react-native-async-storage/async-storage` — local persistence
- `@react-native-community/datetimepicker` — native date picker
- `expo-file-system` + `expo-sharing` — CSV export

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

- `App.js` — application UI, state, persistence, calendar, and export
- `custody-engine.js` — tested per-child custody ownership and reporting logic
- `custody-engine.test.js` — ownership, conflict, split-schedule, and percentage tests
- `index.js` — Expo entry point

## Notes

- Data lives only on the device. Use **Export CSV** to back up or share your records.
- Run `npm test` to verify the custody calculation engine.
- This project currently uses a canary Expo SDK build; if `npm install` reports peer-dependency conflicts, run `npm install --legacy-peer-deps`.
