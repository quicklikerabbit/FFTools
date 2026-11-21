/**
 * Sleeper API helpers.
 *
 * Setup: copy .env.example to .env and fill in your user ID and leagues.
 *
 * Usage ([league] is a name from SLEEPER_LEAGUES or a raw league ID, and
 * defaults to the first league in SLEEPER_LEAGUES):
 *   npm run trending -- [league]
 *   npm run available -- [league]
 *   npm run roster -- [league] [username]   (username defaults to SLEEPER_USER_ID)
 *   npm run claude -- [league] [username]   (roster + trending + available, copied to clipboard)
 *
 * Finding your leagueId: open your league in the Sleeper app/site,
 * the URL looks like https://sleeper.com/leagues/<leagueId>/team
 *
 * No API key needed — Sleeper's API is free/read-only. Be a good
 * citizen: don't call getAllPlayers() more than once a day, cache
 * the result if you're calling this repeatedly.
 */

import path from "node:path";

const BASE = "https://api.sleeper.app/v1";

export interface SleeperPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  position: string; // QB, RB, WR, TE, K, DEF, etc.
  team: string | null; // NFL team abbreviation, e.g. "BUF"
  status: string; // "Active", "Inactive", etc. — Sleeper doesn't reliably flip this for long-retired vets
  fantasy_positions: string[] | null;
  injury_status: string | null;
  age: number | null;
  birth_date: string | null; // "YYYY-MM-DD"
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string;
  co_owners?: string[] | null;
  players: string[] | null; // all player_ids on this roster (starters + bench + IR + taxi)
  starters: string[] | null; // in the same order as the league's starting slots; "0" = empty slot
  reserve: string[] | null; // IR
  taxi: string[] | null;
  settings: { wins: number; losses: number; ties: number; fpts?: number; fpts_decimal?: number };
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  roster_positions: string[]; // e.g. ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN", ...]
}

export interface SleeperLeagueUser {
  user_id: string;
  display_name: string;
  metadata: { team_name?: string } | null;
}

export interface TrendingEntry {
  player_id: string;
  count: number;
}

/** Full player_id -> player map for the given sport. ~5MB, fetch sparingly. */
export async function getAllPlayers(sport = "nfl"): Promise<Record<string, SleeperPlayer>> {
  const res = await fetch(`${BASE}/players/${sport}`);
  if (!res.ok) throw new Error(`getAllPlayers failed: ${res.status}`);
  return res.json();
}

/** All rosters in a league (each team's full player list). */
export async function getLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
  const res = await fetch(`${BASE}/league/${leagueId}/rosters`);
  if (!res.ok) throw new Error(`getLeagueRosters failed: ${res.status}`);
  return res.json();
}

/** League settings, including the starting lineup slots. */
export async function getLeague(leagueId: string): Promise<SleeperLeague> {
  const res = await fetch(`${BASE}/league/${leagueId}`);
  if (!res.ok) throw new Error(`getLeague failed: ${res.status}`);
  return res.json();
}

/** Every manager in a league, with display names and team names. */
export async function getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
  const res = await fetch(`${BASE}/league/${leagueId}/users`);
  if (!res.ok) throw new Error(`getLeagueUsers failed: ${res.status}`);
  return res.json();
}

