/**
 * Film download and decompression module
 * Extracted from src/index.ts
 */

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { HaloInfiniteClient, MatchType, isSuccess, isNotModified } from '@dendotdev/grunt';
import type { FilmResponse, DownloadedFilm } from './types.js';
import { dim, green, yellow, red, bold } from './ui.js';

export async function downloadLatestFilms(
  client: HaloInfiniteClient,
  xuid: string,
  count: number = 1,
  onStatus?: (msg: string) => void
): Promise<DownloadedFilm[]> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));

  log(`Fetching match history (${count} match${count > 1 ? 'es' : ''})...`);

  const history = await client.stats.getMatchHistory(xuid, 0, count, MatchType.All);

  if (!isSuccess(history) && !isNotModified(history)) {
    log(`Failed to fetch match history: ${history.response.code}`);
    return [];
  }

  const result = history.result as Record<string, unknown>;
  const resultsArray = (result.Results ?? result.results) as Record<string, unknown>[] | undefined;

  if (!resultsArray || resultsArray.length === 0) {
    log('No matches found.');
    return [];
  }

  log(`Found ${resultsArray.length} match${resultsArray.length > 1 ? 'es' : ''}`);

  const films: DownloadedFilm[] = [];

  for (let mi = 0; mi < resultsArray.length; mi++) {
    const match = resultsArray[mi];
    const matchId = (match.MatchId ?? match.matchId) as string;

    if (!matchId || matchId === '-') {
      log(`[${mi + 1}/${resultsArray.length}] No valid match ID, skipping.`);
      continue;
    }

    log(`[${mi + 1}/${resultsArray.length}] Match: ${matchId}`);
    log('Fetching match stats...');

    const stats = await client.stats.getMatchStats(matchId);
    if (!isSuccess(stats) && !isNotModified(stats)) {
      log(`Failed to fetch match stats: ${stats.response.code}`);
      continue;
    }

    const matchStats = stats.result;

    // Extract match details from stats for display
    const statsObj = matchStats as Record<string, unknown>;
    const matchInfo = (statsObj.MatchInfo ?? statsObj.matchInfo) as Record<string, unknown> | undefined;
    const mapVariant = (matchInfo?.MapVariant ?? matchInfo?.mapVariant) as Record<string, unknown> | undefined;
    const gameVariant = (matchInfo?.UgcGameVariant ?? matchInfo?.ugcGameVariant ?? matchInfo?.GameVariant ?? matchInfo?.gameVariant) as Record<string, unknown> | undefined;
    const playlist = (matchInfo?.Playlist ?? matchInfo?.playlist) as Record<string, unknown> | undefined;

    const mapName = (mapVariant?.PublicName ?? mapVariant?.publicName ?? mapVariant?.Name ?? mapVariant?.name ?? 'Unknown Map') as string;
    const gameMode = (gameVariant?.PublicName ?? gameVariant?.publicName ?? gameVariant?.Name ?? gameVariant?.name) as string | undefined;
    const playlistName = (playlist?.PublicName ?? playlist?.publicName ?? playlist?.Name ?? playlist?.name) as string | undefined;

    const modeParts: string[] = [];
    if (gameMode) modeParts.push(gameMode);
    if (playlistName && playlistName !== gameMode) modeParts.push(playlistName);
    const modeLabel = modeParts.length > 0 ? modeParts.join(' / ') : 'Unknown Mode';

    log(`[${mi + 1}/${resultsArray.length}] ${mapName} — ${modeLabel} (${matchId.slice(0, 8)}…)`);

    const filmResult = await client.ugcDiscovery.getFilmByMatchId(matchId);

    if (!isSuccess(filmResult) && !isNotModified(filmResult)) {
      log('No film available for this match (films expire after ~2 weeks).');
      continue;
    }

    const film = filmResult.result as unknown as FilmResponse;

    const blobPrefix = film.BlobStoragePathPrefix;
    const chunks = film.CustomData?.Chunks;

    if (!blobPrefix || !chunks?.length) {
      log('Film has no downloadable chunks.');
      continue;
    }

    // Strip the origin from the blob prefix
    const blobOrigin = 'https://blobs-infiniteugc.svc.halowaypoint.com';
    let blobPathPrefix = blobPrefix.startsWith(blobOrigin)
      ? blobPrefix.slice(blobOrigin.length)
      : blobPrefix;

    if (blobPathPrefix.endsWith('/')) {
      blobPathPrefix = blobPathPrefix.slice(0, -1);
    }

    const filmsDir = join(process.cwd(), 'films', matchId);
    await mkdir(filmsDir, { recursive: true });

    // Save match metadata
    await writeFile(join(filmsDir, 'match-metadata.json'), JSON.stringify(matchStats, null, 2));
    log('Saved match-metadata.json');

    // Save film metadata
    await writeFile(join(filmsDir, 'film-metadata.json'), JSON.stringify(film, null, 2));
    log('Saved film-metadata.json');

    log(`Downloading ${chunks.length} chunk(s)...`);

    for (const chunk of chunks) {
      const blobPath = blobPathPrefix + chunk.FileRelativePath;
      const filename = `filmChunk${chunk.Index}`;
      const compressedPath = join(filmsDir, filename);
      const decompressedPath = join(filmsDir, `${filename}_dec`);

      log(`[${chunk.Index + 1}/${chunks.length}] ${filename} (${(chunk.ChunkSize / 1024).toFixed(1)} KB)`);

      const blob = await client.ugc.getBlob(blobPath);

      if (!isSuccess(blob) && !isNotModified(blob)) {
        log(`Failed to download chunk: ${blob.response.code}`);
        continue;
      }

      // Write compressed file temporarily
      await writeFile(compressedPath, blob.result!);

      // Decompress with zlib
      try {
        const compressed = blob.result! as Buffer;
        const decompressed = inflateSync(compressed);
        await writeFile(decompressedPath, decompressed);
        log(`Decompressed ${filename} (${(decompressed.length / 1024).toFixed(1)} KB)`);

        // Delete the compressed original
        await unlink(compressedPath);
      } catch (err) {
        log(`Decompression failed, keeping original: ${(err as Error).message}`);
      }
    }

    log(`Film saved to: ${filmsDir}`);

    // Extract match end time and duration from stats
    const startTime = (matchInfo?.StartTime ?? matchInfo?.startTime) as string | undefined;
    const durationStr = (matchInfo?.Duration ?? matchInfo?.duration) as string | undefined;

    let matchEndTimePT = '-';
    let matchDuration: string | undefined;
    if (startTime && durationStr) {
      const startDate = new Date(startTime);
      const durationMatch = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1] ?? '0');
        const minutes = parseInt(durationMatch[2] ?? '0');
        const seconds = parseFloat(durationMatch[3] ?? '0');
        const durationMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
        const endDate = new Date(startDate.getTime() + durationMs);
        matchEndTimePT = endDate.toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        // Human-readable duration
        const parts: string[] = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (seconds > 0) parts.push(`${Math.round(seconds)}s`);
        matchDuration = parts.join(' ') || '0s';
      }
    }

    films.push({
      matchId,
      matchEndTimePT,
      filmDir: filmsDir,
      matchStats,
      filmLengthMs: film.CustomData?.FilmLength ?? 0,
      mapName,
      gameMode: modeLabel,
      matchDuration,
    });
  }

  return films;
}
