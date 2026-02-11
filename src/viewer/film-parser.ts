/**
 * Browser-compatible film frame scanner.
 * Operates on Uint8Array — no Node.js Buffer dependency.
 */

export interface ParsedFrame {
  index: number;
  offset: number;
  chunkIndex: number;
  tick: number;
  byte5: number;
  byte6: number;
  byte7: number;
  byte8: number;
  playerIndex: number;
  baseType: number;
  formatByte: number;
  dataBytes: number[];
  frameTypeHex: string;
  subtypeHex: string;
  isPositionFrame: boolean;
  hasPlayer: boolean;
  coord1?: number;
  coord2?: number;
}

/** Field type for color-mapping individual bytes. */
export const enum FieldType {
  None = 0,
  Marker = 1,
  Tick = 2,
  FrameType = 3,
  FormatByte = 4,
  DataPos = 5,
  DataState = 6,
  DataExt = 7,
}

/**
 * Find all A0 7B 42 marker positions in the data.
 */
function findMarkers(data: Uint8Array): number[] {
  const positions: number[] = [];
  const len = data.length - 2;
  for (let i = 0; i < len; i++) {
    if (data[i] === 0xa0 && data[i + 1] === 0x7b && data[i + 2] === 0x42) {
      positions.push(i);
    }
  }
  return positions;
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, '0');
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

/**
 * Parse all frames from concatenated film data.
 * @param data - Concatenated Uint8Array of all chunks
 * @param chunkOffsets - Starting byte offset of each chunk in the concatenated buffer
 * @returns Array of parsed frames
 */
export function parseFrames(data: Uint8Array, chunkOffsets: number[]): ParsedFrame[] {
  const markers = findMarkers(data);
  const frames: ParsedFrame[] = [];

  for (let idx = 0; idx < markers.length; idx++) {
    const pos = markers[idx];
    if (pos + 20 > data.length) continue;

    const tick = (data[pos + 3] << 8) | data[pos + 4];
    const byte5 = data[pos + 5];
    const byte6 = data[pos + 6];
    const byte7 = data[pos + 7];
    const byte8 = data[pos + 8];
    const formatByte = data[pos + 9];

    const playerIndex = (byte6 >> 5) & 0x07;
    const baseType = byte6 & 0x1f;

    const dataBytes: number[] = [];
    for (let d = 0; d < 10; d++) {
      dataBytes.push(pos + 10 + d < data.length ? data[pos + 10 + d] : 0);
    }

    const frameTypeHex = toHex2(byte5) + toHex2(byte6) + toHex2(byte7) + toHex2(byte8);
    const subtypeHex = toHex2(byte7) + toHex2(byte8);

    const d0HiNib = dataBytes[0] >> 4;
    const isPositionFrame = byte5 === 0x40 && baseType === 0x09 && d0HiNib === 4;
    const hasPlayer = byte5 === 0x40 && (baseType === 0x09 || baseType === 0x08);

    let coord1: number | undefined;
    let coord2: number | undefined;
    if (isPositionFrame) {
      coord1 = dataBytes[0] * 256 + dataBytes[1];
      coord2 = ((dataBytes[2] & 0x0f) << 8) | dataBytes[3];
    }

    frames.push({
      index: frames.length,
      offset: pos,
      chunkIndex: getChunkIndex(pos, chunkOffsets),
      tick,
      byte5,
      byte6,
      byte7,
      byte8,
      playerIndex,
      baseType,
      formatByte,
      dataBytes,
      frameTypeHex,
      subtypeHex,
      isPositionFrame,
      hasPlayer,
      coord1,
      coord2,
    });
  }

  return frames;
}

/**
 * Build a byte→FieldType map for the entire data buffer.
 * Used by the hex view for color coding.
 */
export function buildFieldMap(data: Uint8Array, frames: ParsedFrame[]): Uint8Array {
  const map = new Uint8Array(data.length); // all zeros = FieldType.None

  for (const frame of frames) {
    const pos = frame.offset;

    // Marker: 3 bytes
    if (pos + 2 < data.length) {
      map[pos] = FieldType.Marker;
      map[pos + 1] = FieldType.Marker;
      map[pos + 2] = FieldType.Marker;
    }

    // Tick: 2 bytes
    if (pos + 4 < data.length) {
      map[pos + 3] = FieldType.Tick;
      map[pos + 4] = FieldType.Tick;
    }

    // Frame type: 4 bytes
    if (pos + 8 < data.length) {
      map[pos + 5] = FieldType.FrameType;
      map[pos + 6] = FieldType.FrameType;
      map[pos + 7] = FieldType.FrameType;
      map[pos + 8] = FieldType.FrameType;
    }

    // Format byte
    if (pos + 9 < data.length) {
      map[pos + 9] = FieldType.FormatByte;
    }

    // Data bytes (d0-d9)
    const dataFieldType = frame.isPositionFrame ? FieldType.DataPos : FieldType.DataState;
    for (let d = 0; d < 4; d++) {
      if (pos + 10 + d < data.length) {
        map[pos + 10 + d] = dataFieldType;
      }
    }
    for (let d = 4; d < 10; d++) {
      if (pos + 10 + d < data.length) {
        map[pos + 10 + d] = FieldType.DataExt;
      }
    }
  }

  return map;
}

/**
 * Given a byte offset, find the frame it belongs to (or null).
 * Returns frame index in the frames array.
 */
export function frameAtOffset(offset: number, frames: ParsedFrame[]): number | null {
  // Binary search — frames are sorted by offset
  let lo = 0;
  let hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = frames[mid].offset;
    const end = start + 19; // marker(3) + tick(2) + type(4) + format(1) + data(10)
    if (offset < start) {
      hi = mid - 1;
    } else if (offset > end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return null;
}
