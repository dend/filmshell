/**
 * Shared types for FilmShell CLI
 */

// Authentication types (from src/index.ts)
export interface Config {
  clientId: string;
  redirectUri: string;
}

export interface StoredTokens {
  refreshToken: string;
  spartanToken: string;
  spartanTokenExpiry: number;
  xuid: string;
  xblToken?: string;
}

// Film structures
export interface FilmChunk {
  Index: number;
  FileRelativePath: string;
  ChunkSize: number;
  ChunkType: number;
}

export interface FilmCustomData {
  Chunks: FilmChunk[];
  MatchId: string;
  FilmLength: number;
  HasGameEnded: boolean;
}

export interface FilmResponse {
  BlobStoragePathPrefix: string;
  CustomData: FilmCustomData;
  AssetId: string;
  FilmStatusBond: number;
}

export interface DownloadedFilm {
  matchId: string;
  matchEndTimePT: string;
  filmDir: string;
  matchStats: unknown;
  filmLengthMs: number;
  mapName?: string;
  gameMode?: string;
  matchDuration?: string;
}

// Map metadata types
export interface MapAssetFile {
  prefix: string;
  fileRelativePaths: string[];
}

export interface MapAssetResponse {
  AssetId: string;
  VersionId: string;
  Name: string;
  Description: string;
  Files: MapAssetFile;
}

// Map objects and bounds
export interface MapObject {
  index: number;
  objectId: number;
  name: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  forward?: {
    x: number;
    y: number;
  };
  heading?: number;
  category?: number;
}

export interface MapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  width: number;
  height: number;
  depth: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

// Motion extraction types
export interface MotionPoint {
  frame: number;
  cumCoord1: number;
  cumCoord2: number;
  raw1: number;
  raw2: number;
}

export interface WorldPosition {
  x: number;
  y: number;
  frame: number;
}

// Bond parser types
export interface BondField {
  type: string;
  value: unknown;
}

export interface BondStruct {
  fields: Record<string, BondField>;
  _hasBaseClass?: boolean;
}

export interface BondList {
  _type: 'list' | 'set';
  _elemType: string;
  _count: number;
  items?: unknown[];
  _blobRef?: number;
  data?: string;
}

export interface BondMap {
  _type: 'map';
  _keyType: string;
  _valType: string;
  _count: number;
  entries: Array<{ key: unknown; value: unknown }>;
}

export interface BondDocument {
  _format: string;
  _fileSize: number;
  _outerLength: number;
  content: BondStruct;
  blobs: Array<{
    index: number;
    length: number;
    data: string;
  }>;
  _compressedData?: {
    _compression: string;
    _compressedSize: number;
    _decompressedSize: number;
    data: BondDocument;
  };
}

// Multi-player motion data
export interface PlayerPath {
  playerIndex: number;
  positions: MotionPoint[];
}

// Object ID mapping
export interface ObjectIdEntry {
  name: string;
  id: number;
}
