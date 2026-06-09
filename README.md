# Custody Calendar (iOS & Android)

A React Native / Expo app for tracking child custody schedules and generating custody reports. This is the native mobile version of the [self-contained web app](https://github.com/Hops-AF/custody-calendar).

## Features

- **Configure parents and children** — set a primary parent and any number of children
- **Custody entries** — record date ranges, which children are present, and notes
- **Calendar view** — a color-coded month grid showing who the child stays with each night; unassigned nights default to the primary parent, and conflicting entries are flagged
- **Schedule generator** — auto-create entries for common arrangements:
  - Primary + Every Other Weekend (Friday or Saturday start)
  - Joint / Alternating Weekly
- **Reporting & analysis** — custom range, quarter, or presets (YTD, last 12 months, calendar year), with per-parent night counts and percentages, filterable by child
- **CSV export** — share a report via the native share sheet
- **Automatic persistence** — all data is saved locally on the device (AsyncStorage); nothing is lost when you close the app

## How custody nights are counted

The **primary parent is the default custodian**. You only enter entries for periods when a *non-primary* parent has the child; every night not covered by an explicit entry is attributed to the primary parent. An entry from `begin` to `end` covers the nights `begin … end‑1` (handoff happens on the end day).

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

- `App.js` — the entire application (UI, state, persistence, calendar, reporting, export)
- `index.js` — Expo entry point

## Notes

- Data lives only on the device. Use **Export CSV** to back up or share your records.
- This project currently uses a canary Expo SDK build; if `npm install` reports peer-dependency conflicts, run `npm install --legacy-peer-deps`.
