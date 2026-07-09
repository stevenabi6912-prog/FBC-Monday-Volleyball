// ============================================================================
//  app.js — UI + Firestore wiring for FBC Pickup Volleyball
//  Public view is read-only; all edits gated behind admin passcode (6912).
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, ADMIN_PASSCODE } from "./firebase-config.js";
import {
  ageFromBirthdate, generateTeams, generateTeamNames, buildSchedule,
  appendTeamToSchedule, computeStandings, planTeams, bestTeamForLateArrival,
  loosePlayerCount, SCORE_TARGET,
} from "./logic.js";

// ---------------------------------------------------------------------------
//  Firebase init
// ---------------------------------------------------------------------------
let db, offline = false;
try {
  const fbApp = initializeApp(firebaseConfig);
  db = getFirestore(fbApp);
} catch (e) {
  console.error("Firebase init failed — did you paste your config?", e);
  offline = true;
}

const tonightRef = () => doc(db, "app", "tonight");
const metaRef = () => doc(db, "app", "meta");
const playersCol = () => collection(db, "players");
const historyCol = () => collection(db, "history");

// ---------------------------------------------------------------------------
//  Local state (mirrors Firestore via listeners)
// ---------------------------------------------------------------------------
const state = {
  admin: false,
  players: [],                 // [{id, name, birthdate, gender}]
  tonight: { checkedIn: [], teams: [], schedule: { rounds: [] }, playStarted: false },
  history: [],                 // [{id, date, ...}]
  usedTeamNames: [],
  checkinSearch: "",
  rosterSearch: "",
};
const playersById = () => Object.fromEntries(state.players.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
//  Tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}
function requireAdmin() {
  if (!state.admin) { toast("Admin only — unlock first."); return false; }
  return true;
}

// ---------------------------------------------------------------------------
//  Navigation (tabs + subtabs)
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
  })
);
document.querySelectorAll(".subtab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".subview").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.sub).classList.add("active");
  })
);

// ---------------------------------------------------------------------------
//  Admin gate
// ---------------------------------------------------------------------------
$("#adminBtn").addEventListener("click", () => {
  if (state.admin) return; // already in; use Lock
  openModal({
    title: "Enter admin passcode",
    body: `<label>Passcode</label><input id="pc" type="password" inputmode="numeric" autocomplete="off" />`,
    okLabel: "Unlock",
    onOk: () => {
      const v = ($("#pc").value || "").trim();
      if (v === ADMIN_PASSCODE) { setAdmin(true); toast("Admin unlocked ✔"); return true; }
      toast("Wrong passcode"); return false;
    },
    afterOpen: () => $("#pc").focus(),
  });
});
$("#lockBtn").addEventListener("click", () => { setAdmin(false); toast("Locked — public view"); });
function setAdmin(on) {
  state.admin = on;
  document.body.classList.toggle("admin", on);
  $("#adminBanner").classList.toggle("hidden", !on);
  $("#adminBtn").textContent = on ? "👤 Admin" : "🔓 Admin";
  renderAll();
}

// ---------------------------------------------------------------------------
//  Modal helper
// ---------------------------------------------------------------------------
function openModal({ title, body, okLabel = "Save", onOk, cancelLabel = "Cancel", afterOpen }) {
  const root = $("#modalRoot");
  root.innerHTML = "";
  const back = el("div", "modal-backdrop");
  const m = el("div", "modal");
  m.innerHTML = `<h3>${esc(title)}</h3><div class="modal-body">${body}</div>
    <div class="modal-actions">
      <button class="cancel" type="button">${esc(cancelLabel)}</button>
      <button class="primary ok" type="button">${esc(okLabel)}</button>
    </div>`;
  back.appendChild(m);
  root.appendChild(back);
  const close = () => (root.innerHTML = "");
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  m.querySelector(".cancel").addEventListener("click", close);
  m.querySelector(".ok").addEventListener("click", async () => {
    const res = onOk ? await onOk() : true;
    if (res !== false) close();
  });
  if (afterOpen) afterOpen();
  return { close };
}

