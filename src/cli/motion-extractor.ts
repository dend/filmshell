/**
 * Motion path extraction from film chunks
 * Ported from test-new-film.cjs and docs/motion-extraction.md
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { MotionPoint, PlayerPath } from './types.js';
import { dim } from './ui.js';

/**
 * Player index is encoded in bits 7-5 of the second byte of the frame type.
 * e.g., 40090005 = player 0, 40290005 = player 1 (0x09 vs 0x29, diff = 0x20)
 * Base frame type = second byte & 0x1f
 */
function getPlayerIndex(frameTypeByte1: number): number {
  return (frameTypeByte1 >> 5) & 0x07;
}

function getBaseType(frameTypeByte1: number): number {
  return frameTypeByte1 & 0x1f;
}

/**
 * Build the 4-byte frame type hex string for a given base type and player index.
 * Base type is the original hex string (e.g. '40090005'), player index 0-7.
 */
function buildFrameTypeHex(baseHex: string, playerIndex: number): string {
  const bytes = Buffer.from(baseHex, 'hex');
  bytes[1] = (bytes[1] & 0x1f) | ((playerIndex & 0x07) << 5);
  return bytes.toString('hex');
}

/**
 * Detect all players present in the film by scanning frame types.
 * Returns a sorted array of player indices found (e.g., [0] for single player, [0, 1] for two).
 */
const MIN_PLAYER_FRAMES = 10;

function detectPlayers(chunks: Buffer[]): number[] {
  const playerCounts = new Map<number, number>();

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 8 >= chunk.length) continue;
      const b0 = chunk[pos + 5];
      const b1 = chunk[pos + 6];
      // Only look at motion frame types (base 0x09 for XX0005, base 0x08 for XX8064)
      const base = getBaseType(b1);
      if (b0 === 0x40 && (base === 0x09 || base === 0x08)) {
        const pi = getPlayerIndex(b1);
        playerCounts.set(pi, (playerCounts.get(pi) || 0) + 1);
      }
    }
  }

  // Filter out spurious player indices with very few frames (noise)
  return [...playerCounts.entries()]
    .filter(([, count]) => count >= MIN_PLAYER_FRAMES)
    .map(([pi]) => pi)
    .sort((a, b) => a - b);
}

/**
 * Find all frame markers (A0 7B 42) in a buffer
 */
function findMarkers(buffer: Buffer): number[] {
  const positions: number[] = [];
  for (let i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === 0xa0 && buffer[i + 1] === 0x7b && buffer[i + 2] === 0x42) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Extract positions using frame type 40088064 (Bazaar and most maps)
 * Uses adaptive wraparound with 16384 threshold for positive deltas
 * to handle grappling hook and other fast movements correctly
 * @param targetType - Frame type hex string to match (e.g., '40088064' for player 0, '40288064' for player 1)
 */
function extract40088064(chunks: Buffer[], targetType = '40088064'): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const typeBytes = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeBytes !== targetType) continue;

      const b0 = chunk[pos + 10];
      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13] & 0x7f;

      const coord1Raw = b0 * 256 + b1;
      const coord2Raw = b2 * 256 + b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // Handle wraparound for coord1 (16-bit)
        // Use 16384 threshold for positive deltas to catch fast movements (grappling hook)
        // that wrap around the coordinate space but appear as large positive jumps
        // NOTE: Use else-if to prevent the negative wraparound from undoing the positive correction
        if (delta1 > 16384) {
          delta1 -= 65536;
        } else if (delta1 < -32768) {
          delta1 += 65536;
        }

        // Handle wraparound for coord2
        // coord2 can span 0-65407 (8-bit b2 + 7-bit b3), so use 16-bit wraparound
        // but also handle the case where it wraps within 15-bit range
        if (delta2 > 32768) delta2 -= 65536;
        else if (delta2 > 16384) delta2 -= 32768;
        if (delta2 < -32768) delta2 += 65536;
        else if (delta2 < -16384) delta2 += 32768;

        // NOTE: No discontinuity filtering for 40088064 - the adaptive wraparound handles it

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Extract positions using base type 0x09 frames
 * (Live Fire, Aquarius, and similar maps).
 * Uses 12-bit encoding for coord2 with discontinuity filtering.
 *
 * Position frames are identified by: byte5=0x40, base type 0x09,
 * AND data byte 0 high nibble = 4 (d[0] is 0x40 or 0x41).
 *
 * All matching frames are processed sequentially with cumulative deltas.
 * No deduplication — all data points are emitted.
 *
 * @param chunks - Film chunk buffers
 * @param playerIndex - Player index (0-7)
 */
