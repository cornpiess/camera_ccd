# Aperture Camera

Minimal iOS camera: choose a camera profile, adjust a real aperture when a future/public iOS API reports support, and capture. This project requires an Expo Development Build; Expo Go cannot load its local Swift camera module.

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

## Calibration

On the camera screen, long-press with three fingers for about two seconds. Import a JSON file from Files, paste JSON, reload the saved override, or reset to bundled defaults. A valid import is stored in the app Documents directory as `camera-profiles.override.json` and applies immediately. Invalid data shows a validation error and does not replace the active configuration.

## Verification

```powershell
npm run typecheck
npm run lint
npm run doctor
```

The AVFoundation/Core Image implementation and future variable-aperture integration must be compiled by EAS and verified on physical iPhone hardware. The adapter intentionally reports variable aperture unsupported until an Apple public SDK API can be compiled and runtime-checked; it does not guess a private or unreleased API.