// ===========================================================================
//  FIRESTORE LISTENERS (real-time — every phone stays in sync)
// ===========================================================================
function startListeners() {
  if (offline) { renderAll(); return; }

  onSnapshot(query(playersCol(), orderBy("name")), (snap) => {
    state.players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRoster(); renderCheckin();
  }, (err) => console.error("players listener", err));

  onSnapshot(tonightRef(), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    state.tonight = {
      checkedIn: data.checkedIn || [],
      teams: data.teams || [],
      schedule: data.schedule || { rounds: [] },
      playStarted: !!data.playStarted,
      generatedAt: data.generatedAt || null,
    };
    renderCheckin(); renderTeams(); renderSchedule(); renderStandings();
  }, (err) => console.error("tonight listener", err));

  onSnapshot(metaRef(), (snap) => {
    state.usedTeamNames = (snap.exists() && snap.data().usedTeamNames) || [];
  }, (err) => console.error("meta listener", err));

  onSnapshot(query(historyCol(), orderBy("createdAt", "desc")), (snap) => {
    state.history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHistory();
  }, (err) => console.error("history listener", err));
}

// Write helper for the tonight doc (merge).
async function saveTonight(patch) {
  await setDoc(tonightRef(), patch, { merge: true });
}

// ===========================================================================
//  ROSTER / REGISTRATION
// ===========================================================================
$("#rosterSearch").addEventListener("input", (e) => { state.rosterSearch = e.target.value.toLowerCase(); renderRoster(); });
$("#addPlayerBtn").addEventListener("click", () => openPlayerForm());

function openPlayerForm(existing) {
  const p = existing || { name: "", birthdate: "", gender: "Male" };
  openModal({
    title: existing ? "Edit player" : "Register player",
    body: `
      <label>Full name</label>
      <input id="pName" type="text" value="${esc(p.name)}" placeholder="Full name" />
      <div id="dupWarn"></div>
      <label>Birthdate</label>
      <input id="pDob" type="date" value="${esc(p.birthdate)}" max="${new Date().toISOString().slice(0,10)}" />
      <label>Gender</label>
      <select id="pGender">
        <option ${p.gender === "Male" ? "selected" : ""}>Male</option>
        <option ${p.gender === "Female" ? "selected" : ""}>Female</option>
      </select>`,
    okLabel: existing ? "Save" : "Register",
    afterOpen: () => {
      const nameInput = $("#pName");
      const check = () => {
        const v = nameInput.value.trim().toLowerCase();
        const dup = state.players.some((x) => x.name.trim().toLowerCase() === v && x.id !== (existing && existing.id));
        $("#dupWarn").innerHTML = dup ? `<div class="warn">⚠ A player named "${esc(nameInput.value.trim())}" already exists. That's OK — age is shown next to each name to tell them apart.</div>` : "";
      };
      nameInput.addEventListener("input", check); check();
    },
    onOk: async () => {
      const name = $("#pName").value.trim();
      const birthdate = $("#pDob").value;
      const gender = $("#pGender").value;
      if (!name) { toast("Name is required"); return false; }
      if (!birthdate) { toast("Birthdate is required"); return false; }
      try {
        if (existing) await updateDoc(doc(db, "players", existing.id), { name, birthdate, gender });
        else await addDoc(playersCol(), { name, birthdate, gender, createdAt: serverTimestamp() });
        toast(existing ? "Player updated" : "Player registered ✔");
      } catch (e) { console.error(e); toast("Save failed — check config"); return false; }
    },
  });
}

function confirmDeletePlayer(p) {
  openModal({
    title: "Delete player?",
    body: `<p>Remove <strong>${esc(p.name)}</strong> from the roster permanently? This can't be undone.</p>`,
    okLabel: "Delete", cancelLabel: "Keep",
    onOk: async () => {
      try {
        await deleteDoc(doc(db, "players", p.id));
        // also drop from tonight's check-in if present
        if (state.tonight.checkedIn.includes(p.id))
          await saveTonight({ checkedIn: state.tonight.checkedIn.filter((id) => id !== p.id) });
        toast("Player deleted");
      } catch (e) { console.error(e); toast("Delete failed"); return false; }
    },
  });
}

