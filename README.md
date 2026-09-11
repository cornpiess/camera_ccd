# Rainbow Camera

Minimal iOS camera: choose a camera profile, adjust a real aperture when a future/public iOS API reports support, and capture. This project requires an Expo Development Build; Expo Go cannot load its local Swift camera module.

The app's home-screen name is **彩虹相机** (`ios.infoPlist.CFBundleDisplayName`); the ASCII name `Rainbow Camera` is what Xcode uses for the product and scheme. Bundle identifier: `com.cornpiess.rainbowcamera`.

## Windows development

First replace the sample `ios.bundleIdentifier` in `app.json` with an identifier owned by your Apple team, then run:

```powershell
npm install
npx eas-cli login
npx eas-cli init
npx eas-cli device:create
npx eas-cli build:configure
npm run build:ios:dev
```

`device:create` registers the physical iPhone for an internal development build. Open the completed EAS build URL on that registered iPhone and install the development build. Then, from Windows:

```powershell
npm start
```

Connect the phone to the same network (or use `npx expo start --dev-client --tunnel`) and open the installed development build. Do not run `expo run:ios` on Windows.

Swift/native dependency changes require a new EAS build. TypeScript, UI, gestures, and bundled/override JSON can refresh through Metro.

## CI: iOS dev builds on GitHub Actions

`eas build` on the Free plan allows only 15 iOS builds per month, and this project needs a fresh native build for every Swift change, so `.github/workflows/ios-dev-build.yml` builds the `.ipa` on a GitHub macOS runner instead. It does not use EAS, does not touch the Expo account, and therefore consumes no EAS quota.

The workflow is **manual-only** (`workflow_dispatch`). Trigger it from the repository's Actions tab, or:

```powershell
gh workflow run ios-dev-build.yml -f ref=main
```

### Prerequisites

The workflow fails fast with a clear error if any of these are missing.

1. **The repository must be public.** macOS runners consume minutes at a **10x multiplier**. On a private repository that leaves only ~200 macOS minutes per month (2,000 ÷ 10) — roughly 8 builds, fewer than the EAS Free plan. Public repositories get standard GitHub-hosted runners, including macOS, for free with no minute limit.

2. **Replace the placeholder bundle identifier.** `app.json` currently has `com.example.aperturecamera`. Apple does not allow registering the `com.example` prefix, so change it to a reverse-DNS identifier you control.

3. **Add four repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Where it comes from |
   |---|---|
   | `ASC_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → the 10-character Key ID |
   | `ASC_ISSUER_ID` | Same page, the Issuer ID shown above the key list |
   | `ASC_KEY_P8` | The full contents of the downloaded `AuthKey_XXXXXXXXXX.p8`, including the `BEGIN`/`END` lines. Apple only lets you download it once. |
   | `APPLE_TEAM_ID` | developer.apple.com → Membership → Team ID (10 characters) |

   These credentials let `xcodebuild -allowProvisioningUpdates` create and reuse the distribution certificate and Ad Hoc provisioning profile on its own, so no `.p12` or keychain juggling is needed.

4. **Register the test iPhone's UDID.** An Ad Hoc build only installs on devices already listed in your Apple Developer account:

   ```powershell
   npx eas-cli device:create
   ```

   This prints a URL; open it in Safari on the iPhone to register the device. It is free and does not consume EAS build quota.

### Installing the result

Each successful run creates a GitHub Release tagged `dev-r<run number>` containing the `.ipa` and an OTA `manifest.plist`, and prints an `itms-services://` link to the run summary. Open that link in **Safari** on the registered iPhone — do not use an in-app browser such as WeChat or QQ. The `.ipa` is also available as a regular artifact for 14 days.

Xcode Cloud is a viable alternative if the repository ever needs to go private: Apple Developer Program membership includes 25 compute hours per month with no multiplier.

## CI: TestFlight

`.github/workflows/ios-testflight.yml` builds an **App Store-signed** `.ipa` on a GitHub macOS runner and uploads it to App Store Connect, so testers install through TestFlight instead of by UDID. It does not use EAS either, and it consumes no EAS quota.

```powershell
gh workflow run ios-testflight.yml -f ref=main
```

### Prerequisites

The workflow fails fast if any of these are missing.

1. **The same four repository secrets** as the Ad Hoc workflow — same names, same values. No new secrets are needed. The API key must be a **Team Key** with the **Admin** or **App Manager** role; an individual key can neither manage certificates nor upload builds.
2. **An App Store Connect app record.** Uploading does not create the app. Register the explicit App ID `com.cornpiess.rainbowcamera` at developer.apple.com → Certificates, Identifiers & Profiles → Identifiers, then create the app in App Store Connect → Apps → **+** → New App. The bundle ID must match `app.json` exactly.
3. **Active agreements.** App Store Connect → Business → Agreements must have no pending agreement; uploads are rejected while one is unsigned.
4. **An app icon.** Not enforced by the workflow, but a build without one is hard to identify in TestFlight and cannot pass App Store review.

**No UDID registration is needed** — that is the main advantage over the Ad Hoc workflow.

### Build numbers

`CFBundleVersion` comes from `ios.buildNumber` in `app.json`, overridden in CI with `${{ github.run_number }}` through `app.config.js`. App Store Connect rejects an upload whose build number is not higher than the previous one, so the run number keeps it monotonic. `CFBundleShortVersionString` still comes from `expo.version`.

### After the upload

The build appears under TestFlight → Builds as **Processing** for 5–30 minutes. Then:

- **Internal testers** (up to 100, must be App Store Connect users) — test immediately, no review.
- **External testers** (up to 10,000, email address only) — the first build needs Apple Beta App Review, usually 1–2 days.

Export compliance is pre-answered by `ITSAppUsesNonExemptEncryption: false` in `app.json`, so there is no per-build questionnaire. The `.ipa` is also kept as a workflow artifact for 30 days.

## Calibration

On the camera screen, long-press with three fingers for about two seconds. Import a JSON file from Files, paste JSON, reload the saved override, or reset to bundled defaults. A valid import is stored in the app Documents directory as `camera-profiles.override.json` and applies immediately. Invalid data shows a validation error and does not replace the active configuration.

## Verification

```powershell
npm run typecheck
npm run lint
npm run doctor
```

The AVFoundation/Core Image implementation and future variable-aperture integration must be compiled on macOS (CI, see above) and verified on physical iPhone hardware. The adapter intentionally reports variable aperture unsupported until an Apple public SDK API can be compiled and runtime-checked; it does not guess a private or unreleased API.
