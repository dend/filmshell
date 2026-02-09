/**
 * Bond Compact Binary v2 Parser
 * Ported from unpack-mvar.cjs
 */

import { inflateRawSync, inflateSync } from 'node:zlib';
import type { BondDocument, BondStruct, BondList, BondMap } from './types.js';

const BondType = {
  stop: 0,
  stop_base: 1,
  bool: 2,
  uint8: 3,
  uint16: 4,
  uint32: 5,
  uint64: 6,
  float: 7,
  double: 8,
  string: 9,
  struct: 10,
  list: 11,
  set: 12,
  map: 13,
  int8: 14,
  int16: 15,
  int32: 16,
  int64: 17,
  wstring: 18,
} as const;

const TypeName: Record<number, string> = Object.fromEntries(
  Object.entries(BondType).map(([k, v]) => [v, k])
);

class Reader {
  private buf: Buffer;
  private pos: number;

  constructor(buffer: Buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  getPos(): number {
    return this.pos;
  }

  setPos(pos: number): void {
    this.pos = pos;
  }

  u8(): number {
    return this.buf[this.pos++];
  }

  i8(): number {
    const v = this.buf.readInt8(this.pos);
    this.pos++;
    return v;
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i32be(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  leb128u(): number {
    let result = 0n;
    let shift = 0n;
    while (!this.eof) {
      const byte = BigInt(this.u8());
      result |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) break;
      shift += 7n;
    }
    return Number(result);
  }

  leb128(): number {
    const u = BigInt(this.leb128u());
    return Number((u >> 1n) ^ -(u & 1n));
  }
}

export class BondUnpacker {
  private reader: Reader;
  private blobs: Array<{ index: number; length: number; data: string }>;

  constructor(buffer: Buffer) {
    this.reader = new Reader(buffer);
    this.blobs = [];
  }

  unpack(): BondDocument {
    // Read outer length prefix
    const outerLen = this.reader.leb128u();
    const contentStart = this.reader.getPos();

    // Read main struct
    const mainStruct = this.readStruct(outerLen);

    // Check for remaining data (could be compressed blob)
    const bytesRead = this.reader.getPos() - contentStart;
    let compressedData: BondDocument['_compressedData'] = undefined;

    if (bytesRead < outerLen && this.reader.remaining() > 0) {
      // Check for padding (zeros)
      const remaining = this.reader.remaining();
      let allZeros = true;
      const savedPos = this.reader.getPos();

      for (let i = 0; i < Math.min(remaining, 100); i++) {
        if (this.reader.u8() !== 0) {
          allZeros = false;
          break;
        }
      }

      if (!allZeros) {
        this.reader.setPos(savedPos);
        const blob = this.readCompressedBlob();
        if (blob) {
          compressedData = blob;
        }
      }
    }

    const result: BondDocument = {
      _format: 'Bond Compact Binary v2',
      _fileSize: this.reader.remaining() + this.reader.getPos(),
      _outerLength: outerLen,
      content: mainStruct,
      blobs: this.blobs,
    };

    if (compressedData) {
      result._compressedData = compressedData;
    }

    return result;
  }

  private readStruct(maxLen: number = Infinity): BondStruct {
    const startPos = this.reader.getPos();
    const fields: Record<string, { type: string; value: unknown }> = {};
    let hasBaseClass = false;

    while (!this.reader.eof && (this.reader.getPos() - startPos) < maxLen) {
      const b = this.reader.u8();
      const type = b & 0x1f;
      let fieldId = b >> 5;

      if (type === BondType.stop) break;
      if (type === BondType.stop_base) {
        hasBaseClass = true;
        continue;
      }

      // Extended field ID (absolute, not delta)
      if (fieldId === 6) fieldId = this.reader.u8();
      else if (fieldId === 7) fieldId = this.reader.u16();

      const value = this.readValue(type);

      const key = `field_${fieldId}`;
      fields[key] = { type: TypeName[type] || `type_${type}`, value };
    }

    const result: BondStruct = { fields };
    if (hasBaseClass) {
      result._hasBaseClass = true;
    }
    return result;
  }

  private readValue(type: number): unknown {
    switch (type) {
      case BondType.bool:
        return this.reader.u8() !== 0;
      case BondType.uint8:
        return this.reader.u8();
      case BondType.int8:
        return this.reader.i8();
      case BondType.uint16:
      case BondType.uint32:
      case BondType.uint64:
        return this.reader.leb128u();
      case BondType.int16:
      case BondType.int32:
      case BondType.int64:
        return this.reader.leb128();
      case BondType.float:
        return this.reader.f32();
      case BondType.double:
        return this.reader.f64();
      case BondType.string: {
        const len = this.reader.leb128u();
        if (len === 0) return '';
        return this.reader.bytes(len).toString('utf8');
      }
      case BondType.wstring: {
        const len = this.reader.leb128u();
        if (len === 0) return '';
        return this.reader.bytes(len * 2).toString('utf16le');
      }
      case BondType.struct: {
        const len = this.reader.leb128u();
        const endPos = this.reader.getPos() + len;
        const result = this.readStruct(len);
        this.reader.setPos(endPos); // Ensure correct position
        return result;
      }
      case BondType.list:
      case BondType.set:
        return this.readList(type === BondType.set);
      case BondType.map:
        return this.readMap();
      default:
        return { _unknownType: type };
    }
  }

  private readList(isSet: boolean): BondList {
    const tc = this.reader.u8();
    const elemType = tc & 0x1f;
    let count = tc >> 5;
    // V2: count==0 means read leb128u, otherwise count-1
    if (count === 0) count = this.reader.leb128u();
    else count -= 1;

    const typeName = TypeName[elemType] || `type_${elemType}`;

    // Byte arrays - store as blob
    if (elemType === BondType.uint8 || elemType === BondType.int8) {
      const bytes = this.reader.bytes(count);

      // Check if it's printable text
      const isText = count > 0 && count < 1000 &&
        [...bytes].every(b => (b >= 32 && b < 127) || b === 10 || b === 13 || b === 9 || b === 0);

      if (isText) {
        return {
          _type: isSet ? 'set' : 'list',
          _elemType: typeName,
          _count: count,
          data: bytes.toString('utf8').replace(/\0/g, ''),
        };
      }

      // Store as blob reference
      const blobIndex = this.blobs.length;
      this.blobs.push({
        index: blobIndex,
        length: count,
        data: bytes.toString('base64'),
      });

      return {
        _type: isSet ? 'set' : 'list',
        _elemType: typeName,
        _count: count,
        _blobRef: blobIndex,
      };
    }

    // Regular list
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) {
      items.push(this.readValue(elemType));
    }

    return {
      _type: isSet ? 'set' : 'list',
      _elemType: typeName,
      _count: count,
      items,
    };
  }

  private readMap(): BondMap {
    // V2: key type, value type, then count as leb128u
    const keyType = this.reader.u8() & 0x1f;
    const valType = this.reader.u8() & 0x1f;
    const count = this.reader.leb128u();

    const entries: Array<{ key: unknown; value: unknown }> = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        key: this.readValue(keyType),
        value: this.readValue(valType),
      });
    }

    return {
      _type: 'map',
      _keyType: TypeName[keyType] || `type_${keyType}`,
      _valType: TypeName[valType] || `type_${valType}`,
      _count: count,
      entries,
    };
  }

  private readCompressedBlob(): BondDocument['_compressedData'] | null {
    try {
      // Read big-endian size
      const size = this.reader.i32be();

      if (size <= 0 || size > this.reader.remaining()) {
        return null;
      }

      const compressedData = this.reader.bytes(size);

      // Try deflate decompression
      try {
        const decompressed = inflateRawSync(compressedData);
        const innerUnpacker = new BondUnpacker(decompressed);
        const innerData = innerUnpacker.unpack();

        return {
          _compression: 'deflate',
          _compressedSize: size,
          _decompressedSize: decompressed.length,
          data: innerData,
        };
      } catch {
        // Try with zlib header
        try {
          const decompressed = inflateSync(compressedData);
          const innerUnpacker = new BondUnpacker(decompressed);
          return {
            _compression: 'zlib',
            _compressedSize: size,
            _decompressedSize: decompressed.length,
            data: innerUnpacker.unpack(),
          };
        } catch {
          return null;
        }
      }
    } catch {
      return null;
    }
  }
}

export function parseBond(buffer: Buffer): BondDocument {
  const unpacker = new BondUnpacker(buffer);
  return unpacker.unpack();
}
