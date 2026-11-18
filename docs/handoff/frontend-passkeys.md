# Frontend handoff: sign in with a passkey

Goal: on the login screen the user taps **"Sign in with passkey"**, confirms with fingerprint / Face ID / device PIN and is
signed in. No email, no password. In Settings → Security they can add, rename and remove passkeys.
Backend reference: `docs/API.md` §2 "Passkeys". All paths are under `/api/v1`.

## Library

Use `@simplewebauthn/browser` **v13** (matches the backend's `@simplewebauthn/server` v13):
```bash
npm i @simplewebauthn/browser@13
```
```ts
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
```
The backend's `options` objects go into these functions **unchanged** (`{ optionsJSON: options }`). Their results go back
**unchanged** as `response`. Do not base64-decode or reshape anything.

Requirements:
- The page must be served from `https://stillgpt.ayenz.my.id` (prod) or `http://localhost:<port>` listed in the backend's
  `CORS_ORIGINS` (dev). Passkeys are bound to the domain. A passkey made on localhost does not work on prod and vice versa.
- Every passkey call is a normal `fetch` from the page. The browser adds the `Origin` header, which the backend uses to
  pick the domain. Don't proxy these calls through another origin.

## Flow 1 — "Sign in with passkey" button (login screen)

```ts
async function signInWithPasskey() {
  const { challenge_id, options } = await post('/auth/passkey/options');          // no auth header
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });               // OS sheet: pick passkey + fingerprint
  } catch (e) {
    if (e.name === 'NotAllowedError') return;                                     // user cancelled / timed out: no error toast
    throw e;
  }
  const r = await post('/auth/passkey/verify', { challenge_id, response });
  // r === same shape as POST /auth/login: { user, access_token, token_type, expires_in, refresh_token }
  saveSession(r);                                                                 // reuse the password-login code path
}
```
- Show the button only if `browserSupportsWebAuthn()`.
- Put it **above** the email/password form as the primary action, e.g. "🔑 Sign in with passkey".
- Disable the button while the flow runs. One call to `/auth/passkey/options` per tap (a challenge is single-use, 5 min).

## Flow 2 — passkey autofill (optional, nice)

When the email field gets focus, the browser can suggest passkeys in its autofill dropdown.
```html
<input name="email" type="email" autocomplete="username webauthn" />
```
```ts
onMount(async () => {
  if (!(await browserSupportsWebAuthnAutofill())) return;
  const { challenge_id, options } = await post('/auth/passkey/options');
  try {
    const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: true });
    saveSession(await post('/auth/passkey/verify', { challenge_id, response }));
  } catch { /* aborted or ignored: the password form still works */ }
});
onUnmount(() => WebAuthnAbortService.cancelCeremony());
```
- Call `WebAuthnAbortService.cancelCeremony()` before starting Flow 1 (the button), because only one ceremony can run at a time.
- The challenge expires after 5 minutes. If the login page stays open longer, restart the autofill call (e.g. every 4 min
  or on window focus).

## Flow 3 — add a passkey (Settings → Security, signed in)

```ts
async function addPasskey() {
  const { challenge_id, options } = await authed.post('/me/passkeys/options');
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });                 // OS sheet: "Save passkey for StillGPT?"
  } catch (e) {
    if (e.name === 'InvalidStateError') return toast('This device already has a passkey for your account');
    if (e.name === 'NotAllowedError') return;                                     // cancelled
    throw e;
  }
  const passkey = await authed.post('/me/passkeys', { challenge_id, response });  // optional: name
  list.unshift(passkey);
  toast(`Passkey added (${passkey.name})`);
}
```
`passkey` = `{ id, name, provider, synced, backed_up, created_at, last_used_at }`.
- `name` defaults to the provider: "iCloud Keychain", "Google Password Manager", "Windows Hello", "1Password", "Bitwarden"…
  or "Passkey". Let the user rename it inline.
- `synced: true` → show "Synced via iCloud Keychain" (or whichever provider). It works on the user's other devices too.

### Nudge after password login (recommended)
After a successful **password** login, if `GET /me` → `sign_in.passkeys === 0` and `sign_in.passkeys_available` and
`browserSupportsWebAuthn()`, show a one-time card: "Sign in faster next time with your fingerprint → Add passkey" (Flow 3).
Remember "Not now" locally for ~30 days.

## Flow 4 — manage passkeys (Settings → Security)

| Action | Call |
|---|---|
| list | `GET /me/passkeys` → `{ data: [passkey] }` (oldest first) |
| rename | `PATCH /me/passkeys/:id` `{ name }` (≤ 60 chars after trimming) → `passkey` |
| remove | `DELETE /me/passkeys/:id` → `204` |

Row UI: name (editable) · provider/"synced" badge · "Added 12 Nov · Last used 2 h ago" · Remove.
Remove: confirm dialog: "Remove this passkey? You won't be able to sign in with it here. It may still appear on your
device; you can delete it in your password manager."
`409 last_sign_in_method` → "This is your only way to sign in. Set a password or add another passkey first."

## `GET /me` additions
```json
"sign_in": { "password": true, "passkeys": 2, "passkeys_available": true }
```
- `passkeys_available: false` → hide all passkey UI (the server isn't configured for passkeys).
- Use `password: false` to hide "Change password" or show "Set password" (not implemented yet).

## Errors to handle

| HTTP / `error.code` | Where | Message to show |
|---|---|---|
| `NotAllowedError` (browser) | any | nothing (user cancelled or timed out) |
| `InvalidStateError` (browser) | add | "This device already has a passkey for your account" |
| `400 invalid_challenge` | any | silently restart once, then "Please try again" |
| `400 passkey_invalid` | add | "Couldn't add the passkey. Try again" |
| `401 passkey_not_found` | sign in | "This passkey isn't linked to an account anymore. Sign in with your password." Optionally call `PublicKeyCredential.signalUnknownCredential({ rpId: options.rpId, credentialId: response.id })` so the device can hide it |
| `401` (other) | sign in | "Passkey sign-in failed" |
| `403 origin_not_allowed` | any | config bug, log it |
| `409 passkey_exists` | add | "This passkey is already added" |
| `409 too_many_passkeys` | add | "You can have up to 20 passkeys" |
| `409 last_sign_in_method` | remove | see Flow 4 |
| `503 passkeys_not_configured` | any | hide passkey UI |

## Testing locally
- Chrome DevTools → ⋮ → More tools → **WebAuthn** → "Enable virtual authenticator environment" → add an authenticator
  (ctap2, internal, resident keys ✓, user verification ✓). This lets you test without a fingerprint reader. Playwright can do
  the same through CDP (`WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator`).
- Use `http://localhost:5173` or `:4173` (already allowed by the backend).

## Checklist
- [ ] `@simplewebauthn/browser@13` installed
- [ ] Login: "Sign in with passkey" button (Flow 1), hidden when unsupported
- [ ] Login: autofill (Flow 2) with abort handling
- [ ] Session handling shared with password login (same response shape)
- [ ] Settings → Security: list / add / rename / remove (Flows 3–4), `last_sign_in_method` handled
- [ ] Post-login nudge to add a passkey
- [ ] Error table handled; `NotAllowedError` silent
- [ ] Respect `sign_in.passkeys_available`
