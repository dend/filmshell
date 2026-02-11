/**
 * FilmShell CLI - Main entry point
 *
 * Downloads the latest match film, fetches map metadata with MVAR,
 * computes map bounds from objects, and generates an SVG path visualization
 * with proper world coordinate scaling.
 *
 * Usage:
 *   npx filmshell                    # Download and process latest match
 *   npx filmshell --count 5          # Download and process latest 5 matches
 *   npx filmshell --match-id <guid>  # Process existing match (already downloaded)
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { getAuthenticatedClient } from './auth.js';
import { downloadLatestFilms } from './film-downloader.js';
import { fetchMapMvar } from './map-metadata.js';
import { parseBond } from './bond-parser.js';
import { loadObjectIds, extractObjects, computeMapBounds, filterImportantObjects } from './object-extractor.js';
import { loadFilmChunks, extractAllPlayerPositions, computeMotionStats } from './motion-extractor.js';
import {
  scaleMotionToWorld,
  scaleAllPlayersToWorld,
  findBestSpawnAnchor,
  generateSvg,
  generateMultiPlayerSvg,
  getPlayerColor,
} from './svg-generator.js';
import type { PlayerWorldPath } from './svg-generator.js';
import {
  bold, dim, green, red, yellow,
  Spinner, box, step, detail, success, warning, error as uiError, gap,
} from './ui.js';

interface FilmInfo {
  matchId: string;
  filmDir: string;
  matchStats: unknown;
  filmLengthMs?: number;
  matchEndTimePT?: string;
  mapName?: string;
  gameMode?: string;
  matchDuration?: string;
}

function parseArgs(): { matchId?: string; count: number } {
  const args = process.argv.slice(2);
  const result: { matchId?: string; count: number } = { count: 1 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--match-id' && args[i + 1]) {
      result.matchId = args[i + 1];
      i++;
    } else if (args[i] === '--count' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (isNaN(n) || n < 1) {
        console.error('--count must be a positive integer');
        process.exit(1);
      }
      result.count = n;
      i++;
    }
  }

  return result;
}

async function loadExistingFilm(matchId: string): Promise<FilmInfo | null> {
  const filmDir = join('films', matchId);

  if (!existsSync(filmDir)) {
    uiError(`Film directory not found: ${filmDir}`);
    return null;
  }

  // Load match metadata
  const matchMetaPath = join(filmDir, 'match-metadata.json');
  if (!existsSync(matchMetaPath)) {
    uiError(`Match metadata not found: ${matchMetaPath}`);
    return null;
  }

  const matchStats = JSON.parse(await readFile(matchMetaPath, 'utf-8'));

  // Load film metadata for duration
  let filmLengthMs: number | undefined;
  const filmMetaPath = join(filmDir, 'film-metadata.json');
  if (existsSync(filmMetaPath)) {
    const filmMeta = JSON.parse(await readFile(filmMetaPath, 'utf-8'));
    filmLengthMs = filmMeta.FilmLength;
  }

  // Extract match details from stats
  const mi = matchStats?.MatchInfo ?? matchStats?.matchInfo;
  const matchEndTimePT = mi?.EndTime
    ? new Date(mi.EndTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
    : undefined;

  const mv = mi?.MapVariant ?? mi?.mapVariant;
  const gv = mi?.UgcGameVariant ?? mi?.ugcGameVariant ?? mi?.GameVariant ?? mi?.gameVariant;
  const pl = mi?.Playlist ?? mi?.playlist;

  const mapName = (mv?.PublicName ?? mv?.publicName ?? mv?.Name ?? mv?.name) as string | undefined;
  const gMode = (gv?.PublicName ?? gv?.publicName ?? gv?.Name ?? gv?.name) as string | undefined;
  const plName = (pl?.PublicName ?? pl?.publicName ?? pl?.Name ?? pl?.name) as string | undefined;

  const modeParts: string[] = [];
  if (gMode) modeParts.push(gMode);
  if (plName && plName !== gMode) modeParts.push(plName);
  const gameMode = modeParts.length > 0 ? modeParts.join(' / ') : undefined;

  // Parse match duration
  let matchDuration: string | undefined;
  const durStr = (mi?.Duration ?? mi?.duration) as string | undefined;
  if (durStr) {
    const dm = durStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (dm) {
      const parts: string[] = [];
      const h = parseInt(dm[1] ?? '0');
      const m = parseInt(dm[2] ?? '0');
      const s = Math.round(parseFloat(dm[3] ?? '0'));
      if (h > 0) parts.push(`${h}h`);
      if (m > 0) parts.push(`${m}m`);
      if (s > 0) parts.push(`${s}s`);
      matchDuration = parts.join(' ') || '0s';
    }
  }

  return {
    matchId,
    filmDir,
    matchStats,
    filmLengthMs,
    matchEndTimePT,
    mapName,
    gameMode,
    matchDuration,
  };
}

async function processFilm(
  downloadedFilm: FilmInfo,
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>['client'] | null,
): Promise<void> {
  let bondDoc = null;
  let objects: Awaited<ReturnType<typeof extractObjects>> = [];
  let mapBounds = null;

  // ── Stage 3: Map / MVAR Analysis ──────────────────────────────────────
  step(3, 'Map Analysis');

  const cachedObjectsPath = join(downloadedFilm.filmDir, 'objects.json');
  if (existsSync(cachedObjectsPath)) {
    const mapSpinner = new Spinner('Loading cached map objects...').start();
    try {
      objects = JSON.parse(await readFile(cachedObjectsPath, 'utf-8'));

      if (objects.length > 0) {
        mapBounds = computeMapBounds(objects);
      }

      objects = filterImportantObjects(objects);
      mapSpinner.succeed(`Loaded ${objects.length} map objects (cached), ${objects.length} important`);
    } catch (err) {
      mapSpinner.warn(`Failed to load cached objects: ${(err as Error).message}`);
      objects = [];
    }
  } else if (client) {
    const mapSpinner = new Spinner('Fetching map metadata...').start();
    const mvarInfo = await fetchMapMvar(client, downloadedFilm.matchStats, (msg) => mapSpinner.update(msg));

    if (mvarInfo) {
      mapSpinner.update('Parsing MVAR (Bond CB2)...');
      try {
        bondDoc = parseBond(mvarInfo.buffer);

        const mvarJsonPath = join(downloadedFilm.filmDir, 'mvar.json');
        await writeFile(mvarJsonPath, JSON.stringify(bondDoc, null, 2));
      } catch (err) {
        mapSpinner.warn(`MVAR parsing failed: ${(err as Error).message}`);
      }

      if (bondDoc) {
        mapSpinner.update('Extracting map objects...');
        const objectIds = await loadObjectIds(process.cwd(), (msg) => mapSpinner.update(msg));
        objects = extractObjects(bondDoc, objectIds);

        const objectsJsonPath = join(downloadedFilm.filmDir, 'objects.json');
        await writeFile(objectsJsonPath, JSON.stringify(objects, null, 2));

        mapBounds = computeMapBounds(objects);
        objects = filterImportantObjects(objects);

        mapSpinner.succeed(
          `Extracted ${objects.length} objects, bounds ${mapBounds.width.toFixed(0)}x${mapBounds.height.toFixed(0)} units`
        );
      } else {
        mapSpinner.warn('MVAR parse produced no document');
      }
    } else {
      mapSpinner.warn('Map metadata not available, skipping MVAR');
    }
  } else if (!existsSync(cachedObjectsPath)) {
    warning('No cached objects and no API client — skipping MVAR');
  }

  // ── Stage 4: Motion Analysis ──────────────────────────────────────────
  step(4, 'Motion Analysis');

  const motionSpinner = new Spinner('Loading film chunks...').start();
  const chunks = await loadFilmChunks(downloadedFilm.filmDir, (msg) => motionSpinner.update(msg));

  motionSpinner.update('Extracting player positions...');
  const playerPaths = extractAllPlayerPositions(chunks, (msg) => motionSpinner.update(msg));

  if (playerPaths.length === 0) {
    motionSpinner.warn('No movement frames found in film');
    return;
  }

  const rawPositions = playerPaths[0].positions;

  motionSpinner.succeed(`${playerPaths.length} player(s), ${rawPositions.length} frames`);

  // Per-player stats
  for (const pp of playerPaths) {
    const stats = computeMotionStats(pp.positions, downloadedFilm.filmLengthMs);
    detail(`P${pp.playerIndex + 1}`, `${stats.totalFrames} frames, range C1=${stats.rangeCoord1} C2=${stats.rangeCoord2}`);
  }

  const motionStats = computeMotionStats(rawPositions, downloadedFilm.filmLengthMs);
  if (motionStats.calculatedHz !== null) {
    detail('Duration', `${motionStats.durationSeconds.toFixed(2)}s @ ${motionStats.calculatedHz.toFixed(2)} Hz`);
  } else {
    detail('Duration', `~${motionStats.durationSeconds.toFixed(1)}s (est. 60Hz)`);
  }

  // Find best spawn anchor for positioning
  let spawnAnchor: { x: number; y: number } | null = null;
  if (mapBounds && objects.length > 0 && playerPaths.length > 0) {
    const initialSpawns = objects
      .filter(o => o.name && o.name.includes('[Initial]'))
      .map(o => ({ x: o.position.x, y: o.position.y }));
    if (initialSpawns.length > 0) {
      spawnAnchor = findBestSpawnAnchor(playerPaths[0].positions, mapBounds, initialSpawns);
      if (spawnAnchor) {
        detail('Anchor', `Initial Spawn at (${spawnAnchor.x.toFixed(1)}, ${spawnAnchor.y.toFixed(1)})`);
      }
    }
  }

  // Scale all player paths to world coordinates
  let playerWorldPaths: PlayerWorldPath[];
  if (playerPaths.length > 1) {
    const allRawPositions = playerPaths.map(pp => pp.positions);
    const allWorldPositions = scaleAllPlayersToWorld(allRawPositions, mapBounds, spawnAnchor);
    playerWorldPaths = playerPaths.map((pp, idx) => ({
      playerIndex: pp.playerIndex,
      label: `P${pp.playerIndex + 1}`,
      positions: allWorldPositions[idx],
      color: getPlayerColor(pp.playerIndex),
    }));
  } else {
    playerWorldPaths = playerPaths.map(pp => {
      const worldPositions = scaleMotionToWorld(pp.positions, mapBounds, spawnAnchor);
      return {
        playerIndex: pp.playerIndex,
        label: `P${pp.playerIndex + 1}`,
        positions: worldPositions,
        color: getPlayerColor(pp.playerIndex),
      };
    });
  }

  // Per-player world stats
  for (const pwp of playerWorldPaths) {
    if (pwp.positions.length > 0) {
      const first = pwp.positions[0];
      const last = pwp.positions[pwp.positions.length - 1];
      const distance = Math.sqrt(
        Math.pow(last.x - first.x, 2) + Math.pow(last.y - first.y, 2)
      );
      detail(pwp.label, `${distance.toFixed(1)} world units traveled`);
    }
  }

  const worldPositions = playerWorldPaths.length > 0 ? playerWorldPaths[0].positions : [];

  // ── Stage 5: SVG Generation ───────────────────────────────────────────
  step(5, 'SVG Generation');

  const svgSpinner = new Spinner('Generating SVG...').start();

  let svg: string;
  if (playerWorldPaths.length > 1) {
    svg = generateMultiPlayerSvg(playerWorldPaths, mapBounds, objects, downloadedFilm.matchId);
  } else {
    svg = generateSvg(worldPositions, mapBounds, objects, downloadedFilm.matchId);
  }
  const svgPath = join(downloadedFilm.filmDir, 'path.svg');
  await writeFile(svgPath, svg);

  svgSpinner.succeed(`Saved SVG → ${svgPath}`);

  // ── Summary Box ───────────────────────────────────────────────────────
  gap();
  const summaryLines: string[] = [];
  if (downloadedFilm.mapName) {
    summaryLines.push(`${dim('Map:')}         ${bold(downloadedFilm.mapName)}`);
  }
  if (downloadedFilm.gameMode) {
    summaryLines.push(`${dim('Mode:')}        ${downloadedFilm.gameMode}`);
  }
  summaryLines.push(`${dim('Match ID:')}    ${downloadedFilm.matchId}`);
  summaryLines.push(`${dim('Match Time:')}  ${downloadedFilm.matchEndTimePT ?? '-'}`);
  if (downloadedFilm.matchDuration) {
    summaryLines.push(`${dim('Duration:')}    ${downloadedFilm.matchDuration}`);
  }
  summaryLines.push(`${dim('Film Dir:')}    ${downloadedFilm.filmDir}`);
  summaryLines.push(`${dim('Players:')}     ${playerPaths.length}`);
  for (const pwp of playerWorldPaths) {
    summaryLines.push(`  ${pwp.label}: ${pwp.positions.length} frames`);
  }
  if (motionStats.calculatedHz !== null) {
    summaryLines.push(`${dim('Frame Rate:')}  ${motionStats.calculatedHz.toFixed(2)} Hz`);
  }
  if (mapBounds && mapBounds.width > 0) {
    summaryLines.push(`${dim('Map Size:')}    ${mapBounds.width.toFixed(0)} x ${mapBounds.height.toFixed(0)} units`);
  }
  summaryLines.push(`${dim('SVG Output:')}  ${green(svgPath)}`);

  box(summaryLines, { title: 'Summary', style: 'double', borderColor: green });
}

async function main(): Promise<void> {
  // Banner
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version: string };

  gap();
  box(
    [
      `${dim('Version: ' + pkg.version)}`,
      dim('https://github.com/dend/filmshell'),
    ],
    { title: 'FilmShell', style: 'double' }
  );

  const args = parseArgs();
  let client: Awaited<ReturnType<typeof getAuthenticatedClient>>['client'] | null = null;

  if (args.matchId) {
    // Load existing film (offline mode)
    step(1, 'Loading Existing Film');
    const loadSpinner = new Spinner(`Loading film: ${args.matchId}`).start();
    const downloadedFilm = await loadExistingFilm(args.matchId);

    if (!downloadedFilm) {
      loadSpinner.fail('Film not found');
      process.exit(1);
    }

    const filmLabel = [
      downloadedFilm.mapName,
      downloadedFilm.gameMode,
      downloadedFilm.matchDuration,
    ].filter(Boolean).join(dim(' | '));
    loadSpinner.succeed(filmLabel || `Loaded film from: ${downloadedFilm.filmDir}`);
    detail('Match', downloadedFilm.matchId);
    if (downloadedFilm.matchEndTimePT) detail('Time', downloadedFilm.matchEndTimePT);
    await processFilm(downloadedFilm, null);
  } else {
    // ── Stage 1: Authentication ─────────────────────────────────────────
    step(1, 'Authentication');
    const authSpinner = new Spinner('Authenticating...').start();
    const auth = await getAuthenticatedClient((msg) => authSpinner.update(msg));
    client = auth.client;
    authSpinner.succeed('Authenticated successfully');

    // ── Stage 2: Download Films ─────────────────────────────────────────
    step(2, `Downloading ${args.count} film${args.count > 1 ? 's' : ''}`);
    const dlSpinner = new Spinner('Fetching match history...').start();
    const downloadedFilms = await downloadLatestFilms(
      client, auth.xuid, args.count,
      (msg) => dlSpinner.update(msg)
    );

    if (downloadedFilms.length === 0) {
      dlSpinner.fail('Failed to download any films');
      process.exit(1);
    }

    dlSpinner.succeed(`Downloaded ${downloadedFilms.length} film${downloadedFilms.length > 1 ? 's' : ''}`);

    // Show downloaded film details
    for (const f of downloadedFilms) {
      const parts = [f.mapName ?? 'Unknown Map', f.gameMode ?? 'Unknown Mode'];
      if (f.matchDuration) parts.push(f.matchDuration);
      if (f.matchEndTimePT && f.matchEndTimePT !== '-') parts.push(f.matchEndTimePT);
      detail(f.matchId.slice(0, 8), parts.join(dim(' | ')));
    }

    // Process each film
    for (let i = 0; i < downloadedFilms.length; i++) {
      if (downloadedFilms.length > 1) {
        gap();
        const f = downloadedFilms[i];
        box(
          [
            `Film ${bold(`${i + 1}/${downloadedFilms.length}`)}: ${f.mapName ?? 'Unknown Map'} — ${f.gameMode ?? ''}`,
            dim(f.matchId),
          ],
          { style: 'single' }
        );
      }
      await processFilm(downloadedFilms[i], client);
    }
  }
}

main().catch((err) => {
  gap();
  uiError(err.message);
  process.exit(1);
});
