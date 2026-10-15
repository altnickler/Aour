# iOS release plan

**Status: not released.** Aour currently ships as an installable PWA. A PWA is **not** an App Store app. Nothing here should be described as an App Store release until a signed build has been built, tested, submitted and approved.

## Phase 1: PWA (done in this repo)

- Installable to the Home Screen: manifest, `apple-touch-icon`, standalone display, safe-area layout, offline shell via the service worker.
- Sign-in uses 6-digit email codes, which work *inside* the installed app. Magic links would open Safari.
- In-app install guidance (Share → Add to Home Screen), because iOS has no install prompt.
- Web push to Home-Screen PWAs is possible on iOS 16.4+, but deliberately not built yet.

## Phase 2: Native shell with Capacitor (recommended next step)

Use **Capacitor 8** (current major) to wrap the existing app. All of `src/` is reused, and `src/core` plus `src/data/api.ts` are already framework-free.

Native value to add (guideline 4.2 risk: Apple rejects "repackaged websites"):

| Feature | Plugin / approach | Why it matters |
|---|---|---|
| **Push notifications**: "Happy hour starts in 30 min at a place you saved" | `@capacitor/push-notifications` + a Supabase scheduled function | Genuinely useful, and clearly native |
| **Sign in with Apple** (native sheet) | `@capacitor-community/apple-sign-in` → `supabase.auth.signInWithIdToken` | Smooth sign-in. Also required by guideline 4.8 *if* we add Google or other social logins |
| Location (when in use) | `@capacitor/geolocation` with a clear purpose string | "Near me" without Safari prompts |
| Share sheet | `@capacitor/share` | Share rankings and collections |
| Haptics | `@capacitor/haptics` | Feedback on rating saves (web haptics don't work on iOS) |
| Camera / photo picker | `@capacitor/camera` | Better visit photos |
| Offline rankings | Persist the React Query cache (`@tanstack/query-persist-client`) | The app opens instantly with your list |
| Home Screen widget (later) | Swift WidgetKit extension reading a shared App Group | "Happening now near you" |

Steps:
1. `npm i @capacitor/core @capacitor/ios && npx cap init Aour app.aour.ios --web-dir dist && npx cap add ios`.
2. Configure deep links (associated domains `applinks:aour.app`) so shared links open the app.
3. Add plugins behind a small `platform` module so the PWA keeps working.
4. TestFlight beta with local users for 2–4 weeks.

## App Store compliance checklist

- [x] **Account deletion in-app** (5.1.1(v)): Settings → Delete account permanently removes data. If Sign in with Apple is enabled, also **revoke the Apple token** via Apple's REST API during deletion; this needs a small server function holding the Apple key.
- [ ] **Privacy nutrition label**:
  - Contact info: email (app functionality, linked to user).
  - User content: ratings, reviews, photos.
  - Identifiers: user ID.
  - Coarse location: not linked, not stored.
  - Usage data: if analytics is enabled.
  - No tracking; no ATT prompt needed.
- [ ] **Privacy policy URL** (`/privacy`): needs legal review first.
- [ ] **Age rating:** the app is centred on alcohol. Answer the questionnaire's alcohol question as frequent. Expect an 18+ rating under Apple's updated age ratings *(verify current options)*. Consider an age confirmation at sign-up.
- [ ] **User-generated content** (1.2): we already have reporting, auto-hide on reports, admin removal, user suspension and published terms. Add the ability for users to **block** other users before submission.
- [ ] **Permissions:** purpose strings for location, camera, photos and notifications; request only in context, as the PWA already does.
- [ ] **Minimum functionality** (4.2): ship with push, native Sign in with Apple, share and offline behaviour, not just a web view.
- [ ] **Demo account for App Review**, with seeded *real* listings in production.
- [ ] Screenshots (6.7" and 6.1"), app icon from the official logo (replace the placeholder mark).

## Costs and timeline

- Apple Developer Program **$99/year**. A Mac with Xcode 26+ is required for builds (or a cloud Mac CI).
- Rough timeline after the PWA is stable:
  - Capacitor shell + native features: **2–3 weeks**
  - TestFlight: **2–4 weeks**
  - Review: **days to 2 weeks**, with possible back-and-forth

## When to consider a fully native (SwiftUI) app

Only if usage justifies it: for example heavy offline use, maps performance, or widgets as a core feature. The domain logic in `src/core` is small, pure and covered by tests, so porting it to Swift is mechanical, and the Supabase backend stays the same.