function renderRoster() {
  const list = $("#rosterList");
  $("#rosterCount").textContent = state.players.length;
  const term = state.rosterSearch;
  const items = state.players.filter((p) => p.name.toLowerCase().includes(term));
  list.innerHTML = "";
  if (!state.players.length) { list.appendChild(emptyState("🏐", "No players yet", state.admin ? "Tap “+ Register” to add your first player." : "Registration is admin-only.")); return; }
  if (!items.length) { list.appendChild(emptyState("🔎", "No matches", "Try a different search.")); return; }

  items.forEach((p) => {
    const age = ageFromBirthdate(p.birthdate);
    const li = el("li", "list-item");
    li.innerHTML = `
      <div class="grow">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${age != null ? "Age " + age : "—"} · ${esc(p.gender || "")}</div>
      </div>`;
    if (state.admin) {
      const editB = el("button", "icon-btn", "✏️"); editB.title = "Edit";
      editB.addEventListener("click", () => openPlayerForm(p));
      const delB = el("button", "icon-btn danger", "🗑"); delB.title = "Delete";
      delB.addEventListener("click", () => confirmDeletePlayer(p));
      li.append(editB, delB);
    }
    list.appendChild(li);
  });
}

// ===========================================================================
//  CHECK-IN
// ===========================================================================
$("#checkinSearch").addEventListener("input", (e) => { state.checkinSearch = e.target.value.toLowerCase(); renderCheckin(); });

async function toggleCheckin(id) {
  if (!requireAdmin()) return;
  const set = new Set(state.tonight.checkedIn);
  set.has(id) ? set.delete(id) : set.add(id);
  try { await saveTonight({ checkedIn: [...set] }); }
  catch (e) { console.error(e); toast("Check-in failed"); }
}

function renderCheckin() {
  const list = $("#checkinList");
  const checked = new Set(state.tonight.checkedIn);
  $("#checkinCount").textContent = checked.size + " in";
  const term = state.checkinSearch;

  // Public view shows only who's checked in; admin sees the whole roster to toggle.
  let source = state.players;
  if (!state.admin) source = state.players.filter((p) => checked.has(p.id));
  const items = source.filter((p) => p.name.toLowerCase().includes(term));

  list.innerHTML = "";
  if (!state.admin && !checked.size) { list.appendChild(emptyState("🙌", "No one checked in yet", "Names appear here as they arrive.")); return; }
  if (state.admin && !state.players.length) { list.appendChild(emptyState("🏐", "Roster is empty", "Register players first (Roster tab).")); return; }
  if (!items.length) { list.appendChild(emptyState("🔎", "No matches", "Try a different search.")); return; }

  items.forEach((p) => {
    const age = ageFromBirthdate(p.birthdate);
    const on = checked.has(p.id);
    const li = el("li", "list-item" + (on ? " checked" : ""));
    li.innerHTML = `
      <div class="check">✓</div>
      <div class="grow">
        <div class="name">${esc(p.name)}</div>
        <div class="meta">${age != null ? "Age " + age : "—"} · ${esc(p.gender || "")}</div>
      </div>`;
    if (state.admin) { li.style.cursor = "pointer"; li.addEventListener("click", () => toggleCheckin(p.id)); }
    list.appendChild(li);
  });
}

// ===========================================================================
//  TEAMS  (generate / regenerate / late arrival)
// ===========================================================================
$("#genTeamsBtn").addEventListener("click", () => doGenerateTeams(false));
$("#regenTeamsBtn").addEventListener("click", () => doGenerateTeams(true));
$("#lateBtn").addEventListener("click", () => openLateArrival());

async function doGenerateTeams(isRegen) {
  if (!requireAdmin()) return;
  const checkedPlayers = state.players.filter((p) => state.tonight.checkedIn.includes(p.id));
  if (checkedPlayers.length < 2) { toast("Check in at least a couple players first"); return; }

  const plan = planTeams(checkedPlayers.length);
  const confirmMsg = isRegen
    ? "Rebuild teams from scratch for everyone checked in? Use this only before play has started."
    : "Generate teams for everyone checked in?";
  openModal({
    title: isRegen ? "Regenerate teams" : "Generate teams",
    body: `<p>${confirmMsg}</p>
      <div class="warn">${checkedPlayers.length} checked in → <strong>${plan.teams} teams</strong> (${plan.subs} sub${plan.subs === 1 ? "" : "s"}${plan.bench ? ", " + plan.bench + " on bench" : ""}).</div>`,
    okLabel: isRegen ? "Regenerate" : "Generate",
    onOk: async () => {
      const names = generateTeamNames(plan.teams, state.usedTeamNames);
      const teams = generateTeams(checkedPlayers, names);
      const schedule = buildSchedule(teams);
      try {
        await saveTonight({ teams, schedule, playStarted: false, generatedAt: serverTimestamp() });
        await reserveTeamNames(names);
        toast(isRegen ? "Teams regenerated ✔" : "Teams generated ✔");
        gotoSub("teams");
      } catch (e) { console.error(e); toast("Save failed"); return false; }
    },
  });
}

