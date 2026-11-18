# Flutter handoff: passkey sign-in in the native app

The backend already supports passkeys for the web app (`docs/handoff/frontend-passkeys.md`). The Flutter app uses the
**same endpoints and the same passkeys**: a passkey saved on the website through iCloud Keychain or Google Password
Manager also works in the app, and the other way round. This document covers what is native-specific.
API reference: `docs/API.md` §2 "Passkeys". All paths are under `/api/v1` on `https://qrouter.ayenz.my.id`.

## How native passkeys work here

- Passkeys belong to the **RP ID `stillgpt.ayenz.my.id`** (the web app's domain), not to the API host.
- The OS lets the app use them only if that domain vouches for the app:
  - **Android:** `https://stillgpt.ayenz.my.id/.well-known/assetlinks.json` lists the package name + signing certificate
    SHA-256. The signed response's origin is `android:apk-key-hash:<base64url(sha256 cert)>`. The backend accepts it only
    for certificates in `PASSKEY_ANDROID_CERT_SHA256`.
  - **iOS:** `https://stillgpt.ayenz.my.id/.well-known/apple-app-site-association` lists `TEAMID.bundle.id` under
    `webcredentials`, and the app has the Associated Domains entitlement `webcredentials:stillgpt.ayenz.my.id`. The
    origin is `https://stillgpt.ayenz.my.id`.
- App requests send **no `Origin` header**. The backend then uses RP ID `stillgpt.ayenz.my.id` automatically. Don't add a
  fake Origin.

## Setup checklist (one time)

| # | Who | Step |
|---|---|---|
| 1 | owner | Pick the app id. Proposal: Android package **and** iOS bundle id `id.ayenz.stillgpt`. Changing it later means new association files. |
| 2 | Flutter | Android signing: get SHA-256 of the **debug** keystore and the **upload/release** keystore (`cd android && ./gradlew signingReport`). If the app is on Google Play with Play App Signing, also the **app signing key** SHA-256 (Play Console → Test and release → App integrity). |
| 3 | owner | Apple Developer **Team ID** (developer.apple.com → Membership). Needs a paid Apple Developer account. |
| 4 | backend | Set on the server (`.env`), restart: `PASSKEY_ANDROID_PACKAGE=id.ayenz.stillgpt`, `PASSKEY_ANDROID_CERT_SHA256=<debug>,<release>,<play>` (colon hex, comma-separated), `PASSKEY_IOS_APP_IDS=<TEAMID>.id.ayenz.stillgpt` |
| 5 | backend | Check the generated files: `curl https://qrouter.ayenz.my.id/.well-known/assetlinks.json` and `…/apple-app-site-association` |
| 6 | web frontend | Publish those two files **byte-for-byte** on the web domain (see "Web frontend part" below) |
| 7 | anyone | Verify: Google `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://stillgpt.ayenz.my.id&relation=delegate_permission/common.get_login_creds` lists the app; Apple `https://app-site-association.cdn-apple.com/a/v1/stillgpt.ayenz.my.id` returns the JSON (Apple's CDN can lag up to a day) |

## Web frontend part (StillGPT-Frontend, Cloudflare static assets)

1. Add `public/.well-known/assetlinks.json` and `public/.well-known/apple-app-site-association` (**no extension**), with the
   content of the backend endpoints from step 5:
   ```bash
   curl -fsS https://qrouter.ayenz.my.id/.well-known/assetlinks.json -o public/.well-known/assetlinks.json
   curl -fsS https://qrouter.ayenz.my.id/.well-known/apple-app-site-association -o public/.well-known/apple-app-site-association
   ```
2. In `public/_headers`:
   ```
   /.well-known/apple-app-site-association
     Content-Type: application/json
   /.well-known/assetlinks.json
     Content-Type: application/json
   ```
3. After deploying, check that both URLs return **200 JSON** with **no redirect**. Today they return the SPA's `index.html`,
   which both Android and iOS reject.
4. Re-copy the files whenever the backend's env (step 4) changes.

## App configuration

**Android**
- `minSdkVersion` ≥ 28 (Credential Manager). Device needs Google Play services and a screen lock.
- `applicationId` = the package from step 1.
- The SHA-256 of whatever key signs the build you test must be in step 4, debug included.

**iOS**
- iOS 16+.
- Xcode → Runner → Signing & Capabilities → **Associated Domains** → `webcredentials:stillgpt.ayenz.my.id`
  (ends up in `Runner.entitlements`). During development you can use `webcredentials:stillgpt.ayenz.my.id?mode=developer`
  to skip Apple's CDN (the device must be in Developer Mode).
- Bundle id = step 1, team = step 3.

**Package**
Use a passkey plugin that wraps Android Credential Manager and iOS AuthenticationServices and accepts/returns WebAuthn
JSON, for example [`passkeys`](https://pub.dev/packages/passkeys) (Corbado) or `credential_manager` (Android) plus a small
iOS channel. Check the chosen package's current API: field names differ between packages and versions. What matters is the
JSON the backend sends and expects, below.

## Protocol (same as web)

### Sign in
```
POST /auth/passkey/options                          (no auth, no Origin)
  ← { challenge_id, options: PublicKeyCredentialRequestOptionsJSON }
       options = { challenge, rpId: "stillgpt.ayenz.my.id", timeout: 60000, userVerification: "required" }   (no allowCredentials)
OS sheet → user picks a passkey + biometric
POST /auth/passkey/verify  { challenge_id, response: AuthenticationResponseJSON }
  ← { user, access_token, token_type, expires_in, refresh_token }        (same as POST /auth/login)
```
`AuthenticationResponseJSON` (all binary fields **base64url**, no padding):
```json
{ "id": "<credential id>", "rawId": "<same>", "type": "public-key",
  "response": { "clientDataJSON": "…", "authenticatorData": "…", "signature": "…", "userHandle": "…" },
  "clientExtensionResults": {}, "authenticatorAttachment": "platform" }
```

### Add a passkey (signed in)
```
POST /me/passkeys/options                           (Authorization: Bearer <access_token>)
  ← { challenge_id, options: PublicKeyCredentialCreationOptionsJSON }
       options.rp = { id: "stillgpt.ayenz.my.id", name: "StillGPT" }, options.user = { id, name: email, displayName },
       authenticatorSelection = { residentKey: "required", userVerification: "required" }, excludeCredentials: [...]
OS sheet → "Save a passkey for StillGPT?" + biometric
POST /me/passkeys  { challenge_id, response: RegistrationResponseJSON, name? }   ← 201 passkey
```
`RegistrationResponseJSON`:
```json
{ "id": "…", "rawId": "…", "type": "public-key",
  "response": { "clientDataJSON": "…", "attestationObject": "…", "transports": ["internal", "hybrid"] },
  "clientExtensionResults": {}, "authenticatorAttachment": "platform" }
```
If a plugin returns standard base64 or separate fields, convert to this shape and to **base64url** before posting.

### Manage
`GET /me/passkeys`, `PATCH /me/passkeys/:id {name}`, `DELETE /me/passkeys/:id`, and `GET /me` → `sign_in`.
Same as web (`docs/handoff/frontend-passkeys.md` Flow 4).

## UX in the app
- Login screen: primary button "Sign in with passkey", then email/password below.
- After a password login with `sign_in.passkeys == 0`: offer "Use fingerprint next time?" → add passkey.
- Settings → Security: list / rename / remove, same rules as web (`409 last_sign_in_method`).
- Store the refresh token in `flutter_secure_storage`, same as password login (`docs/API.md` §2 "Client guidance").

## Errors
Same table as `frontend-passkeys.md`. Native-specific:
| Symptom | Likely cause |
|---|---|
| Android: "no credentials" / `NoCredentialException` on a device that has the passkey | assetlinks.json missing/wrong on the web domain, or the build's signing SHA-256 not listed |
| Android: backend `400 passkey_invalid` on register, `401` on sign-in | the build's certificate is not in `PASSKEY_ANDROID_CERT_SHA256` (origin mismatch) |
| iOS: "Application … is not associated with domain" | Associated Domains entitlement or AASA wrong / not yet on Apple's CDN (use `?mode=developer` while testing) |
| `401 passkey_not_found` | passkey removed on the server; the OS still shows it |
| User cancelled | plugin-specific cancel exception: ignore silently |

## Testing
- Android emulator: an image **with Google Play**, a Google account signed in and a screen lock set. Passkeys sync via
  Google Password Manager, so one made on the web (Chrome, same Google account) shows up in the app.
- iOS: a real device or simulator signed into iCloud with Keychain on. Associated domains need a signed build with your team.
- Backend e2e tests cover the Android origin path (`test/e2e/passkeys-native.test.ts`).
