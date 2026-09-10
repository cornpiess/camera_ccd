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

## Calibration

On the camera screen, long-press with three fingers for about two seconds. Import a JSON file from Files, paste JSON, reload the saved override, or reset to bundled defaults. A valid import is stored in the app Documents directory as `camera-profiles.override.json` and applies immediately. Invalid data shows a validation error and does not replace the active configuration.

## Verification

```powershell
npm run typecheck
npm run lint
npm run doctor
```

The AVFoundation/Core Image implementation and future variable-aperture integration must be compiled on macOS (CI, see above) and verified on physical iPhone hardware. The adapter intentionally reports variable aperture unsupported until an Apple public SDK API can be compiled and runtime-checked; it does not guess a private or unreleased API.