// Add the freshly used names to the meta doc so future weeks don't repeat them.
async function reserveTeamNames(names) {
  const merged = Array.from(new Set([...(state.usedTeamNames || []), ...names]));
  await setDoc(metaRef(), { usedTeamNames: merged }, { merge: true });
}

function renderTeams() {
  const area = $("#teamsArea");
  const teams = state.tonight.teams || [];
  const byId = playersById();
  area.innerHTML = "";
  if (!teams.length) {
    area.appendChild(emptyState("🧩", "No teams yet",
      state.admin ? "Check people in, then tap Generate." : "Teams appear here once the admin generates them."));
    return;
  }
  teams.forEach((t) => {
    const card = el("div", "team-card");
    const starters = t.starterIds.map((id) => byId[id]).filter(Boolean);
    const sub = t.subId ? byId[t.subId] : null;
    const avgAge = starters.length ? Math.round(starters.reduce((s, p) => s + (ageFromBirthdate(p.birthdate) ?? 0), 0) / starters.length) : "—";
    const males = starters.filter((p) => (p.gender || "").toLowerCase().startsWith("m")).length;
    let rows = starters.map((p) => playerChip(p, false)).join("");
    if (sub) rows += playerChip(sub, true);
    card.innerHTML = `<h3>${esc(t.name)}</h3>
      <div class="team-sub">${starters.length} starters${sub ? " + 1 sub" : ""} · avg age ${avgAge} · ${males}M / ${starters.length - males}F</div>
      <div class="players">${rows}</div>`;
    area.appendChild(card);
  });
}
function playerChip(p, isSub) {
  const age = ageFromBirthdate(p.birthdate);
  return `<div class="player-chip"><span class="badge${isSub ? " sub" : ""}">${isSub ? "SUB" : (age != null ? age : "—")}</span> ${esc(p.name)}${isSub && age != null ? " · " + age : ""}</div>`;
}

// ---- Late arrival ----------------------------------------------------------
function openLateArrival() {
  if (!requireAdmin()) return;
  if (!state.tonight.teams.length) { toast("Generate teams first"); return; }

  // players not currently checked in (or checked in but not on a team) can be added
  const onTeams = new Set();
  state.tonight.teams.forEach((t) => { t.starterIds.forEach((id) => onTeams.add(id)); if (t.subId) onTeams.add(t.subId); });
  const candidates = state.players.filter((p) => !onTeams.has(p.id));

  const options = candidates.map((p) => `<option value="${p.id}">${esc(p.name)} (age ${ageFromBirthdate(p.birthdate) ?? "?"})</option>`).join("");
  const waiting = candidates.filter((p) => state.tonight.checkedIn.includes(p.id)).length;
  const loose = loosePlayerCount(state.tonight.teams, waiting);
  const recommendNewTeam = loose >= 5; // subs + waiting can form a real team

  openModal({
    title: "Add late arrival",
    body: `
      <label>Who arrived?</label>
      <select id="lateWho">${options || '<option value="">— everyone is already on a team —</option>'}</select>
      <div class="warn">Recommendation: <strong>${recommendNewTeam ? "Form a NEW team" : "Slot into an existing team"}</strong>.
      There ${loose === 1 ? "is" : "are"} currently ${loose} loose player${loose === 1 ? "" : "s"} (subs + waiting).</div>
      <label>Action</label>
      <select id="lateAction">
        <option value="slot" ${recommendNewTeam ? "" : "selected"}>Slot into best existing team</option>
        <option value="new" ${recommendNewTeam ? "selected" : ""}>Form a new team (folds into schedule)</option>
      </select>`,
    okLabel: "Confirm",
    onOk: async () => {
      const pid = $("#lateWho").value;
      const action = $("#lateAction").value;
      if (!pid) { toast("No one to add"); return false; }
      const player = state.players.find((p) => p.id === pid);
      try {
        // ensure they're checked in
        if (!state.tonight.checkedIn.includes(pid))
          await saveTonight({ checkedIn: [...state.tonight.checkedIn, pid] });
        if (action === "new") await formNewTeamWith(player);
        else await slotIntoTeam(player);
      } catch (e) { console.error(e); toast("Add failed"); return false; }
    },
  });
}

