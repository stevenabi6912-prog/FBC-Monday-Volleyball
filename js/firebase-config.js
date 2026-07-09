// ============================================================================
//  FIREBASE CONFIG  —  PASTE YOUR OWN PROJECT KEYS HERE
// ============================================================================
//
//  1. Go to https://console.firebase.google.com/  → create a project (free
//     "Spark" plan is all you need — do NOT upgrade to Blaze).
//  2. In the project, add a Web app (</> icon). Firebase shows you a
//     `firebaseConfig` object that looks EXACTLY like the one below.
//  3. Copy the values from there and paste them over the placeholders below.
//  4. Enable Firestore Database (see README.md for the exact steps + rules).
//
//  Nothing else in the app needs editing to get data flowing.
// ============================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyBJ-Ek07VQeqtOg33Mz4lqvrNYFB9Es9ws",
  authDomain:        "fbc-monday-volleyball.firebaseapp.com",
  projectId:         "fbc-monday-volleyball",
  storageBucket:     "fbc-monday-volleyball.firebasestorage.app",
  messagingSenderId: "664157270026",
  appId:             "1:664157270026:web:b10ac904e8c378d4bd6ff3",
};

// ============================================================================
//  ADMIN PASSCODE  —  change this anytime.
//  This is light convenience-gating for the room, NOT real security.
//  (Anyone technical can read it in the source — that's fine for our use.)
// ============================================================================
export const ADMIN_PASSCODE = "6912";