function extractBase09Position(chunks: Buffer[], playerIndex: number): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevC1: number | null = null;
  let prevC2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;
  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];

      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;

      const b0 = chunk[pos + 10];

      // Filter: only position-channel frames (data byte 0 high nibble = 4)
      if ((b0 >> 4) !== 4) continue;

      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13];

      const c1 = b0 * 256 + b1;
      const c2 = ((b2 & 0x0f) << 8) | b3;

      if (prevC1 !== null && prevC2 !== null) {
        let delta1 = c1 - prevC1;
        let delta2 = c2 - prevC2;

        // 16-bit wraparound for coord1
        if (delta1 > 32768) delta1 -= 65536;
        if (delta1 < -32768) delta1 += 65536;

        // 12-bit wraparound for coord2 (range 0-4095)
        if (delta2 > 2048) delta2 -= 4096;
        if (delta2 < -2048) delta2 += 4096;

        // Skip discontinuities (spawn/death jumps or object switches)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
        if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: c1,
        raw2: c2,
      });

      prevC1 = c1;
      prevC2 = c2;
    }
  }

  return positions;
}

/**
 * Extract positions using frame type 40090005 (exact match, legacy path)
 * Used by variant detection for single-player films where exact match works.
 * @param targetType - Frame type hex string to match (e.g., '40090005' for player 0, '40290005' for player 1)
 */
function extract40090005_exact(chunks: Buffer[], targetType = '40090005'): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const typeBytes = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeBytes !== targetType) continue;

      const b0 = chunk[pos + 10];
      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13];

      const coord1Raw = b0 * 256 + b1;
      const coord2Raw = ((b2 & 0x0f) << 8) | b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // 16-bit wraparound for coord1
        if (delta1 > 32768) delta1 -= 65536;
        if (delta1 < -32768) delta1 += 65536;

        // 12-bit wraparound for coord2 (range 0-4095)
        if (delta2 > 2048) delta2 -= 4096;
        if (delta2 < -2048) delta2 += 4096;

        // Skip discontinuities (spawn/death jumps)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
        if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Extract positions using base type 0x09 "b3 variant" (Argyle and similar maps)
 * Uses 9-bit c1 from b0 bit 0 + b1, and 8-bit c2 from b3 alone.
 * Uses flexible matching: base type 0x09 + data[0] high nibble = 4.
 */
function extractBase09_b3variant(chunks: Buffer[], playerIndex: number): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  const DISCONTINUITY_THRESHOLD = 60;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;

      const b0 = chunk[pos + 10];
      // Only position-channel frames
      if ((b0 >> 4) !== 4) continue;

      const b1 = chunk[pos + 11];
      const b3 = chunk[pos + 13];

      // c1 uses b0 bit 0 as the 9th bit (carry), b1 as the lower 8 bits
      const coord1Raw = ((b0 & 1) << 8) | b1;
      // c2 is just b3 (8-bit)
      const coord2Raw = b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // 9-bit wraparound for coord1
        if (delta1 > 256) delta1 -= 512;
        if (delta1 < -256) delta1 += 512;

        // 8-bit wraparound for coord2
        if (delta2 > 128) delta2 -= 256;
        if (delta2 < -128) delta2 += 256;

        // Skip discontinuities (deaths/respawns)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD || Math.abs(delta2) > DISCONTINUITY_THRESHOLD) {
          // Skip this frame's delta
        } else {
          cumCoord1 += delta1;
          cumCoord2 += delta2;
        }
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Detect the encoding variant for base-0x09 position frames.
 *
 * The b5 pattern check is only valid for frames with exact subtype 0005
 * (e.g., 40090005). In multi-player films, other subtypes like 4009004d have
 * different non-data field layouts, so b5 pattern checks on them give false results.
 *
 * Strategy:
 * 1. If there are enough exact-0005 frames, use those for b5 pattern detection
 * 2. Otherwise, check c1 range: if c1 values span a wide range (>500), it's
 *    standard 16-bit encoding; if narrow (<512), might be b3variant with 9-bit c1
 *
 * Returns detection info for all three possible variants:
 * - "9bit": standard (b5 pattern valid on 0005 frames, or standard c1 range)
 * - "b3variant": b3 variant (narrow c1 range, b5 pattern fails on 0005 frames)
 * - "standard": standard 16-bit c1, 12-bit c2
 */
