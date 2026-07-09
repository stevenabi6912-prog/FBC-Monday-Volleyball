// ============================================================================
//  logic.js  —  Pure functions. No Firebase, no DOM.
//  Team balancing, scheduling, standings, team-name generation.
//  Keeping these pure makes the tricky parts easy to reason about & test.
// ============================================================================

export const TEAM_SIZE = 6;          // starters per team
export const SUB_PER_TEAM = 1;       // max subs per team (capacity = 7)
export const SCORE_TARGET = 21;      // first to 21, no win-by-2
export const COURTS = 2;

// ---------------------------------------------------------------------------
//  Age
// ---------------------------------------------------------------------------
// Compute current age from a "YYYY-MM-DD" birthdate string.
export function ageFromBirthdate(birthdate, today = new Date()) {
  if (!birthdate) return null;
  const b = new Date(birthdate + "T00:00:00");
  if (isNaN(b)) return null;
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age--;
  return age;
}

// ---------------------------------------------------------------------------
//  How many teams for a given head count?
// ---------------------------------------------------------------------------
// Team size 6. Extras become subs (max 1 per team, so capacity 7 each).
// We create floor(n/6) teams, then distribute leftovers as one sub each.
// Anyone beyond (teams * 7) is a bench/waiting player.
export function planTeams(n) {
  let teams = Math.floor(n / TEAM_SIZE);
  if (teams < 1) teams = n > 0 ? 1 : 0;         // thin team rather than nothing
  const subs = Math.min(Math.max(n - TEAM_SIZE * teams, 0), teams * SUB_PER_TEAM);
  const bench = Math.max(n - TEAM_SIZE * teams - subs, 0);
  return { teams, subs, bench };
}

// ---------------------------------------------------------------------------
//  Generate balanced teams from a list of checked-in players.
//  Strategy (per spec): snake draft by age to spread ages, then gender
//  swap passes to even genders while keeping age balance intact.
//  player: { id, name, birthdate, gender }
// ---------------------------------------------------------------------------
export function generateTeams(players, teamNames) {
  const enriched = players.map((p) => ({ ...p, age: ageFromBirthdate(p.birthdate) ?? 0 }));
  const n = enriched.length;
  const { teams: T, subs: S } = planTeams(n);
  if (T === 0) return [];

  // Capacities: the first S teams get a sub slot (7), the rest are 6.
  const capacity = Array.from({ length: T }, (_, i) => TEAM_SIZE + (i < S ? SUB_PER_TEAM : 0));

  // Sort oldest -> youngest so the snake spreads the age range.
  const sorted = [...enriched].sort((a, b) => b.age - a.age);

  const buckets = Array.from({ length: T }, () => []);
  let dir = 1, t = 0;
  for (const player of sorted) {
    // find next team with remaining capacity, snaking back and forth
    let guard = 0;
    while (buckets[t].length >= capacity[t] && guard < T * 2 + 2) {
      t += dir;
      if (t >= T) { t = T - 1; dir = -1; }
      else if (t < 0) { t = 0; dir = 1; }
      guard++;
    }
    buckets[t].push(player);
    // advance snake
    const nextT = t + dir;
    if (nextT >= T) { dir = -1; t = T - 1; }
    else if (nextT < 0) { dir = 1; t = 0; }
    else t = nextT;
  }

  // Gender swap passes: even out gender counts without wrecking age averages.
  balanceGenders(buckets);

  // Build team objects. The sub slot (if the team is over TEAM_SIZE) is the
  // player closest to the team's median age (keeps starters balanced).
  return buckets.map((members, i) => {
    let starters = members, subId = null;
    if (members.length > TEAM_SIZE) {
      const ages = members.map((m) => m.age).sort((a, b) => a - b);
      const median = ages[Math.floor(ages.length / 2)];
      let subIdx = 0, best = Infinity;
      members.forEach((m, idx) => {
        const d = Math.abs(m.age - median);
        if (d < best) { best = d; subIdx = idx; }
      });
      subId = members[subIdx].id;
      starters = members.filter((_, idx) => idx !== subIdx);
    }
    return {
      id: "team_" + i + "_" + Math.abs(hashName(teamNames[i] || ("Team " + (i + 1)))),
      name: teamNames[i] || "Team " + (i + 1),
      starterIds: starters.map((m) => m.id),
      subId,
    };
  });
}