/** Looks up a Sleeper user_id from a username. */
export async function getUserId(username: string): Promise<string> {
  const res = await fetch(`${BASE}/user/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`getUserId failed: ${res.status}`);
  const user = (await res.json()) as { user_id?: string } | null; // Sleeper returns null for unknown users
  if (!user?.user_id) throw new Error(`No Sleeper user named "${username}"`);
  return user.user_id;
}

function rosteredIdsFrom(rosters: SleeperRoster[]): Set<string> {
  const ids = new Set<string>();
  for (const roster of rosters) {
    for (const id of roster.players ?? []) ids.add(id);
  }
  return ids;
}

/** Set of every player_id currently rostered by anyone in the league. */
export async function getRosteredPlayerIds(leagueId: string): Promise<Set<string>> {
  return rosteredIdsFrom(await getLeagueRosters(leagueId));
}

/**
 * League rosters plus the full player map. Pass one in to the helpers below
 * to share a single getAllPlayers() fetch across several calls.
 */
export interface LeagueSnapshot {
  rosters: SleeperRoster[];
  rosteredIds: Set<string>;
  allPlayers: Record<string, SleeperPlayer>;
}

export async function getLeagueSnapshot(leagueId: string): Promise<LeagueSnapshot> {
  const [rosters, allPlayers] = await Promise.all([getLeagueRosters(leagueId), getAllPlayers()]);
  return { rosters, rosteredIds: rosteredIdsFrom(rosters), allPlayers };
}

export interface RosterPlayer {
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
}

export interface UserRoster {
  leagueName: string;
  teamName: string;
  ownerName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number | null;
  starters: { slot: string; player: RosterPlayer | null }[]; // player is null for an empty slot
  bench: RosterPlayer[];
  reserve: RosterPlayer[]; // IR
  taxi: RosterPlayer[];
}

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

function byPositionThenName(a: RosterPlayer, b: RosterPlayer): number {
  const rank = (p: RosterPlayer) => (POSITION_ORDER.includes(p.position) ? POSITION_ORDER.indexOf(p.position) : 99);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** One manager's roster in a league, split into starters (by slot), bench, IR and taxi. */
export async function getUserRoster(
  leagueId: string,
  userId: string,
  opts: { snapshot?: LeagueSnapshot } = {}
): Promise<UserRoster> {
  const [{ rosters, allPlayers }, league, users] = await Promise.all([
    opts.snapshot ?? getLeagueSnapshot(leagueId),
    getLeague(leagueId),
    getLeagueUsers(leagueId),
  ]);

  const roster =
    rosters.find((r) => r.owner_id === userId) ?? rosters.find((r) => r.co_owners?.includes(userId));
  if (!roster) throw new Error(`User ${userId} doesn't have a roster in league ${leagueId}`);

  const toPlayer = (id: string): RosterPlayer => {
    const p = allPlayers[id];
    return p
      ? { name: `${p.first_name} ${p.last_name}`, position: p.position, team: p.team, injury_status: p.injury_status }
      : { name: `Unknown player ${id}`, position: "?", team: null, injury_status: null };
  };

  const starterIds = roster.starters ?? [];
  const reserveIds = roster.reserve ?? [];
  const taxiIds = roster.taxi ?? [];
  const notOnBench = new Set([...starterIds, ...reserveIds, ...taxiIds]);
  const starterSlots = league.roster_positions.filter((pos) => !["BN", "IR", "TAXI"].includes(pos));

  const owner = users.find((u) => u.user_id === roster.owner_id);
  const ownerName = owner?.display_name ?? roster.owner_id;
  const { wins = 0, losses = 0, ties = 0, fpts, fpts_decimal = 0 } = roster.settings ?? {};

  return {
    leagueName: league.name,
    teamName: owner?.metadata?.team_name || ownerName,
    ownerName,
    wins,
    losses,
    ties,
    pointsFor: fpts == null ? null : fpts + fpts_decimal / 100,
    starters: starterSlots.map((slot, i) => {
      const id = starterIds[i];
      return { slot, player: id && id !== "0" ? toPlayer(id) : null };
    }),
    bench: (roster.players ?? []).filter((id) => !notOnBench.has(id)).map(toPlayer).sort(byPositionThenName),
    reserve: reserveIds.map(toPlayer),
    taxi: taxiIds.map(toPlayer),
  };
}

/**
 * Trending adds or drops league-wide (not specific to your league),
 * based on Sleeper's global add/drop activity in the lookback window.
 */
export async function getTrending(
  type: "add" | "drop" = "add",
  lookbackHours = 24,
  limit = 50,
  sport = "nfl"
): Promise<TrendingEntry[]> {
  const url = `${BASE}/players/${sport}/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getTrending failed: ${res.status}`);
  return res.json();
}