async function slotIntoTeam(player) {
  const teams = state.tonight.teams.map((t) => ({ ...t, starterIds: [...t.starterIds] }));
  const targetId = bestTeamForLateArrival(teams, playersById(), player);
  const target = teams.find((t) => t.id === targetId);
  if (!target.subId) target.subId = player.id;      // fill empty sub slot
  else target.starterIds.push(player.id);           // otherwise add as extra starter
  await saveTonight({ teams });
  toast(`${player.name} → ${target.name}`);
}

async function formNewTeamWith(player) {
  // Pull loose players together: this new arrival + one sub from each team that
  // has one, until we reach ~6. Those subs move off their teams to the new one.
  const teams = state.tonight.teams.map((t) => ({ ...t, starterIds: [...t.starterIds] }));
  const newMembers = [player.id];
  for (const t of teams) {
    if (newMembers.length >= 6) break;
    if (t.subId) { newMembers.push(t.subId); t.subId = null; }
  }
  const names = generateTeamNames(1, [...state.usedTeamNames, ...teams.map((t) => t.name)]);
  const newTeam = {
    id: "team_new_" + newMembers.length + "_" + names[0].replace(/\s+/g, ""),
    name: names[0],
    starterIds: newMembers,
    subId: null,
  };
  teams.push(newTeam);
  const schedule = appendTeamToSchedule(state.tonight.schedule, teams.filter((t) => t.id !== newTeam.id).map((t) => t.id), newTeam.id);
  await saveTonight({ teams, schedule });
  await reserveTeamNames(names);
  toast(`New team "${newTeam.name}" added & scheduled ✔`);
  gotoSub("schedule");
}

// ===========================================================================
//  SCHEDULE + SCORE ENTRY
// ===========================================================================
function renderSchedule() {
  const area = $("#scheduleArea");
  const teams = state.tonight.teams || [];
  const sched = state.tonight.schedule || { rounds: [] };
  const nameOf = (id) => (teams.find((t) => t.id === id) || {}).name || "—";
  area.innerHTML = "";
  if (!sched.rounds || !sched.rounds.length) {
    area.appendChild(emptyState("📅", "No schedule yet", state.admin ? "Generate teams to build the round-robin." : "Appears once teams are set."));
    return;
  }
  // current round = first round with an unplayed match
  let currentRound = sched.rounds.length;
  for (const r of sched.rounds) { if (r.matches.some((m) => !m.bye && !m.played)) { currentRound = r.round; break; } }

  sched.rounds.forEach((r) => {
    const wrap = el("div", "round" + (r.round === currentRound ? " current" : ""));
    const head = el("div", "round-head");
    head.innerHTML = `<span class="rlabel">Round ${r.round}</span>` + (r.round === currentRound ? `<span class="pill">current</span>` : "");
    wrap.appendChild(head);

    r.matches.forEach((m) => {
      if (m.bye) {
        const b = el("div", "match");
        b.innerHTML = `<div class="teams"><span class="t">${esc(nameOf(m.aTeamId))}</span><span class="bye-tag">BYE</span><span></span></div>`;
        wrap.appendChild(b); return;
      }
      const mDiv = el("div", "match" + (m.played ? " played" : ""));
      const aWin = m.played && m.scoreA > m.scoreB, bWin = m.played && m.scoreB > m.scoreA;
      mDiv.innerHTML = `
        <div class="court">Court ${m.court}</div>
        <div class="teams">
          <span class="t ${aWin ? "winner" : ""}">${esc(nameOf(m.aTeamId))}</span>
          <span class="sc">${m.played ? m.scoreA : "–"} <span class="vs">vs</span> ${m.played ? m.scoreB : "–"}</span>
          <span class="t right ${bWin ? "winner" : ""}">${esc(nameOf(m.bTeamId))}</span>
        </div>`;
      if (state.admin) {
        const btn = el("button", "primary enter", m.played ? "Edit score" : "Enter score");
        btn.addEventListener("click", () => openScoreEntry(r, m, nameOf));
        mDiv.appendChild(btn);
      }
      wrap.appendChild(mDiv);
    });
    area.appendChild(wrap);
  });
}

