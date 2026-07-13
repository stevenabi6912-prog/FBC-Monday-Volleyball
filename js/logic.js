// ============================================================================
//  logic.js  —  Pure functions. No Firebase, no DOM.
//  Team balancing, scheduling, standings, team-name generation.
//  Keeping these pure makes the tricky parts easy to reason about & test.
// ============================================================================

export const TEAM_SIZE = 6;          // starters per team
export const SUB_PER_TEAM = 1;       // max subs per team (capacity = 7)
export const SCORE_TARGET = 25;      // first to 25…
export const WIN_BY = 2;             // …win by 2
export const COURTS = 2;

// Validate a final match score for "first to SCORE_TARGET, win by WIN_BY".
// Returns an error message string, or null if the score is valid.
export function scoreError(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return "Enter both scores.";
  if (a === b) return "No ties — someone has to win.";
  const w = Math.max(a, b), l = Math.min(a, b);
  if (w < SCORE_TARGET) return `Winner must reach ${SCORE_TARGET}.`;
  if (w - l < WIN_BY) return `Must win by ${WIN_BY} (e.g. ${SCORE_TARGET}-${SCORE_TARGET - WIN_BY}).`;
  return null;
}

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

// Skill rating is 1 (not good), 2 (ok), 3 (good). Missing/invalid -> 2 (neutral).
export const SKILL_DEFAULT = 2;
export function skillNum(v) {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : SKILL_DEFAULT;
}