/**
 * The main thing we actually want: trending-add players who are NOT
 * rostered by anyone in your specific league, i.e. real, addable
 * pickups — filtered to skippable-in-your-league positions removed
 * (no K/DEF/IDP since your league doesn't use them).
 */
export async function getAvailableTrendingPlayers(
  leagueId: string,
  opts: { lookbackHours?: number; limit?: number; relevantPositions?: string[]; snapshot?: LeagueSnapshot } = {}
) {
  const { lookbackHours = 24, limit = 100, relevantPositions = ["QB", "RB", "WR", "TE"] } = opts;

  const [{ rosteredIds, allPlayers }, trending] = await Promise.all([
    opts.snapshot ?? getLeagueSnapshot(leagueId),
    getTrending("add", lookbackHours, limit),
  ]);

  return trending
    .map((t) => ({ ...t, player: allPlayers[t.player_id] }))
    .filter((t) => t.player) // drop unknown ids (defenses etc. have odd ids sometimes)
    .filter((t) => !rosteredIds.has(t.player_id)) // must be a free agent in YOUR league
    .filter((t) => relevantPositions.includes(t.player.position)) // must be a rosterable position
    .map((t) => ({
      name: `${t.player.first_name} ${t.player.last_name}`,
      position: t.player.position,
      team: t.player.team,
      injury_status: t.player.injury_status,
      add_count: t.count,
    }));
}

/**
 * Sleeper's player list never gets fully cleaned up: long-retired veterans
 * often still carry status "Active" and a stale team. Their `age` field
 * stops getting updated once they fall off Sleeper's maintenance radar
 * though, so it drifts noticeably behind the age implied by `birth_date`.
 * Players missing age/birth_date entirely are usually just obscure/new
 * (not stale), so they're treated as current rather than penalized.
 */
function isLikelyCurrentPlayer(p: SleeperPlayer): boolean {
  if (p.age == null || !p.birth_date) return true;

  const birthDate = new Date(p.birth_date);
  const now = new Date();
  let realAge = now.getFullYear() - birthDate.getFullYear();
  const hadBirthdayThisYear =
    now.getMonth() > birthDate.getMonth() ||
    (now.getMonth() === birthDate.getMonth() && now.getDate() >= birthDate.getDate());
  if (!hadBirthdayThisYear) realAge--;

  return Math.abs(realAge - p.age) <= 1;
}

/**
 * Free agents on a given NFL team, i.e. players who play for `nflTeam`
 * but aren't rostered by anyone in your league — useful for scouting
 * handcuffs/backups on a team you already have a starter from.
 * Omit `nflTeam` to get free agents across every NFL team.
 */
export async function getAvailablePlayersByTeam(
  leagueId: string,
  nflTeam?: string,
  opts: { relevantPositions?: string[]; snapshot?: LeagueSnapshot } = {}
) {
  const { relevantPositions = ["QB", "RB", "WR", "TE"] } = opts;
  const teamCode = nflTeam?.toUpperCase();

  const { rosteredIds, allPlayers } = opts.snapshot ?? (await getLeagueSnapshot(leagueId));

  return Object.values(allPlayers)
    .filter((p) => (teamCode ? p.team === teamCode : p.team !== null)) // must be on an NFL team
    .filter((p) => p.status === "Active") // exclude explicitly retired/inactive players
    .filter(isLikelyCurrentPlayer) // exclude long-retired vets Sleeper never flipped to "Inactive"
    .filter((p) => !rosteredIds.has(p.player_id)) // must be a free agent in YOUR league
    .filter((p) => relevantPositions.includes(p.position)) // must be a rosterable position
    .map((p) => ({
      name: `${p.first_name} ${p.last_name}`,
      position: p.position,
      team: p.team,
      status: p.status,
      injury_status: p.injury_status,
    }));
}

// --- Config (.env) ---

/** A CLI mistake (bad arguments or config): printed without a stack trace. */
class UsageError extends Error {}

