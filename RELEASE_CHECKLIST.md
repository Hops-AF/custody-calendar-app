# First Release: Reliable Personal Calendar

Scope: local-only iOS-first custody planning, complete backup/restore, undo/history, and opt-in exchange reminders. This is not shared-account synchronization, messaging, verified agreements, or an App Store submission.

Phase-two work is tracked separately in [SHARED_SETUP.md](SHARED_SETUP.md). The first-release checks below remain relevant to the personal calendar.

## Automated validation

- [x] 63 tests pass: custody calculations, calendar layout logic, legacy migration, complete backup round-trip, malformed/oversized backup rejection, atomic undo, history limits, serialized writes, failed saves/restores, concise error feedback, recovery, reminder conflicts/overrides, cancellation/deduplication, and daylight-saving gaps.
- [x] iOS and Android JavaScript bundle exports succeed. These are not signed applications or device UI validation.
- [x] Whitespace and patch checks pass.
- [x] Compatible dependency patches applied, including the critical shell-quote advisory.

## Device validation before distribution

Use the separate `Custody Release QA` simulator with invented household data. Do not reset the user's original simulator.

- [x] Finish setup and verify the household survives a full app close/relaunch.
- [ ] Open Settings and the entry editor on small/large iPhones; check large text, VoiceOver, keyboard visibility, and icon tap targets.
- [x] Save a complete JSON backup to Files. Import it, verify the preview, cancel once, then restore and compare all household data and history.
- [x] Reject an unsupported-version backup without changing the saved document. Malformed JSON and oversized files are also covered by automated tests.
- [x] Delete an entry and undo it. Reset the household and recover it through undo.
- [x] Open local history and restore a selected prior snapshot, retaining the pre-restore household as a new history record.
- [ ] Replace a generated schedule and restore its prior snapshot on-device.
- [x] Verify corrupt-startup recovery and failed-save feedback in a test-only storage environment, including while the entry editor is open.
- [x] Deliver five-second test notifications in foreground and background; tap the background test notification to reopen the calendar. Verify names remain hidden in the test alert.
- [x] Confirm two planned reminders; change lead time to cancel elapsed triggers (zero), change back (two), then disable reminders without a scheduling error.
- [ ] Test notification permission allowed and denied, schedule edits, disabling, and lock-screen privacy on a physical iPhone.
- [ ] Verify foreground/background local notification delivery and taps opening the correct date, including a cold launch.
- [ ] Repeat core backup/restore and notification checks on Android before advertising Android release readiness.

## Simulator results, September 10, 2026

Tested in Expo Go 55 on the isolated iPhone 17 Pro simulator running iOS 26.4. Sample household: Alex and Jordan; Sam and Lee; 26 generated every-other-weekend entries. The original user simulator was not used for data-changing tests.

- Setup, calendar, entry editing, native time picker, and blank-parent new entries worked. The saved note and exchange details remained after a full Expo Go terminate/relaunch.
- The JSON backup saved to On My iPhone and reopened through the native document picker. Its preview showed two parents, two children, 26 entries, and one schedule. After restore, an exact comparison verified all household fields, imported history, and a retained pre-restore snapshot.
- Deleting an entry reduced the upcoming count from eight to seven; undo restored it to eight. Reset reopened the empty setup wizard; undo recovered the household.
- Making only the QA storage directory read-only caused a real native write failure. The pending edit remained in memory. Restoring write access and tapping Retry saved it successfully. Directory permissions were restored afterward.
- Corrupting only the QA main save produced the recovery screen instead of a new household. Use recovery copy restored the 26-entry household. Safety copies of the QA saves were retained before fault injection.
- An unsupported-version file was rejected. The entire persisted document, including history, matched its pre-attempt snapshot afterward.
- Local test notifications appeared over both the app and the iPhone home screen. A background notification tap returned to Calendar. These are test-alert checks, not proof of real exchange delivery, cold-launch date routing, or physical-device behavior. Test reminders were disabled afterward.

### Issues fixed during testing

- A raw native storage exception filled almost the entire screen, blocking entry access. Save errors now use short actionable text; verified in the list and entry editor, with a regression test for oversized native error messages.
- The CSV action still called itself a backup. It now says it exports a report, not a restorable backup, and the section is named Share and export.

### Still unverified

Small/large device coverage, full VoiceOver navigation, large-text layouts, ordinary software-keyboard behavior, permission-denied flows, generated-schedule replacement, and actual exchange-date notification routing remain open. Toggling the simulator keyboard did not establish a reliable software-keyboard visibility check; the original hardware-keyboard preference was restored. Do not treat this simulator pass as public-distribution approval.

## Release gates

- [ ] Review and resolve or explicitly assess remaining dependency advisories. On SDK 57 (September 22, 2026) the audit reports 13 moderate, zero high, zero critical, all in Expo build/config tooling (`@expo/cli`, `@expo/config-plugins`, `xcode`, `uuid`) rather than app runtime code. npm's suggested "fix" downgrades Expo and must not be applied.
- [x] Move from the canary toolchain to a tested, supported stable SDK before public distribution. Upgraded to Expo SDK 57.0.24 / React Native 0.86.3 on September 22, 2026: expo-doctor 21/21, 83 tests, iOS/Android bundle exports, and an Expo Go 57 simulator pass of Calendar, My Days, Entries (editor and date picker), Reports, and Settings. RN 0.86 removed `StyleSheet.absoluteFillObject`, which silently broke the entry editor overlay; fixed, with a regression test.
- [ ] Create and test a signed development/release build. Expo Go and bundle export are insufficient release evidence.
- [ ] Set final app identifiers, release version/build numbers, app icon, privacy disclosures, and distribution configuration.
- [ ] Complete physical-device tests and a real external-backup recovery drill before TestFlight or App Store distribution.

No cloud account, remote push service, or Apple Developer enrollment is needed to develop the local features. Signing and distribution remain separate work.