// ---------------------------------------------------------------------------
//  Generate balanced teams from a list of checked-in players.
//  Priority order: SKILL first (balance total skill across teams), then gender,
//  then age. We snake-draft by skill so every team gets a comparable mix of
//  1s/2s/3s, then do gender swaps restricted to equal-skill players so the skill
//  balance is never disturbed.
//  player: { id, name, birthdate, gender, skill }
// ---------------------------------------------------------------------------
export function generateTeams(players, teamNames, pairs = []) {
  const enriched = players.map((p) => ({ ...p, age: ageFromBirthdate(p.birthdate) ?? 0, skill: skillNum(p.skill) }));
  const n = enriched.length;
  const { teams: T, subs: S } = planTeams(n);
  if (T === 0) return [];

  // Capacities: the first S teams get a sub slot (7), the rest are 6.
  const capacity = Array.from({ length: T }, (_, i) => TEAM_SIZE + (i < S ? SUB_PER_TEAM : 0));

  // Sort by skill (high -> low) first so the snake balances total skill across
  // teams; tie-break by age so ages also spread within each skill tier.
  const sorted = [...enriched].sort((a, b) => b.skill - a.skill || b.age - a.age);

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

  // Apply any keep-together constraints (config-driven, id-based) via swaps
  // that preserve team sizes and roughly preserve age/gender balance.
  const pinned = enforcePairs(buckets, pairs);

  // Build team objects. The sub slot (if the team is over TEAM_SIZE) is the
  // player closest to the team's median age (keeps starters balanced), while
  // avoiding pinned players so a constrained pair both start when possible.
  return buckets.map((members, i) => {
    let starters = members, subId = null;
    if (members.length > TEAM_SIZE) {
      const ages = members.map((m) => m.age).sort((a, b) => a - b);
      const median = ages[Math.floor(ages.length / 2)];
      let subIdx = 0, best = Infinity;
      members.forEach((m, idx) => {
        const d = Math.abs(m.age - median) + (pinned.has(m.id) ? 1000 : 0);
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

// In-place gender balancing across buckets. Swaps are restricted to players of
// EQUAL skill so the (higher-priority) skill balance is never disturbed.
function balanceGenders(buckets) {
  const maleCount = (b) => b.filter((p) => (p.gender || "").toLowerCase().startsWith("m")).length;
  for (let pass = 0; pass < 16; pass++) {
    const counts = buckets.map(maleCount);
    let hi = 0, lo = 0;
    counts.forEach((c, i) => { if (c > counts[hi]) hi = i; if (c < counts[lo]) lo = i; });
    if (counts[hi] - counts[lo] <= 1) break; // good enough

    // Move a male from hi -> lo and a female lo -> hi. Require equal skill (so
    // team skill totals are unchanged) and prefer the closest ages.
    const males = buckets[hi].filter((p) => (p.gender || "").toLowerCase().startsWith("m"));
    const females = buckets[lo].filter((p) => !(p.gender || "").toLowerCase().startsWith("m"));
    if (!males.length || !females.length) break;

    let bestM = null, bestF = null, bestDiff = Infinity;
    for (const m of males) for (const f of females) {
      if (m.skill !== f.skill) continue;                 // keep skill balance intact
      const d = Math.abs(m.age - f.age);
      if (d < bestDiff) { bestDiff = d; bestM = m; bestF = f; }
    }
    if (!bestM || !bestF) break;                          // no skill-neutral swap available
    buckets[hi] = buckets[hi].filter((p) => p.id !== bestM.id).concat(bestF);
    buckets[lo] = buckets[lo].filter((p) => p.id !== bestF.id).concat(bestM);
  }
}

// Keep-together constraints. `pairs` is [[idA, idB], ...]. For each pair, if
// the two players landed on different teams, move one to join the other and
// swap out a compatible teammate (same gender, closest age) so team sizes and
// balance are preserved. Players not currently present are ignored. Returns the
// set of pinned ids so sub-selection can avoid benching them.
function enforcePairs(buckets, pairs) {
  const pinned = new Set();
  if (!pairs || !pairs.length) return pinned;
  const isMale = (g) => (g || "").toLowerCase().startsWith("m");
  const teamOf = (id) => buckets.findIndex((b) => b.some((p) => p.id === id));
  const pinnedIds = new Set(pairs.flat());

  for (const [aId, bId] of pairs) {
    const ta = teamOf(aId), tb = teamOf(bId);
    if (ta < 0 || tb < 0) continue;          // one of them didn't show up
    pinned.add(aId); pinned.add(bId);
    if (ta === tb) continue;                  // already together

    const b = buckets[tb].find((p) => p.id === bId);
    // pick a teammate of a to swap out — never another pinned player
    const cands = buckets[ta].filter((p) => !pinnedIds.has(p.id));
    if (!cands.length) continue;
    let best = cands[0], bestScore = Infinity;
    for (const x of cands) {
      // skill is top priority: heavily prefer swapping out an equal-skill player
      const skillPenalty = Math.abs((x.skill || SKILL_DEFAULT) - (b.skill || SKILL_DEFAULT)) * 100;
      const genderPenalty = isMale(x.gender) === isMale(b.gender) ? 0 : 5;
      const score = skillPenalty + genderPenalty + Math.abs((x.age || 0) - (b.age || 0));
      if (score < bestScore) { bestScore = score; best = x; }
    }
    // swap: b joins team ta, best moves to team tb
    buckets[ta] = buckets[ta].filter((p) => p.id !== best.id).concat(b);
    buckets[tb] = buckets[tb].filter((p) => p.id !== bId).concat(best);
  }
  return pinned;
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
//  Referee assignment. Each round, fill that round's games with referees.
//  Goal: a "ref-only" person (available to ref but not on a team) should ref
//  ONE game every round — they're here to ref, so never leave them idle. So we
//  fill each round's matches with ref-only people first (one game each, rotating
//  across rounds for fairness), then use any "player-refs" (people who also play)
//  ONLY for rounds their own team isn't playing. A ref never covers both courts
//  of a round. overwrite=true redistributes everything; otherwise only matches
//  with no ref yet are filled (keeps manual picks + played games).
//  `teams` (optional) is the tonight teams array, used to know who's playing.
// ---------------------------------------------------------------------------
export function assignRefs(schedule, refPool, teams = [], overwrite = false) {
  const pool = refPool || [];
  const teamOfPlayer = {};
  (teams || []).forEach((t) => {
    [...(t.starterIds || []), t.subId].filter(Boolean).forEach((id) => { teamOfPlayer[id] = t.id; });
  });
  const refOnly = pool.filter((id) => !teamOfPlayer[id]);       // here only to ref
  const playerRefs = pool.filter((id) => teamOfPlayer[id]);     // also on a team
  let roPtr = 0;                                                // rotates ref-only across rounds

  (schedule.rounds || []).forEach((r) => {
    const playingTeams = new Set();
    r.matches.forEach((m) => { if (!m.bye) { playingTeams.add(m.aTeamId); playingTeams.add(m.bTeamId); } });

    // matches that still need a ref this round
    const used = new Set();
    const targets = [];
    r.matches.forEach((m) => {
      if (m.bye) return;
      if (!overwrite && m.refId) { used.add(m.refId); return; }
      targets.push(m);
    });
    if (!targets.length) return;

    // priority order: ref-only first (rotated so it's not always the same person
    // on the same court), then player-refs whose team isn't on the court now.
    const rotatedRefOnly = refOnly.map((_, k) => refOnly[(roPtr + k) % refOnly.length]);
    const eligiblePlayerRefs = playerRefs.filter((id) => !playingTeams.has(teamOfPlayer[id]));
    const order = [...rotatedRefOnly, ...eligiblePlayerRefs];

    let oi = 0;
    for (const m of targets) {
      let pick = null;
      while (oi < order.length) {
        const cand = order[oi++];
        if (!used.has(cand)) { pick = cand; break; }
      }
      if (overwrite || pick) m.refId = pick || null;   // may be null if not enough refs
      if (pick) used.add(pick);
    }
    if (refOnly.length) roPtr = (roPtr + Math.min(targets.length, refOnly.length)) % refOnly.length;
  });
  return schedule;
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
//  Prefer a team with no sub (fill the sub slot). Among candidates, prioritise
//  keeping SKILL balanced (send the player to the lowest-skill team), then
//  gender, then age. Returns the chosen team id.
// ---------------------------------------------------------------------------
export function bestTeamForLateArrival(teams, playersById, newPlayer) {
  const noSub = teams.filter((t) => !t.subId);
  const pool = noSub.length ? noSub : teams; // if all have subs, still pick best
  const isMale = (g) => (g || "").toLowerCase().startsWith("m");
  const newAge = ageFromBirthdate(newPlayer.birthdate) ?? 0;
  const newSkill = skillNum(newPlayer.skill);

  // team skill totals across all current teams — target the lowest so adding
  // this player evens things out (skill is the top priority).
  const skillTotals = teams.map((t) =>
    [...t.starterIds, t.subId].filter(Boolean)
      .reduce((s, id) => s + skillNum(playersById[id] && playersById[id].skill), 0));
  const minSkill = Math.min(...skillTotals);

  let best = pool[0], bestScore = Infinity;
  for (const team of pool) {
    const ti = teams.indexOf(team);
    const ids = [...team.starterIds, team.subId].filter(Boolean);
    const members = ids.map((id) => playersById[id]).filter(Boolean);
    const males = members.filter((m) => isMale(m.gender)).length;
    const females = members.length - males;
    const gAfter = Math.abs((males + (isMale(newPlayer.gender) ? 1 : 0)) - (females + (isMale(newPlayer.gender) ? 0 : 1)));
    const avgAge = members.length ? members.reduce((s, m) => s + (ageFromBirthdate(m.birthdate) ?? 0), 0) / members.length : newAge;
    const ageShift = Math.abs(newAge - avgAge);
    // skill dominates: how far above the leanest team this one would sit after adding.
    const skillPenalty = (skillTotals[ti] + newSkill) - (minSkill + 0) ;
    const score = skillPenalty * 100 + gAfter * 10 + ageShift;
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