interface Config {
  userId: string | undefined;
  leagues: { name: string; id: string }[]; // first one is the default
}

/** Reads SLEEPER_USER_ID and SLEEPER_LEAGUES from .env (if present) or the shell environment. */
function loadConfig(): Config {
  try {
    process.loadEnvFile(path.join(__dirname, ".env")); // never overrides variables already set in the shell
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const leagues = (process.env.SLEEPER_LEAGUES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, id] = entry.includes(":") ? entry.split(":").map((s) => s.trim()) : [entry, entry];
      if (!name || !/^\d+$/.test(id ?? "")) {
        throw new UsageError(`SLEEPER_LEAGUES entry "${entry}" should look like name:leagueId`);
      }
      return { name, id };
    });

  return { userId: process.env.SLEEPER_USER_ID?.trim() || undefined, leagues };
}

/** Turns a league name from SLEEPER_LEAGUES (or a raw ID, or nothing) into a league ID. */
function resolveLeagueId(arg: string | undefined, config: Config): string {
  if (!arg) {
    const fallback = config.leagues[0];
    if (!fallback) {
      throw new UsageError("No league given and SLEEPER_LEAGUES isn't set. Copy .env.example to .env and fill it in.");
    }
    return fallback.id;
  }
  const match = config.leagues.find((l) => l.name.toLowerCase() === arg.toLowerCase());
  if (match) return match.id;
  if (/^\d+$/.test(arg)) return arg;

  const known = config.leagues.map((l) => l.name).join(", ") || "none — see .env.example";
  throw new UsageError(`Unknown league "${arg}". Known leagues: ${known}`);
}

async function resolveUserId(username: string | undefined, config: Config): Promise<string> {
  if (username) return getUserId(username);
  if (config.userId) return config.userId;
  throw new UsageError("No username given and SLEEPER_USER_ID isn't set. Copy .env.example to .env and fill it in.");
}

// --- CLI commands ---
async function trendingCommand(leagueId: string) {
  const available = await getAvailableTrendingPlayers(leagueId, { lookbackHours: 24, limit: 100 });

  console.log(`\nTrending adds that are FREE AGENTS in league ${leagueId}:\n`);
  for (const p of available) {
    const flag = p.injury_status ? ` (${p.injury_status})` : "";
    console.log(`  +${p.add_count.toString().padStart(6)}  ${p.position.padEnd(3)} ${p.name} - ${p.team}${flag}`);
  }
  console.log(`\n${available.length} total.\n`);
}

async function availableCommand(leagueId: string) {
  const available = await getAvailablePlayersByTeam(leagueId);

  console.log(`\nFree agents across all teams not rostered in league ${leagueId}:\n`);
  for (const p of available) {
    const flag = p.injury_status ? ` (${p.injury_status})` : "";
    console.log(`  ${p.position.padEnd(3)} ${p.name} - ${p.team}${flag}`);
  }
  console.log(`\n${available.length} total.\n`);
}

/** Copies text to the macOS clipboard. Resolves false if pbcopy isn't available. */
function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const proc = spawn("pbcopy");
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin.end(text);
  });
}

/** "Josh Allen (BUF, Questionable)" */
function playerLabel(p: { name: string; team: string | null; injury_status: string | null }): string {
  return `${p.name} (${p.team ?? "FA"}${p.injury_status ? `, ${p.injury_status}` : ""})`;
}