// In-place gender balancing across buckets via same-age-ish swaps.
function balanceGenders(buckets) {
  const maleCount = (b) => b.filter((p) => (p.gender || "").toLowerCase().startsWith("m")).length;
  for (let pass = 0; pass < 12; pass++) {
    const counts = buckets.map(maleCount);
    let hi = 0, lo = 0;
    counts.forEach((c, i) => { if (c > counts[hi]) hi = i; if (c < counts[lo]) lo = i; });
    if (counts[hi] - counts[lo] <= 1) break; // good enough

    // Move a male from hi -> lo and a female lo -> hi, choosing the closest
    // ages so the age balance barely shifts.
    const males = buckets[hi].filter((p) => (p.gender || "").toLowerCase().startsWith("m"));
    const females = buckets[lo].filter((p) => !(p.gender || "").toLowerCase().startsWith("m"));
    if (!males.length || !females.length) break;

    let bestM = males[0], bestF = females[0], bestDiff = Infinity;
    for (const m of males) for (const f of females) {
      const d = Math.abs(m.age - f.age);
      if (d < bestDiff) { bestDiff = d; bestM = m; bestF = f; }
    }
    buckets[hi] = buckets[hi].filter((p) => p.id !== bestM.id).concat(bestF);
    buckets[lo] = buckets[lo].filter((p) => p.id !== bestF.id).concat(bestM);
  }
}

// Small deterministic string hash so team ids are stable-ish per name.
function hashName(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

// ---------------------------------------------------------------------------
//  Team-name generator. Funny two-word names, unique within the night and
//  avoiding any name in `used` (previous weeks). Big pool + combinatorial
//  generator so we never run dry.
// ---------------------------------------------------------------------------
const ADJ = [
  "Bouncing", "Turbo", "Spiking", "Flying", "Rowdy", "Mighty", "Sneaky", "Salty",
  "Dizzy", "Jumpy", "Fuzzy", "Cosmic", "Thunder", "Wobbly", "Sizzling", "Roaring",
  "Galloping", "Wandering", "Dancing", "Grumpy", "Sparkly", "Rumbling", "Zooming",
  "Blessed", "Radiant", "Humble", "Jolly", "Nimble", "Feisty", "Stumbling",
  "Prickly", "Bubbly", "Sassy", "Rugged", "Zesty", "Plucky", "Snappy", "Vigorous",
];
const NOUN = [
  "Penguins", "Walruses", "Llamas", "Otters", "Narwhals", "Badgers", "Pelicans",
  "Yaks", "Moose", "Hedgehogs", "Wombats", "Puffins", "Raccoons", "Ferrets",
  "Meerkats", "Armadillos", "Platypuses", "Ostriches", "Beavers", "Chinchillas",
  "Manatees", "Gophers", "Marmots", "Capybaras", "Toucans", "Alpacas", "Lemurs",
  "Mongooses", "Weasels", "Quokkas", "Pandas", "Sloths", "Geese", "Hippos",
];

// Returns `count` fresh names, avoiding everything in `used` (Set or array).
export function generateTeamNames(count, used = []) {
  const usedSet = new Set(Array.from(used).map((s) => s.toLowerCase()));
  const picked = [];
  const pickedSet = new Set();
  let guard = 0;
  // Deterministic-ish spread using an offset walk over the pools.
  let ai = seedFrom(used) % ADJ.length;
  let ni = seedFrom(used) % NOUN.length;
  while (picked.length < count && guard < 5000) {
    guard++;
    ai = (ai + 1) % ADJ.length;
    ni = (ni + 3) % NOUN.length;
    const name = ADJ[ai] + " " + NOUN[ni];
    const key = name.toLowerCase();
    if (usedSet.has(key) || pickedSet.has(key)) continue;
    pickedSet.add(key);
    picked.push(name);
  }
  // Fallback if the pool is somehow exhausted: append a number.
  let k = 2;
  while (picked.length < count) {
    const name = ADJ[picked.length % ADJ.length] + " " + NOUN[picked.length % NOUN.length] + " " + k;
    if (!usedSet.has(name.toLowerCase())) picked.push(name);
    k++;
  }
  return picked;
}

function seedFrom(used) {
  const s = Array.from(used).join("|");
  let h = 7;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff; }
  return h + used.length * 13 + 1;
}

// ---------------------------------------------------------------------------
//  Round-robin schedule across 2 courts (circle method).
//  teams: array of team objects. Returns { rounds: [{ round, matches:[...] }] }
//  match: { id, court, aTeamId, bTeamId, scoreA, scoreB, played, bye }
// ---------------------------------------------------------------------------
export function buildSchedule(teams) {
  const ids = teams.map((t) => t.id);
  const list = ids.slice();
  if (list.length < 2) return { rounds: [] };
  const hasBye = list.length % 2 === 1;
  if (hasBye) list.push(null); // BYE marker

  const numRounds = list.length - 1;
  const half = list.length / 2;
  const rounds = [];
  let arr = list.slice();

  for (let r = 0; r < numRounds; r++) {
    const matches = [];
    let courtCounter = 0;
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[arr.length - 1 - i];
      if (a === null || b === null) {
        matches.push(byeMatch(a === null ? b : a));
        continue;
      }
      matches.push({
        id: mid(r, i),
        court: (courtCounter % COURTS) + 1,
        aTeamId: a, bTeamId: b,
        scoreA: null, scoreB: null, played: false, bye: false,
      });
      courtCounter++;
    }
    rounds.push({ round: r + 1, matches });
    // rotate (keep first fixed)
    arr = [arr[0], arr[arr.length - 1], ...arr.slice(1, arr.length - 1)];
  }
  return { rounds };
}

