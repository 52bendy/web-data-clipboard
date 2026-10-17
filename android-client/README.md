# Android client

Android Kotlin SMS collection client. This module currently contains the
project skeleton, the configuration screen and the SMS broadcast receiver
(REQ-202610-1263 / REQ-202610-1264).

Kotlin formatting: four-space indentation, lines no longer than 120 columns,
PascalCase types, camelCase members, and no wildcard imports.

## Build

Requirements: JDK 17 and an Android SDK with platform 34 + build-tools 34.0.0.
The Gradle wrapper is committed, so no local Gradle installation is needed.

```sh
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # JVM tests for parsing/assembly/dedup
./gradlew :app:lintDebug            # Android lint
```

`local.properties` (git-ignored) may also point at the SDK:

```properties
sdk.dir=/path/to/android-sdk
```

## Configuration

The main screen stores the following values in `SharedPreferences`
(`StorageHelper`):

| Field | Description |
|---|---|
| Server URL | DCC backend base URL, e.g. `https://dcc.example.com`. HTTPS is required except for local development hosts (`localhost`, `127.0.0.1`, `10.0.2.2`). |
| API Token | Sent as the `X-DCC-Token` header. |
| Device name | Displayed by the backend and management console. |
| Collection enabled | Local kill switch checked by the receiver. |

The device id is generated once (`android-<uuid>`) and kept stable; it matches
the backend's device-id character set.

## SMS pipeline (REQ-202610-1264)

`AndroidManifest.xml` declares `RECEIVE_SMS` / `READ_SMS` and registers
`sms.SmsReceiver` for `android.provider.Telephony.SMS_RECEIVED`. The receiver is
protected by `android.permission.BROADCAST_SMS`, so only the telephony stack
can deliver the broadcast.

For each broadcast `SmsReceiver`:

1. Reads the `pdus` array and the optional `format` extra (`3gpp` for
   GSM/UMTS/LTE, `3gpp2` for CDMA; a missing format uses the platform's legacy
   decoder).
2. Decodes every PDU with `SmsMessage.createFromPdu`, taking
   `displayOriginatingAddress`, `displayMessageBody` and `timestampMillis`.
3. Concatenates all segments in PDU order into one logical SMS.
4. Computes a SHA-256 fingerprint over sender, body, timestamp and
   subscription id, then drops repeats seen within five minutes (bounded to
   the last 100 fingerprints, persisted in `SharedPreferences`).
5. Triggers `SmsReportDispatcher`, which POSTs the PRD §4.1.1 body to
   `/api/v1/collect` on a worker thread kept alive with `goAsync`. Failures are
   written to `PendingReportStore` for the retry layer in REQ-202610-1265.

Logcat evidence (sender is masked, message content is never logged):

```text
DccSmsReceiver: sms.received sender=138****8000 segments=2 length=58 timestamp=... subscription=1 fingerprint=...
DccSmsReport:   sms.report_triggered device=... fingerprint=... length=58
DccSmsReceiver: sms.report_finished success=true status=200 fingerprint=...
DccSmsReceiver: sms.duplicate_ignored fingerprint=...
```

### Multipart and dual-SIM notes

- A multipart SMS arrives as one broadcast containing all PDUs. Concatenation
  is done in array order (stable-sorted by PDU timestamp for OEMs that reorder
  the array), so `displayMessageBody` segments are joined without separators.
- Dual-SIM devices expose the subscription id in the broadcast's
  `subscription` extra. It is part of the dedup fingerprint so the same text
  received on two SIMs is reported twice, while a redelivery on one SIM is
  suppressed. The backend collect contract has no SIM field, so the id is not
  sent upstream.
- Some OEM ROMs (MIUI/HyperOS, EMUI, OriginOS) require additional
  "notification SMS" / autostart permissions; REQ-202610-1266 documents the
  device-specific setup.

## Manual acceptance on a real device

1. Install the debug APK, fill server URL/token/device name, tap **保存配置**.
2. Grant the SMS permission from the main screen.
3. Send a single SMS and a multipart SMS (or use an emulator:
   `adb emu sms send 10086 "验证码 839201"`).
4. Confirm the log lines above with
   `adb logcat -s DccSmsReceiver DccSmsReport DccSmsApiClient`.
5. Confirm the backend clipboard contains the concatenated text; trigger the
   same broadcast twice and verify `sms.duplicate_ignored` (no second upload).

## Follow-ups

- REQ-202610-1265 adds the foreground service, WorkManager retry queue and
  exponential backoff; `PendingReportStore` is the hand-off point.
- REQ-202610-1266 covers release signing, autostart guidance and the full
  real-device matrix.
- REQ-202610-1263's Gradle skeleton was not present in the repository when this
  task started, so this module establishes the minimal skeleton needed to host
  the receiver (manifest, `MainActivity`, `StorageHelper`, theme/layout).