/** Markdown lines for a roster. `level` is the heading level of its title. */
function formatRoster(r: UserRoster, level: number): string[] {
  const h = "#".repeat(level);
  const sub = "#".repeat(level + 1);
  const record = `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
  const pointsFor = r.pointsFor == null ? "" : `, ${r.pointsFor.toFixed(2)} points for`;

  const title = r.teamName === r.ownerName ? r.teamName : `${r.teamName} (${r.ownerName})`;
  // Only flex-style slots need the player's position spelled out ("FLEX: TE Dallas Goedert").
  const starterLine = (s: UserRoster["starters"][number]) =>
    !s.player
      ? `- ${s.slot}: (empty)`
      : `- ${s.slot}: ${s.player.position === s.slot ? "" : `${s.player.position} `}${playerLabel(s.player)}`;

  const lines = [
    `${h} Roster: ${title}`,
    `League: ${r.leagueName}. Record: ${record}${pointsFor}.`,
    "",
    `${sub} Starters`,
    ...r.starters.map(starterLine),
  ];
  const groups: [string, RosterPlayer[]][] = [["Bench", r.bench], ["IR", r.reserve], ["Taxi", r.taxi]];
  for (const [title, players] of groups) {
    if (players.length === 0) continue;
    lines.push("", `${sub} ${title}`, ...players.map((p) => `- ${p.position} ${playerLabel(p)}`));
  }
  return lines;
}

/**
 * Builds a Markdown summary of a roster, trending free agents and every
 * available player (grouped by position to keep it compact enough to paste
 * into a chat).
 */
function formatForClaude(
  leagueId: string,
  roster: UserRoster,
  trending: Awaited<ReturnType<typeof getAvailableTrendingPlayers>>,
  available: Awaited<ReturnType<typeof getAvailablePlayersByTeam>>
): string {
  const lines: string[] = [
    `# Fantasy football: my roster and waiver wire — Sleeper league ${leagueId}`,
    `Generated ${new Date().toLocaleString()}. The trending and available sections list only free agents in my league (QB, RB, WR, TE).`,
    "",
    ...formatRoster(roster, 2),
    "",
    `## Trending adds (last 24h, Sleeper-wide add count) — ${trending.length} players`,
  ];
  if (trending.length === 0) lines.push("None.");
  trending.forEach((p, i) => lines.push(`${i + 1}. ${p.position} ${playerLabel(p)} — +${p.add_count} adds`));

  lines.push("", `## All available players — ${available.length} players`);
  const byPosition = new Map<string, string[]>();
  for (const p of available) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position)!.push(playerLabel(p));
  }
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const players = (byPosition.get(pos) ?? []).sort();
    lines.push("", `### ${pos} (${players.length})`, players.join(", ") || "None.");
  }

  return lines.join("\n") + "\n";
}

async function printAndCopy(text: string, summary: string) {
  console.log(text);
  if (await copyToClipboard(text)) {
    console.log(`Copied to clipboard (${summary}).`);
  } else {
    console.error("Couldn't copy to the clipboard (pbcopy not found); copy the text above instead.");
  }
}

async function rosterCommand(leagueId: string, userId: string) {
  const roster = await getUserRoster(leagueId, userId);
  const rosterSize = roster.starters.length + roster.bench.length + roster.reserve.length + roster.taxi.length;
  await printAndCopy(formatRoster(roster, 1).join("\n") + "\n", `${roster.teamName}, ${rosterSize} slots`);
}

async function claudeCommand(leagueId: string, userId: string) {
  const snapshot = await getLeagueSnapshot(leagueId);
  const [roster, trending, available] = await Promise.all([
    getUserRoster(leagueId, userId, { snapshot }),
    getAvailableTrendingPlayers(leagueId, { lookbackHours: 24, limit: 100, snapshot }),
    getAvailablePlayersByTeam(leagueId, undefined, { snapshot }),
  ]);

  await printAndCopy(
    formatForClaude(leagueId, roster, trending, available),
    `${roster.teamName} roster, ${trending.length} trending, ${available.length} available`
  );
}

async function main() {
  const [command, leagueArg, username] = process.argv.slice(2);
  const config = loadConfig();
  const leagueId = resolveLeagueId(leagueArg, config);

  if (command === "available") {
    await availableCommand(leagueId);
  } else if (command === "roster") {
    await rosterCommand(leagueId, await resolveUserId(username, config));
  } else if (command === "claude") {
    await claudeCommand(leagueId, await resolveUserId(username, config));
  } else {
    await trendingCommand(leagueId);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof UsageError ? err.message : err);
    process.exit(1);
  });
}
