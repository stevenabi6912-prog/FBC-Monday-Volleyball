# 🏐 FBC Pickup Volleyball Tournaments

A mobile-first, install-to-home-screen web app for Monday night pickup volleyball at church.
Registered roster → live check-in → auto-balanced teams → two-court round-robin → live
standings → season history. **Public view is read-only; editing is behind a passcode.**

- **Frontend:** plain HTML/CSS/vanilla JS — 100% static, hosts on **GitHub Pages**, no server.
- **Backend:** **Firebase Firestore** with real-time listeners (free **Spark** plan — no Cloud
  Functions, no Blaze).
- **PWA:** manifest + icons + service worker so it installs on a phone home screen.

---

## 1. Create the Firebase project (free Spark plan)

1. Go to <https://console.firebase.google.com/> → **Add project**. Name it anything
   (e.g. `fbc-volleyball`). You can turn Google Analytics off. **Do not upgrade to Blaze** —
   everything here runs on the free Spark plan.
2. In the project, click the **`</>` (Web)** icon to *Add a web app*. Give it a nickname.
   You do **not** need Firebase Hosting (we use GitHub Pages).
3. Firebase shows you a `firebaseConfig = { ... }` snippet. Keep that tab open — you'll paste
   those values in step 3.

## 2. Enable Firestore

1. Left sidebar → **Build → Firestore Database → Create database**.
2. Choose a location near you. Start in **production mode** (we'll paste rules in step 4).
3. That's it — no collections to create by hand. The app creates documents automatically the
   first time you register a player or check someone in.

## 3. Paste your keys

Open [`js/firebase-config.js`](js/firebase-config.js) and replace the placeholders with the
values from step 1.3:

```js
export const firebaseConfig = {
  apiKey:            "AIza…",
  authDomain:        "fbc-volleyball.firebaseapp.com",
  projectId:         "fbc-volleyball",
  storageBucket:     "fbc-volleyball.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:1234567890:web:abc123",
};

// Change the admin passcode here anytime (default 6912):
export const ADMIN_PASSCODE = "6912";
```

> The Firebase web config is **not a secret** — it's meant to ship in client code. Access is
> controlled by the Firestore **security rules** (step 4), not by hiding these keys.

## 4. Firestore security rules

Firestore → **Rules** tab → paste this → **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Anyone can READ (public scoreboard). No one can write without being signed in…
    // …except we don't use auth, so see the trade-off note below.
    match /{document=**} {
      allow read: if true;
      allow write: if true;   // <-- open writes. See the trade-off below.
    }
  }
}
```

### The trade-off (please read)

This app gates editing with a **client-side passcode (6912)** for *convenience*, so the room's
public phones show a read-only view. But a client passcode **cannot** be enforced by Firestore —
anyone technical could write directly to your database while `allow write: if true`.

For a small church rec night this is usually an acceptable trade-off (worst case: someone
messes up a score and you fix it or Reset). You have three options, in order of effort:

1. **Open writes (above)** — simplest. Fine for a trusted, low-stakes setting.
2. **Lock reads to your app's domain** isn't possible with rules, but you can **disable writes
   after your season** by switching `allow write` to `if false` from the console whenever you're
   not actively using it.
3. **Real security → add Firebase Anonymous Auth + an admin claim.** This is the only way to
   *truly* enforce "only admins write," and it requires adding Firebase Auth (still free on
   Spark). Out of scope for this simple build, but the data model is compatible if you want to
   add it later — change the rule to `allow write: if request.auth != null` and gate the admin
   UI on a signed-in admin.

**Recommended for now:** option 1, and press **Reset** (which archives to History first) if
anyone fiddles.

## 5. Deploy to GitHub Pages

```bash
cd "FBC Monday Volleball"
git init
git add .
git commit -m "FBC Pickup Volleyball app"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: “Deploy from a branch” →
Branch: `main` / `(root)` → Save.** Wait ~1 minute; your app is live at
`https://<you>.github.io/<repo>/`.