function openScoreEntry(round, match, nameOf) {
  if (!requireAdmin()) return;
  openModal({
    title: `${nameOf(match.aTeamId)} vs ${nameOf(match.bTeamId)}`,
    body: `
      <p class="hint">First to ${SCORE_TARGET}. Enter the final score.</p>
      <label>${esc(nameOf(match.aTeamId))}</label>
      <input id="scA" type="number" inputmode="numeric" min="0" value="${match.scoreA ?? ""}" />
      <label>${esc(nameOf(match.bTeamId))}</label>
      <input id="scB" type="number" inputmode="numeric" min="0" value="${match.scoreB ?? ""}" />`,
    okLabel: "Save score",
    onOk: async () => {
      const a = parseInt($("#scA").value, 10), b = parseInt($("#scB").value, 10);
      if (isNaN(a) || isNaN(b)) { toast("Enter both scores"); return false; }
      if (a === b) { toast("No ties — someone has to win"); return false; }
      // deep-update the schedule
      const sched = JSON.parse(JSON.stringify(state.tonight.schedule));
      const rr = sched.rounds.find((x) => x.round === round.round);
      const mm = rr.matches.find((x) => x.id === match.id);
      mm.scoreA = a; mm.scoreB = b; mm.played = true;
      try { await saveTonight({ schedule: sched, playStarted: true }); toast("Score saved ✔"); }
      catch (e) { console.error(e); toast("Save failed"); return false; }
    },
  });
}