function detectBase09Variant(chunks: Buffer[], playerIndex: number): {
  variant: '9bit' | 'b3variant' | 'standard' | 'invalid';
  frameCount: number;
  b0PatternPct: number;
  b5PatternPct: number;
  uniqueB3: number;
  uniqueC2_9bit: number;
} {
  // Collect data from ALL position frames (base 0x09, d[0] hnib=4)
  const allB0Values: number[] = [];
  const allB3Values: number[] = [];
  const allC1Values: number[] = [];

  // Separately track exact-0005 subtype frames for b5 pattern detection
  const exact0005B5: number[] = [];
  const exact0005C2_9bit: number[] = [];

  const targetExactType = buildFrameTypeHex('40090005', playerIndex);

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 16 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;

      const d0 = chunk[pos + 10];
      if ((d0 >> 4) !== 4) continue;

      allB0Values.push(d0);
      allB3Values.push(chunk[pos + 13]);
      allC1Values.push(d0 * 256 + chunk[pos + 11]);

      // Check exact subtype for b5 pattern
      const typeHex = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeHex === targetExactType) {
        exact0005B5.push(chunk[pos + 15]);
        exact0005C2_9bit.push(((chunk[pos + 15] & 1) << 8) | chunk[pos + 16]);
      }
    }
  }

  const frameCount = allB0Values.length;
  if (frameCount < 20) {
    return { variant: 'invalid', frameCount, b0PatternPct: 0, b5PatternPct: 0, uniqueB3: 0, uniqueC2_9bit: 0 };
  }

  const b0PatternPct = allB0Values.filter(v => {
    const hi = v >> 4;
    return hi === 0 || hi === 4;
  }).length / frameCount * 100;

  const uniqueB3 = new Set(allB3Values).size;

  // Use exact-0005 frames for b5 pattern if available (>= 10 frames)
  let b5PatternPct: number;
  let uniqueC2_9bit: number;

  if (exact0005B5.length >= 10) {
    b5PatternPct = exact0005B5.filter(v => (v & 0x1e) === 0).length / exact0005B5.length * 100;
    uniqueC2_9bit = new Set(exact0005C2_9bit).size;
  } else {
    // No exact-0005 frames available - use c1 range heuristic
    // Standard 16-bit c1 has wide range (thousands); b3variant 9-bit c1 max is 511
    const minC1 = Math.min(...allC1Values);
    const maxC1 = Math.max(...allC1Values);
    const c1Range = maxC1 - minC1;

    // If c1 range > 512, it's definitely not b3variant (which uses 9-bit = max 511)
    if (c1Range > 512) {
      b5PatternPct = 100; // Force standard/9bit detection
      uniqueC2_9bit = 100;
    } else {
      b5PatternPct = 0;
      uniqueC2_9bit = 0;
    }
  }

  // Standard 9-bit: b0 pattern >=95% AND b5 pattern >=95% AND unique c2_9bit >=20
  if (b0PatternPct >= 95 && b5PatternPct >= 95 && uniqueC2_9bit >= 20) {
    return { variant: '9bit', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  // b3 variant: b0 pattern >=95% AND b5 pattern <50% AND b3 has good variation
  if (b0PatternPct >= 95 && b5PatternPct < 50 && uniqueB3 >= 20) {
    return { variant: 'b3variant', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  // Standard: b3 varies (original validation)
  if (uniqueB3 >= 20) {
    return { variant: 'standard', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  return { variant: 'invalid', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
}

/**
 * Count base-0x09 position frames for a player using flexible matching.
 */
function countBase09PositionFrames(chunks: Buffer[], playerIndex: number): number {
  let count = 0;
  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;
      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      if ((chunk[pos + 10] >> 4) !== 4) continue;
      count++;
    }
  }
  return count;
}

/**
 * Extract raw position data from film chunks for a specific player.
 * Auto-detects best frame type and encoding variant.
 *
 * Uses flexible matching for base-0x09 frames: matches by base type and
 * data byte 0 pattern rather than exact 4-byte frame type. This correctly
 * handles multi-player films where frame subtypes vary (e.g., 4009004d
 * instead of 40090005).
 *
 * Priority:
 * 1. base-0x09 position frames (standard 12-bit c2) - most maps
 * 2. base-0x09 b3-variant (9-bit c1, 8-bit c2) - Argyle
 * 3. 40088064 exact match (16-bit coords) - Bazaar fallback
 *
 * @param playerIndex - Player index (0 for single-player, 0-7 for multi-player)
 * Returns cumulative delta values (not scaled to world units)
 */
export function extractRawPositions(
  chunks: Buffer[],
  playerIndex = 0,
  onStatus?: (msg: string) => void
): MotionPoint[] {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const type88064 = buildFrameTypeHex('40088064', playerIndex);

  const pos40088064 = extract40088064(chunks, type88064);
  const base09Count = countBase09PositionFrames(chunks, playerIndex);
  const detection = detectBase09Variant(chunks, playerIndex);

  const prefix = playerIndex > 0 ? `[P${playerIndex + 1}] ` : '';

  log(`${prefix}Frame type detection: 40088064=${pos40088064.length}, base-0x09=${base09Count} (${detection.variant})`);

  // Priority 1: standard base-0x09 position (12-bit c2)
  if (detection.variant === '9bit' || detection.variant === 'standard') {
    const pos = extractBase09Position(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 position ${detection.variant} (${pos.length} frames)`);
    return pos;
  }

  // Priority 2: b3 variant (Argyle-type maps)
  if (detection.variant === 'b3variant' && base09Count >= pos40088064.length) {
    const pos = extractBase09_b3variant(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 b3-variant (${pos.length} frames)`);
    return pos;
  }

  // Priority 3: fallback to 40088064
  if (pos40088064.length >= 20) {
    log(`${prefix}Using: 40088064 (${pos40088064.length} frames)`);
    return pos40088064;
  }

  // Last resort: whichever has more frames
  if (base09Count > pos40088064.length) {
    const pos = extractBase09Position(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 position (fallback, ${pos.length} frames)`);
    return pos;
  }

  log(`${prefix}Using: 40088064 (fallback, ${pos40088064.length} frames)`);
  return pos40088064;
}

/**
 * Extract positions for all players detected in the film.
 * Returns an array of PlayerPath objects, one per player.
 */
export function extractAllPlayerPositions(
  chunks: Buffer[],
  onStatus?: (msg: string) => void
): PlayerPath[] {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const players = detectPlayers(chunks);
  log(`Detected ${players.length} player(s) in film: [${players.join(', ')}]`);

  const paths: PlayerPath[] = [];
  for (const playerIndex of players) {
    const positions = extractRawPositions(chunks, playerIndex, onStatus);
    if (positions.length > 0) {
      paths.push({ playerIndex, positions });
    }
  }

  return paths;
}

/**
 * Load all decompressed film chunks from a directory
 */
export async function loadFilmChunks(
  filmDir: string,
  onStatus?: (msg: string) => void
): Promise<Buffer[]> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const chunks: Buffer[] = [];

  for (let i = 0; i < 20; i++) {
    const filePath = join(filmDir, `filmChunk${i}_dec`);
    if (existsSync(filePath)) {
      const chunk = await readFile(filePath);
      chunks.push(chunk);
    } else {
      break;
    }
  }

  log(`Loaded ${chunks.length} film chunks`);
  return chunks;
}

/**
 * Compute motion statistics
 * @param filmLengthMs - Film length in milliseconds from metadata (optional, for Hz calculation)
 */
export function computeMotionStats(
  positions: MotionPoint[],
  filmLengthMs?: number
): {
  totalFrames: number;
  durationSeconds: number;
  calculatedHz: number | null;
  maxDeltaCoord1: number;
  maxDeltaCoord2: number;
  rangeCoord1: number;
  rangeCoord2: number;
} {
  if (positions.length === 0) {
    return {
      totalFrames: 0,
      durationSeconds: 0,
      calculatedHz: null,
      maxDeltaCoord1: 0,
      maxDeltaCoord2: 0,
      rangeCoord1: 0,
      rangeCoord2: 0,
    };
  }

  let minC1 = Infinity, maxC1 = -Infinity;
  let minC2 = Infinity, maxC2 = -Infinity;

  for (const p of positions) {
    minC1 = Math.min(minC1, p.cumCoord1);
    maxC1 = Math.max(maxC1, p.cumCoord1);
    minC2 = Math.min(minC2, p.cumCoord2);
    maxC2 = Math.max(maxC2, p.cumCoord2);
  }

  const last = positions[positions.length - 1];

  // Calculate actual Hz if film length is provided
  let calculatedHz: number | null = null;
  let durationSeconds: number;

  if (filmLengthMs && filmLengthMs > 0) {
    const filmLengthSeconds = filmLengthMs / 1000;
    calculatedHz = positions.length / filmLengthSeconds;
    durationSeconds = filmLengthSeconds;
  } else {
    // Fallback: assume 60Hz
    durationSeconds = positions.length / 60;
  }

  return {
    totalFrames: positions.length,
    durationSeconds,
    calculatedHz,
    maxDeltaCoord1: Math.abs(last.cumCoord1),
    maxDeltaCoord2: Math.abs(last.cumCoord2),
    rangeCoord1: maxC1 - minC1,
    rangeCoord2: maxC2 - minC2,
  };
}
