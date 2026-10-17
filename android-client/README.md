# Android client

Kotlin Android SMS collection client for the Web Data Clipboard backend.

This module currently contains the project skeleton and the connection configuration
screen (REQ-202610-1263). The SMS receiver, foreground service, retry queue and release
build flow are delivered by requirements 15–17 and plug into the seams described below.

## Requirements

- JDK 17
- Android SDK Platform 34 and Build Tools 34.0.0
- Gradle is provided through the checked-in wrapper (Gradle 8.7)

Point the build at the SDK with `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or create a
`local.properties` file (ignored by Git):

```properties
sdk.dir=/path/to/android-sdk
```

## Build and test

Run from this directory:

```sh
./gradlew :app:assembleDebug        # build the debug APK
./gradlew :app:testDebugUnitTest    # JVM + Robolectric tests
./gradlew :app:lintDebug            # Android lint
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## Configuration screen

`MainActivity` exposes the fields required by PRD §5.3:

| Field | Persistence | Notes |
| --- | --- | --- |
| Server address | `server_url` | HTTPS only; HTTP is limited to `localhost`, `127.0.0.1`, `::1`, and `10.0.2.2`; a missing scheme becomes `https://`; trailing slash removed |
| API Token | `api_token` | Sent as `X-DCC-Token`; must match backend `API_SECRET_TOKEN` |
| Device name | `device_name` | Display name, 1–128 characters |
| Service switch | `service_enabled` | Persists the user's intent; the foreground service is wired by REQ-202610-1265 |
| SMS permission | Android runtime permission | `RECEIVE_SMS` check/request plus a system-settings fallback after permanent denial |

`StorageHelper` stores the form in the `dcc_client_config` SharedPreferences file and
generates a stable `android_<24 hex>` device id on first launch. The device id is shown at
the bottom of the screen and reused for every collect request.

The form is validated locally before saving: URL syntax, non-empty token and device name.
Field-level errors are shown through the Material text-field error slot.

## Test connection

The "test connection" action validates the current form (without overwriting saved values)
and sends a simulated report to `POST {server}/api/v1/collect`:

```json
{
  "device_id": "android_<generated>",
  "device_name": "<configured name>",
  "platform": "android",
  "sender": "DCC-Test",
  "raw_content": "【网络剪切板】测试连接验证码：123456，5 分钟内有效。",
  "timestamp": 1728950400000
}
```

The request carries `X-DCC-Token: <configured token>` and uses the same envelope as a real
device report. The result card distinguishes:

- **Success** — HTTP 200, `code=200`; shows `collection_id` and the extracted code
  (`123456` proves the extraction chain is working).
- **Rejected** — a non-2xx response or non-200 envelope code; shows the HTTP status and the
  server message (401 means the token is wrong or missing, 404 usually means the server URL
  is wrong).
- **Network error** — DNS, TLS, timeout or connection failures; shows the underlying detail
  when available.

Invalid local configuration is reported before any network call, with per-field messages.

## Security notes

- Cleartext HTTP is enabled only in debug builds and URL validation permits it only for
  `localhost`, `127.0.0.1`, `::1`, and `10.0.2.2`. Release builds are HTTPS-only
  (`usesCleartextTraffic=false`).
- The API token is stored in SharedPreferences; the app disables backups and device transfer
  for all app data (`data_extraction_rules.xml`).
- `RECEIVE_SMS` is declared with `android.hardware.telephony` as not required so the app can
  still be installed on non-telephony devices.
- No SMS content is written to disk by this module; the future receiver should hand messages
  straight to the upload queue and clear it after a successful report.

## Project layout

```
app/src/main/java/com/dcc/clipboard/
├── MainActivity.kt                 # configuration screen + permission flow
├── data/
│   ├── ClientConfig.kt             # persisted form model
│   ├── ConfigValidator.kt          # pure URL/token/name validation
│   └── StorageHelper.kt            # SharedPreferences persistence
└── network/
    ├── CollectRequestFactory.kt    # simulated collect payload
    ├── CollectResponseParser.kt    # {code,message,data} envelope parser
    ├── TestConnectionClient.kt     # blocking HTTP client (call off the main thread)
    └── TestConnectionResult.kt     # success / rejected / network error
```

## Tests

`testDebugUnitTest` covers:

- URL normalization and validation rules (https upgrade, ports, paths, rejected schemes).
- The simulated payload fields and the backend response envelope (success, 401, malformed
  bodies, non-200 envelope codes).
- Real HTTP round-trips against an in-process stub server, including the token header and
  401 error stream handling.
- SharedPreferences round-trips and stable device id generation (Robolectric).
- MainActivity save/echo behaviour and field-level validation (Robolectric).

Kotlin formatting: four-space indentation, lines no longer than 120 columns, PascalCase
types, camelCase members, and no wildcard imports.