// ===========================================================================
//  STANDINGS
// ===========================================================================
function renderStandings() {
  const area = $("#standingsArea");
  const teams = state.tonight.teams || [];
  area.innerHTML = "";
  if (!teams.length) { area.appendChild(emptyState("🏆", "No standings yet", "Generate teams and play a game.")); return; }
  const rows = computeStandings(teams, state.tonight.schedule || { rounds: [] });
  const anyPlayed = rows.some((r) => r.played > 0);
  if (!anyPlayed) { area.appendChild(emptyState("🏐", "No games played yet", state.admin ? "Enter a score to start the standings." : "Standings update as scores come in.")); return; }

  const table = el("table", "standings");
  table.innerHTML = `<thead><tr><th>#</th><th style="text-align:left">Team</th><th>W</th><th>L</th><th>Pld</th></tr></thead>`;
  const tb = el("tbody");
  rows.forEach((r) => {
    const tr = el("tr", r.rank === 1 ? "rank-1" : "");
    tr.innerHTML = `<td class="rank">${r.rank}</td><td class="name">${esc(r.name)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.played}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  area.appendChild(table);
}

// ===========================================================================
//  RESET NIGHT (archive to history, then clear tonight)
// ===========================================================================
$("#resetBtn").addEventListener("click", () => {
  if (!requireAdmin()) return;
  openModal({
    title: "Reset the night?",
    body: `
      <p>This archives tonight to History (if anything was generated), then clears check-ins & tonight's teams/schedule/scores.
      <strong>Roster and History are kept.</strong></p>
      <label>Confirm passcode</label>
      <input id="resetPc" type="password" inputmode="numeric" autocomplete="off" />`,
    okLabel: "Archive & Reset", cancelLabel: "Cancel",
    afterOpen: () => $("#resetPc").focus(),
    onOk: async () => {
      if (($("#resetPc").value || "").trim() !== ADMIN_PASSCODE) { toast("Wrong passcode"); return false; }
      try { await archiveAndReset(); toast("Night archived & reset ✔"); gotoSub("checkin"); }
      catch (e) { console.error(e); toast("Reset failed"); return false; }
    },
  });
});

async function archiveAndReset() {
  const t = state.tonight;
  const byId = playersById();
  const generated = (t.teams && t.teams.length) || (t.checkedIn && t.checkedIn.length);

  if (generated) {
    const attendance = (t.checkedIn || []).map((id) => {
      const p = byId[id]; return p ? { name: p.name, age: ageFromBirthdate(p.birthdate), gender: p.gender } : null;
    }).filter(Boolean);
    const standings = computeStandings(t.teams || [], t.schedule || { rounds: [] });
    // Denormalise teams with player names so history is readable forever,
    // even if a player is later deleted from the roster.
    const teams = (t.teams || []).map((tm) => ({
      name: tm.name,
      starters: tm.starterIds.map((id) => (byId[id] ? byId[id].name : "?")),
      sub: tm.subId && byId[tm.subId] ? byId[tm.subId].name : null,
    }));
    const matches = [];
    (t.schedule?.rounds || []).forEach((r) => r.matches.forEach((m) => {
      if (m.bye) return;
      const an = (t.teams.find((x) => x.id === m.aTeamId) || {}).name;
      const bn = (t.teams.find((x) => x.id === m.bTeamId) || {}).name;
      matches.push({ round: r.round, court: m.court, a: an, b: bn, scoreA: m.scoreA, scoreB: m.scoreB, played: m.played });
    }));
    await addDoc(historyCol(), {
      date: new Date().toISOString().slice(0, 10),
      attendance, teams, matches,
      standings: standings.map((s) => ({ rank: s.rank, name: s.name, wins: s.wins, losses: s.losses })),
      teamNames: teams.map((tm) => tm.name),
      createdAt: serverTimestamp(),
    });
  }
  // clear tonight (roster & history untouched)
  await setDoc(tonightRef(), { checkedIn: [], teams: [], schedule: { rounds: [] }, playStarted: false, generatedAt: null }, { merge: true });
}

// ===========================================================================
//  HISTORY
// ===========================================================================
function renderHistory() {
  const area = $("#historyArea");
  area.innerHTML = "";
  if (!state.history.length) { area.appendChild(emptyState("📜", "No history yet", "Past Mondays show up here after you Reset the night.")); return; }
  state.history.forEach((h) => {
    const card = el("details", "hist-card");
    const champ = (h.standings && h.standings[0]) ? h.standings[0].name : "—";
    const sum = el("summary");
    sum.innerHTML = `${esc(h.date || "Unknown date")} · ${(h.attendance || []).length} played · 🏆 ${esc(champ)}`;
    card.appendChild(sum);
    const body = el("div", "hist-body");
    body.innerHTML = `
      ${histTeams(h)}
      ${histStandings(h)}
      ${histMatches(h)}
      ${histAttendance(h)}`;
    card.appendChild(body);
    area.appendChild(card);
  });
}
function histTeams(h) {
  if (!h.teams || !h.teams.length) return "";
  return `<h4>Teams</h4>` + h.teams.map((t) =>
    `<div><strong>${esc(t.name)}</strong>: ${esc((t.starters || []).join(", "))}${t.sub ? " (sub: " + esc(t.sub) + ")" : ""}</div>`).join("");
}
function histStandings(h) {
  if (!h.standings || !h.standings.length) return "";
  return `<h4>Final standings</h4>` + h.standings.map((s) => `<div>${s.rank}. ${esc(s.name)} — ${s.wins}W / ${s.losses}L</div>`).join("");
}
function histMatches(h) {
  const played = (h.matches || []).filter((m) => m.played);
  if (!played.length) return "";
  return `<h4>Results</h4>` + played.map((m) => `<div>R${m.round} · ${esc(m.a)} ${m.scoreA}–${m.scoreB} ${esc(m.b)}</div>`).join("");
}
function histAttendance(h) {
  if (!h.attendance || !h.attendance.length) return "";
  return `<h4>Attendance (${h.attendance.length})</h4><div>${h.attendance.map((a) => esc(a.name)).join(", ")}</div>`;
}

// ===========================================================================
//  Shared render / helpers
// ===========================================================================
function emptyState(icon, title, sub) {
  return el("div", "empty", `<span class="big">${icon}</span><strong>${esc(title)}</strong><div class="hint">${esc(sub || "")}</div>`);
}
function gotoSub(name) {
  document.querySelector('.tab[data-tab="tonight"]').click();
  const btn = document.querySelector(`.subtab[data-sub="${name}"]`);
  if (btn) btn.click();
}
function renderAll() { renderRoster(); renderCheckin(); renderTeams(); renderSchedule(); renderStandings(); renderHistory(); }

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
if (offline) {
  toast("⚠ Firebase not configured — see js/firebase-config.js");
}
startListeners();
renderAll();

// Service worker (installability). Real-time data always comes from Firestore.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