function byeMatch(teamId) {
  return { id: "bye_" + teamId, court: null, aTeamId: teamId, bTeamId: null, scoreA: null, scoreB: null, played: true, bye: true };
}
function mid(r, i) { return "m_" + r + "_" + i + "_" + Math.floor((r + 1) * 131 + i * 17); }

// ---------------------------------------------------------------------------
//  Append matchups for a brand-new team vs every existing team (late arrival
//  "form new team" case). Does not touch existing matches. Adds new rounds.
// ---------------------------------------------------------------------------
export function appendTeamToSchedule(schedule, existingTeamIds, newTeamId) {
  const rounds = (schedule.rounds || []).map((r) => ({ ...r, matches: r.matches.slice() }));
  let roundNo = rounds.length;
  let idx = 0;
  // Each new match is the new team vs one existing team; spread across rounds,
  // two courts per round.
  let court = 0;
  let current = null;
  for (const opp of existingTeamIds) {
    if (!current || current.matches.length >= COURTS) {
      roundNo++;
      current = { round: roundNo, matches: [] };
      rounds.push(current);
      court = 0;
    }
    current.matches.push({
      id: "mAdd_" + newTeamId + "_" + opp + "_" + idx,
      court: (court % COURTS) + 1,
      aTeamId: newTeamId, bTeamId: opp,
      scoreA: null, scoreB: null, played: false, bye: false,
    });
    court++; idx++;
  }
  return { rounds };
}

// ---------------------------------------------------------------------------
//  Standings — rank by wins only. Ties share a rank (no tiebreaker).
// ---------------------------------------------------------------------------
export function computeStandings(teams, schedule) {
  const stats = {};
  teams.forEach((t) => (stats[t.id] = { teamId: t.id, name: t.name, wins: 0, losses: 0, played: 0, pf: 0, pa: 0 }));
  (schedule.rounds || []).forEach((r) =>
    r.matches.forEach((m) => {
      if (m.bye || !m.played || m.scoreA == null || m.scoreB == null) return;
      const A = stats[m.aTeamId], B = stats[m.bTeamId];
      if (!A || !B) return;
      A.played++; B.played++;
      A.pf += m.scoreA; A.pa += m.scoreB;
      B.pf += m.scoreB; B.pa += m.scoreA;
      if (m.scoreA > m.scoreB) { A.wins++; B.losses++; }
      else if (m.scoreB > m.scoreA) { B.wins++; A.losses++; }
    })
  );
  const rows = Object.values(stats).sort((a, b) => b.wins - a.wins || b.pf - a.pf);
  // assign ranks; equal wins => equal rank (no tiebreaker per spec)
  let rank = 0, prevWins = null;
  rows.forEach((row, i) => {
    if (row.wins !== prevWins) { rank = i + 1; prevWins = row.wins; }
    row.rank = rank;
  });
  return rows;
}

// ---------------------------------------------------------------------------
//  Late-arrival helper: which existing team best absorbs one more player?
//  Prefer a team with no sub (fill the sub slot). Among candidates, pick the
//  one where the new player most improves gender balance, then age balance.
//  Returns the chosen team id.
// ---------------------------------------------------------------------------
export function bestTeamForLateArrival(teams, playersById, newPlayer) {
  const noSub = teams.filter((t) => !t.subId);
  const pool = noSub.length ? noSub : teams; // if all have subs, still pick best
  const isMale = (g) => (g || "").toLowerCase().startsWith("m");
  const newAge = ageFromBirthdate(newPlayer.birthdate) ?? 0;

  let best = pool[0], bestScore = Infinity;
  for (const team of pool) {
    const ids = [...team.starterIds, team.subId].filter(Boolean);
    const members = ids.map((id) => playersById[id]).filter(Boolean);
    const males = members.filter((m) => isMale(m.gender)).length;
    const females = members.length - males;
    // gender imbalance after adding
    const gAfter = Math.abs((males + (isMale(newPlayer.gender) ? 1 : 0)) - (females + (isMale(newPlayer.gender) ? 0 : 1)));
    const avgAge = members.length ? members.reduce((s, m) => s + (ageFromBirthdate(m.birthdate) ?? 0), 0) / members.length : newAge;
    const ageShift = Math.abs(newAge - avgAge);
    const score = gAfter * 10 + ageShift; // gender weighted heavier
    if (score < bestScore) { bestScore = score; best = team; }
  }
  return best.id;
}

// Count how many players are currently "loose" for the form-new-team trigger:
// all subs across teams + any waiting late arrivals not yet on a team.
export function loosePlayerCount(teams, waitingCount) {
  const subs = teams.filter((t) => t.subId).length;
  return subs + waitingCount;
}
