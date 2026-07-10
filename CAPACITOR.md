# Android app (Capacitor)

The Android app is a [Capacitor] wrapper around the existing static web game. It
bundles the **mobile** skin (`index.html` only — classic UI is excluded) into a
WebView so the game runs offline; multiplayer still uses PeerJS and needs
internet to reach the broker.

## Layout

- `capacitor.config.json` — `appId: com.ageofepochs.app`, `webDir: www`.
- `scripts/build-web.mjs` — stages the shipped files into a gitignored `www/`
  (run via `npm run build:web`). Excludes `classic.html`/`classic-style.css`.
- `js/vendor/` — PeerJS + qrcode-generator, vendored locally (were unpkg) so
  the offline bundle has them. The web build uses them too.
- `js/native.js` — Capacitor-only deep-link bridge (no-op on the web). Routes an
  incoming `?join=`/`?host=` App Link into the game's join flow.
- `.well-known/assetlinks.json` — served by the site (GitHub Pages) to verify
  Android App Links. **Fingerprint placeholder must be filled in (see below).**
- `android/` — generated native project (App Links intent-filter, immersive
  theme, immersive-sticky mode in `MainActivity.java`).

## Prerequisites (not installed on this machine)

- **JDK 17+** (Capacitor 8 / AGP 8). `brew install --cask temurin` or install via
  Android Studio.
- **Android Studio + SDK**, or command-line tools with `ANDROID_HOME` set.
- Node.js (already present).

## Build a debug APK

```bash
npm install                 # once
npm run build:web           # stage www/
npx cap copy android        # push www/ into the native project
npx cap open android        # → build in Android Studio
#   ...or headless:
cd android && ./gradlew assembleDebug
#   → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run sync` (= build:web + `cap sync`) is the shortcut after JS/asset changes.

### Rebuild & reinstall (verified working on this machine)

The JDK is the one bundled with Android Studio; the SDK is at `~/Library/Android/sdk`.
After editing web code or native files:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd /Users/mini/Documents/GitHub/aoe
npm run build:web                                   # only if web files changed
npx cap copy android                                # only if web files changed
cd android && ./gradlew assembleDebug --no-daemon
ADB="$ANDROID_HOME/platform-tools/adb"
$ADB devices                                        # find your device id
$ADB -s <device-id> install -r app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` (git-ignored by Capacitor) already points Gradle at the SDK.

### Emulator (already created: AVD `aoe_pixel`, API 35 arm64)

```bash
"$ANDROID_HOME/emulator/emulator" -avd aoe_pixel &
```

## Two manual steps left

1. **App icon** — `logo.png` is 800×580 (not square, under 1024²), so it wasn't
   auto-generated to avoid a squished icon. Provide a 1024×1024 square
   `assets/icon-only.png` (optionally `icon-foreground.png` / `icon-background.png`
   / `splash.png`) and run `npx capacitor-assets generate --android`. Until then
   the default Capacitor launcher icon is used.

2. **App Links fingerprint** — deep-linking (a shared join link opening the app)
   only verifies once `.well-known/assetlinks.json` contains your signing key's
   SHA-256 fingerprint. Get it from the keystore that signs the build:

   ```bash
   # debug builds (auto-created on first build at ~/.android/debug.keystore):
   keytool -list -v -keystore ~/.android/debug.keystore \
     -alias androiddebugkey -storepass android -keypass android | grep SHA256
   ```

   Paste the `SHA256:` value into `sha256_cert_fingerprints` in
   `.well-known/assetlinks.json`, commit, and let GitHub Pages redeploy. A release
   build (or Play App Signing) uses a different key — add that fingerprint too.
   Verify on-device:

   ```bash
   adb shell am start -a android.intent.action.VIEW \
     -d "https://ageofepochs.com/index.html?join=TESTID"
   # should open the app into the join flow, not the browser
   ```

## Known limitations (MVP)

- Multiplayer needs internet (PeerJS cloud broker) — same as web.
- The render loop pauses when the app is backgrounded; a long background during a
  lockstep match can trip peer timeouts.
- Saves stay browser file download/upload (may be clunky in the WebView); revisit
  with `@capacitor/filesystem` if needed.

[Capacitor]: https://capacitorjs.com