- The included **`.nojekyll`** file makes sure GitHub serves the `js/` folder untouched.
- Open the URL on a phone → browser menu → **Add to Home Screen** to install it like an app.

---

## Using it on a Monday

1. **Roster tab** (admin) — register players once: full name, birthdate, gender. Age is computed
   from birthdate, so it stays current every year. Duplicate names are allowed (you'll get a
   gentle warning) and age is always shown so you can tell the two Johns apart.
2. **Tonight → Check-in** (admin) — tap names as people arrive. Public phones see the live list.
3. **Tonight → Teams** — tap **Generate**. Teams of 6, extras become subs (max one per team,
   assigned to a team for the night). Ages and genders are balanced across teams. Each team gets
   a fresh funny name that hasn't been used in past weeks. **Regenerate** rebuilds from scratch
   (use before games start). **+ Late arrival** slots someone in *after* play starts — the app
   recommends "slot into a team" vs "form a new team" based on how many loose players there are,
   and a new team is auto-added to the remaining schedule without touching played games.
4. **Tonight → Schedule** — round-robin across 2 courts, first to 25 (win by 2). Admin taps **Enter score**.
5. **Tonight → Standings** — ranked by wins; ties share a rank (no tiebreaker).
6. **Reset Night** (admin, re-enter passcode) — **archives tonight to History**, then clears
   check-ins and tonight's teams/schedule/scores. **Roster and History are never cleared.**
7. **History tab** — browse every past Monday. Also feeds the "don't reuse team names" logic.

Admin mode: tap **🔓 Admin**, enter **6912**. A banner shows you're in admin mode; tap **Lock**
to return to the public read-only view.

---

## Firestore data model

Everything lives in one small database:

| Path | What it holds |
|------|----------------|
| `players/{autoId}` | `{ name, birthdate:"YYYY-MM-DD", gender, createdAt }` — the permanent roster. |
| `app/tonight` | The single live-night doc: `{ checkedIn:[playerId], teams:[…], schedule:{rounds:[…]}, playStarted, generatedAt }`. Reset clears this (but keeps roster & history). |
| `app/meta` | `{ usedTeamNames:[…] }` — every funny name ever used, so weeks don't repeat. |
| `history/{autoId}` | One archived Monday: `{ date, attendance:[…], teams:[…], matches:[…], standings:[…], teamNames:[…], createdAt }`. Player **names** are denormalized here so history stays readable even if a player is later deleted. |

**`app/tonight` shapes:**

```jsonc
// team
{ "id": "team_0_…", "name": "Bouncing Penguins", "starterIds": ["…"], "subId": "…" | null }

// schedule
{ "rounds": [
  { "round": 1, "matches": [
    { "id":"m_…", "court":1, "aTeamId":"…", "bTeamId":"…",
      "scoreA":21, "scoreB":15, "played":true, "bye":false }
  ]}
]}
```

Standings are **computed on the fly** from `schedule` (not stored) — wins first, ties share rank.

---

## Project structure

```
index.html                 App shell + views (Tonight / Roster / History)
css/styles.css             Mobile-first styles, big tap targets
js/firebase-config.js      ← PASTE YOUR KEYS HERE (+ admin passcode)
js/logic.js                Pure logic: age, team balancing, scheduling, standings, names
js/app.js                  Firestore real-time wiring + all UI rendering
manifest.webmanifest       PWA manifest
sw.js                      Service worker (installability only; never caches live data)
icons/                     App icons (192, 512, maskable)
.nojekyll                  Tells GitHub Pages to serve files as-is
```

## Notes & tuning

- **Team size / passcode / score target** live as constants at the top of `js/logic.js`
  (`TEAM_SIZE`, `SCORE_TARGET`, `COURTS`) and `js/firebase-config.js` (`ADMIN_PASSCODE`).
- **Balancing** has no skill rating by design — it balances **age spread** (snake draft) and
  **gender** (swap passes) only.
- The service worker **never** caches Firestore traffic, so real-time updates are never stale.
  If you change the app code, bump `CACHE = "fbc-volley-v1"` in `sw.js` to force clients to update.
```
