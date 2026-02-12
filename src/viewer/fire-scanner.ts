/**
 * Fire event scanner — finds weapon fire events in film chunk data.
 *
 * Fire events are bit-packed at a 4-bit offset in the binary stream.
 * Pattern: 0d 26 00 40 [ctr] [slot] [weapon 8B] [octant] [u16] [aim...]
 * Discovery and initial decoding by Andy Curtis.
 */

import { decodeOctahedralAim } from './octahedral-decode.ts';

// ── Types ──

export interface FireEvent {
  /** Byte offset in the concatenated chunk data */
  offset: number;
  /** Which chunk this event was found in */
  chunkIndex: number;
  /** Fire counter (increments by 4 per shot) */
  counter: number;
  /** Weapon slot: 1=primary, 3=secondary */
  slot: number;
  /** 8-byte weapon ID as hex string */
  weaponId: string;
  /** Human-readable weapon name, or 'Unknown' */
  weaponName: string;
  /** Octant byte for aim direction (0-7 in low 3 bits) */
  octantByte: number;
  /** Aim uint16 — position within octahedral face */
  aimUint16: number;
  /** Decoded aim direction as unit vector */
  aimDirection: { x: number; y: number; z: number };
}

export interface FireScanResult {
  events: FireEvent[];
  /** Count per weapon name */
  weaponCounts: Map<string, number>;
}

// ── Weapon ID table ──
// From Andy Curtis: https://github.com/dend/blog-comments/issues/5#issuecomment-3882279646

const WEAPON_IDS: Record<string, string> = {
  '48c19d2d42c9679f': 'MA40 AR',
  'f408190f42c9679f': 'Mk51 Sidekick',
  '2b1824d542c9679f': 'BR75',
  '2fb21c8742c9679f': 'M392 Bandit',
  'fd98554c42c9679f': 'VK78 Commando',
  '0a1992bc42c9679f': 'S7 Sniper',
  'b619d84a42c9679f': 'CQS48 Bulldog',
  '71ab0a2c42c9679f': 'M41 SPNKr',
  'b533957e42c9679f': 'Needler',
  '7e53b3c642c9679f': 'Pulse Carbine',
  '04e7f00b42c9679f': 'Plasma Pistol',
  'c24e549e42c9679f': 'Sentinel Beam',
  '3d34488542c9679f': 'Heatwave',
  'f5ef3bdb42c9679f': 'Stalker Rifle',
  'fcc6aa7642c9679f': 'Shock Rifle',
  '7deb133f42c9679f': 'Mangler',
  'cb30ec5e42c9679f': 'Disruptor',
  '2b1d61e442c9679f': 'Ravager',
  '7a11aeef42c9679f': 'Skewer',
  'c2a6d5e042c9679f': 'Cindershot',
  '1f6ae65542c9679f': 'Hydra',
  '8afc085542c9679f': 'Gravity Hammer',
  '1488d0bb42c9679f': 'Energy Sword',
  'b6dbead842c9679f': 'Frag Grenade',
  'c1e1bab042c9679f': 'Plasma Grenade',
};

// Common weapon suffix bytes (last 4 of 8-byte ID)
const WEAPON_SUFFIX = '42c9679f';

/**
 * Read a nibble-shifted byte at a given byte position.
 * At 4-bit offset, byte at position i is: (data[i] << 4 | data[i+1] >> 4) & 0xFF
 */
function readShifted(data: Uint8Array, pos: number): number {
  if (pos + 1 >= data.length) return 0;
  return ((data[pos] << 4) | (data[pos + 1] >> 4)) & 0xff;
}

/**
 * Read N nibble-shifted bytes starting at a position, returning hex string.
 */
function readShiftedHex(data: Uint8Array, pos: number, count: number): string {
  let hex = '';
  for (let i = 0; i < count; i++) {
    hex += readShifted(data, pos + i).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Read a nibble-shifted uint16 (big-endian) at a given byte position.
 */
function readShiftedU16(data: Uint8Array, pos: number): number {
  const hi = readShifted(data, pos);
  const lo = readShifted(data, pos + 1);
  return (hi << 8) | lo;
}

/**
 * Determine which chunk a given absolute offset falls into.
 */
function getChunkIndex(offset: number, chunkOffsets: number[]): number {
  for (let i = chunkOffsets.length - 1; i >= 0; i--) {
    if (offset >= chunkOffsets[i]) return i;
  }
  return 0;
}

// Fire event lead pattern (nibble-shifted):
//   b0 = 0x0d (fixed lead byte)
//   b1 = 0x26 (player index 0 encoding)
//   b2 = varies by match type (0x00 in solo, 0x01 in PvE)
//   b3 = 0x40..0x43 (low 2 bits vary)

/**
 * Scan concatenated chunk data for weapon fire events.
 *
 * @param data - Concatenated Uint8Array of all chunks
 * @param chunkOffsets - Starting byte offset of each chunk
 * @returns Fire scan results with events and weapon counts
 */
export function scanFireEvents(data: Uint8Array, chunkOffsets: number[]): FireScanResult {
  const events: FireEvent[] = [];
  const weaponCounts = new Map<string, number>();

  // Scan for nibble-shifted fire events: b0=0x0d, b1=0x26, b2=any, b3=0x4X (top 6 bits).
  // Downstream validation (slot, counter, weapon suffix) prevents false positives.

  const len = data.length - 20; // need enough room for full event
  for (let i = 0; i < len; i++) {
    // Quick check: does readShifted at i match 0x0d?
    const b0 = ((data[i] << 4) | (data[i + 1] >> 4)) & 0xff;
    if (b0 !== 0x0d) continue;

    // Check second byte (player index encoding)
    const b1 = ((data[i + 1] << 4) | (data[i + 2] >> 4)) & 0xff;
    if (b1 !== 0x26) continue;

    // b2 varies by match type (0x00 solo, 0x01 PvE, etc.) — skip strict check

    // b3: top 6 bits must be 0x40 (low 2 bits vary)
    const b3 = ((data[i + 3] << 4) | (data[i + 4] >> 4)) & 0xff;
    if ((b3 & 0xfc) !== 0x40) continue;

    // Lead pattern matched at offset i. Now read fields:
    // Positions relative to i: lead(4) + counter(1) + slot(1) + weaponId(8) + octant(1) + u16(2)
    if (i + 17 >= data.length) continue;

    const counter = readShifted(data, i + 4);
    const slot = readShifted(data, i + 5);

    // Validate slot: must be 1 (primary) or 3 (secondary)
    if (slot !== 0x01 && slot !== 0x03) continue;

    // Validate counter: must be divisible by 4
    if (counter % 4 !== 0) continue;

    // Read 8-byte weapon ID
    const weaponId = readShiftedHex(data, i + 6, 8);

    // Validate weapon suffix (last 4 bytes = 42c9679f)
    if (!weaponId.endsWith(WEAPON_SUFFIX)) continue;

    // Read aim data
    const octantByte = readShifted(data, i + 14);
    const aimUint16 = readShiftedU16(data, i + 15);

    const weaponName = WEAPON_IDS[weaponId] || 'Unknown';
    const aimDirection = decodeOctahedralAim(octantByte, aimUint16);

    events.push({
      offset: i,
      chunkIndex: getChunkIndex(i, chunkOffsets),
      counter,
      slot,
      weaponId,
      weaponName,
      octantByte,
      aimUint16,
      aimDirection,
    });

    weaponCounts.set(weaponName, (weaponCounts.get(weaponName) || 0) + 1);
  }

  return { events, weaponCounts };
}
