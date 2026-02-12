/**
 * 3D Aim Vector page — data loading, position–fire correlation, scene wiring.
 *
 * Loads film chunks and objects.json for a match, scans fire events,
 * correlates them to player world positions, and renders in Three.js.
 */

import { parseFrames, type ParsedFrame } from './film-parser.ts';
import { scanFireEvents, type FireEvent } from './fire-scanner.ts';
import { AimScene, type MapObject3D, type PathPoint, type AimRay } from './aim-scene.ts';

// ── Types ──

interface MapObject {
  name: string;
  position: { x: number; y: number; z: number };
}

interface FilmEntry {
  matchId: string;
  chunks: number;
  totalSize: number;
}

// ── Scaling constants (must match svg-generator.ts logic) ──

const DEFAULT_SCALE = 0.003;
const MAP_FILL_FACTOR = 0.85;
const ENCODING_RATIO = 65536 / 4096; // 16

// ── DOM ──

const metaEl = document.getElementById('aim-meta')!;
const statusEl = document.getElementById('aim-status-text')!;
const container = document.getElementById('scene-container')!;
const toggleObjects = document.getElementById('toggle-objects') as HTMLInputElement;
const togglePaths = document.getElementById('toggle-paths') as HTMLInputElement;
const rayLengthInput = document.getElementById('ray-length') as HTMLInputElement;
const rayLengthVal = document.getElementById('ray-length-val')!;
const weaponFilterEl = document.getElementById('weapon-filter') as HTMLSelectElement;
const eventCountEl = document.getElementById('event-count')!;

// ── Init ──

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const matchId = params.get('matchId');

  if (!matchId) {
    statusEl.textContent = 'No matchId in URL. Go back and select a film.';
    return;
  }

  metaEl.textContent = matchId;
  statusEl.textContent = 'Loading film list...';

  // Get film info
  const listRes = await fetch('/api/films');
  const films: FilmEntry[] = await listRes.json();
  const film = films.find(f => f.matchId === matchId);
  if (!film) {
    statusEl.textContent = `Film not found: ${matchId}`;
    return;
  }

  // Load chunks
  statusEl.textContent = `Loading ${film.chunks} chunks...`;
  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < film.chunks; i++) {
    const res = await fetch(`/api/films/${matchId}/filmChunk${i}_dec`);
    if (!res.ok) throw new Error(`Chunk ${i}: HTTP ${res.status}`);
    buffers.push(await res.arrayBuffer());
  }

  const totalSize = buffers.reduce((s, b) => s + b.byteLength, 0);
  const allData = new Uint8Array(totalSize);
  const chunkOffsets: number[] = [];
  let offset = 0;
  for (const buf of buffers) {
    chunkOffsets.push(offset);
    allData.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // Load objects
  statusEl.textContent = 'Loading map objects...';
  let objects: MapObject[] = [];
  try {
    const objRes = await fetch(`/api/films/${matchId}/objects.json`);
    if (objRes.ok) objects = await objRes.json();
  } catch { /* no objects */ }

  // Parse frames
  statusEl.textContent = 'Parsing frames...';
  const frames = parseFrames(allData, chunkOffsets);

  // Extract position frames for player 0
  const posFrames = frames.filter(f => f.isPositionFrame && f.playerIndex === 0);

  // Scan fire events
  statusEl.textContent = 'Scanning fire events...';
  const fireResult = scanFireEvents(allData, chunkOffsets);

  // Compute map bounds from objects
  const mapBounds = computeMapBounds(objects);

  // Compute world positions for position frames
  statusEl.textContent = 'Scaling positions...';
  const worldPositions = scalePositions(posFrames, mapBounds, objects);

  // Build offset→tick→worldPos lookup
  const offsetTickMap = posFrames.map((f, i) => ({
    offset: f.offset,
    tick: f.tick,
    worldX: worldPositions[i]?.x ?? 0,
    worldY: worldPositions[i]?.y ?? 0,
  }));

  // Correlate fire events to world positions
  const aimRays = correlateFireEvents(fireResult.events, offsetTickMap);

  // Populate weapon filter
  const weaponNames = [...fireResult.weaponCounts.keys()].sort();
  for (const name of weaponNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${fireResult.weaponCounts.get(name)})`;
    weaponFilterEl.appendChild(opt);
  }

  // Wait for layout to compute so container has real dimensions
  statusEl.textContent = 'Building 3D scene...';
  await new Promise(r => requestAnimationFrame(r));
  const scene = new AimScene(container);

  if (mapBounds) {
    scene.buildGround(mapBounds.minX, mapBounds.maxX, mapBounds.minY, mapBounds.maxY);
  }

  const mapObjects3D: MapObject3D[] = objects.map(o => ({
    name: o.name,
    position: o.position,
  }));
  scene.buildObjects(mapObjects3D);

  const pathPoints: PathPoint[] = worldPositions.map(p => ({ x: p.x, y: p.y }));
  scene.buildPath(pathPoints);

  scene.buildRays(aimRays);

  // Wire controls
  toggleObjects.addEventListener('change', () => {
    scene.setMapObjectsVisible(toggleObjects.checked);
  });

  togglePaths.addEventListener('change', () => {
    scene.setPathsVisible(togglePaths.checked);
  });

  rayLengthInput.addEventListener('input', () => {
    const val = parseInt(rayLengthInput.value, 10);
    rayLengthVal.textContent = String(val);
    scene.setRayLength(val);
    eventCountEl.textContent = `${scene.getVisibleRayCount()} rays`;
  });

  weaponFilterEl.addEventListener('change', () => {
    scene.filterByWeapon(weaponFilterEl.value);
    eventCountEl.textContent = `${scene.getVisibleRayCount()} rays`;
  });

  eventCountEl.textContent = `${aimRays.length} rays`;
  statusEl.textContent = `${posFrames.length} position frames | ${fireResult.events.length} fire events | ${objects.length} objects`;
}

// ── Map Bounds ──

interface MapBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  width: number; height: number;
  centerX: number; centerY: number;
}

function computeMapBounds(objects: MapObject[]): MapBounds | null {
  if (objects.length === 0) return null;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const obj of objects) {
    minX = Math.min(minX, obj.position.x);
    maxX = Math.max(maxX, obj.position.x);
    minY = Math.min(minY, obj.position.y);
    maxY = Math.max(maxY, obj.position.y);
  }

  // Add 20% buffer
  const w = maxX - minX;
  const h = maxY - minY;
  const bufX = w * 0.2;
  const bufY = h * 0.2;
  minX -= bufX; maxX += bufX;
  minY -= bufY; maxY += bufY;

  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

// ── Position Scaling ──
// Replicates svg-generator.ts logic for the viewer context.

interface WorldPos { x: number; y: number }

function scalePositions(
  posFrames: ParsedFrame[],
  mapBounds: MapBounds | null,
  objects: MapObject[]
): WorldPos[] {
  if (posFrames.length === 0) return [];

  // Build cumulative coordinates
  let cumC1 = 0, cumC2 = 0;
  let prevRaw1: number | null = null;
  let prevRaw2: number | null = null;
  let firstRaw1 = 0, firstRaw2 = 0;

  const points: { cumC1: number; cumC2: number }[] = [];

  for (const f of posFrames) {
    const raw1 = f.coord1!;
    const raw2 = f.coord2!;

    if (prevRaw1 === null) {
      firstRaw1 = raw1;
      firstRaw2 = raw2;
      prevRaw1 = raw1;
      prevRaw2 = raw2;
      points.push({ cumC1: 0, cumC2: 0 });
      continue;
    }

    // Coord1: 16-bit wraparound
    let delta1 = raw1 - prevRaw1;
    if (delta1 > 32768) delta1 -= 65536;
    if (delta1 < -32768) delta1 += 65536;
    cumC1 += delta1;

    // Coord2: 12-bit wraparound
    let delta2 = raw2 - prevRaw2!;
    if (delta2 > 2048) delta2 -= 4096;
    if (delta2 < -2048) delta2 += 4096;
    cumC2 += delta2;

    points.push({ cumC1, cumC2 });
    prevRaw1 = raw1;
    prevRaw2 = raw2;
  }

  // Compute raw extent
  let minRawX = Infinity, maxRawX = -Infinity;
  let minRawY = Infinity, maxRawY = -Infinity;
  for (const p of points) {
    minRawX = Math.min(minRawX, p.cumC2);
    maxRawX = Math.max(maxRawX, p.cumC2);
    minRawY = Math.min(minRawY, p.cumC1);
    maxRawY = Math.max(maxRawY, p.cumC1);
  }
  const rawExtentY = maxRawY - minRawY;
  const rawExtentX = maxRawX - minRawX;

  // Find spawn anchor
  let spawnAnchor: { x: number; y: number } | null = null;
  if (mapBounds) {
    const candidates = objects
      .filter(o => o.name.includes('Spawn Point [Initial]'))
      .map(o => ({ x: o.position.x, y: o.position.y }));
    spawnAnchor = findBestSpawnAnchor(points, mapBounds, candidates);
  }

  // Compute scale
  let scaleX = DEFAULT_SCALE;
  let scaleY = DEFAULT_SCALE;
  const encodingAspect = ENCODING_RATIO * (mapBounds?.width ?? 1) / (mapBounds?.height ?? 1);

  if (mapBounds && mapBounds.width > 0 && spawnAnchor && rawExtentY > 0) {
    const spaceYPos = mapBounds.maxY - spawnAnchor.y;
    const spaceYNeg = spawnAnchor.y - mapBounds.minY;
    const threshold = rawExtentY * 0.05;

    scaleY = Infinity;
    if (maxRawY > threshold) scaleY = Math.min(scaleY, spaceYPos / maxRawY);
    if (-minRawY > threshold) scaleY = Math.min(scaleY, spaceYNeg / (-minRawY));

    const spaceXNeg = spawnAnchor.x - mapBounds.minX;
    const spaceXPos = mapBounds.maxX - spawnAnchor.x;
    const thresholdX = rawExtentX * 0.05;

    if (maxRawX > thresholdX) scaleY = Math.min(scaleY, spaceXNeg * encodingAspect / maxRawX);
    if (-minRawX > thresholdX) scaleY = Math.min(scaleY, spaceXPos * encodingAspect / (-minRawX));

    if (!isFinite(scaleY)) scaleY = DEFAULT_SCALE;
    scaleX = scaleY / encodingAspect;
  } else if (mapBounds && mapBounds.width > 0 && rawExtentY > 0) {
    scaleY = mapBounds.height * MAP_FILL_FACTOR / rawExtentY;
    scaleX = scaleY / encodingAspect;
  }

  // Compute displacements
  const displacements = points.map(p => ({
    x: -p.cumC2 * scaleX,
    y: p.cumC1 * scaleY,
  }));

  // Compute offset
  let offsetX: number, offsetY: number;
  if (spawnAnchor) {
    offsetX = spawnAnchor.x - displacements[0].x;
    offsetY = spawnAnchor.y - displacements[0].y;
  } else if (mapBounds) {
    const pathCX = displacements.reduce((s, d) => s + d.x, 0) / displacements.length;
    const pathCY = displacements.reduce((s, d) => s + d.y, 0) / displacements.length;
    offsetX = mapBounds.centerX - pathCX;
    offsetY = mapBounds.centerY - pathCY;
  } else {
    offsetX = 0;
    offsetY = 0;
  }

  return displacements.map(d => ({
    x: d.x + offsetX,
    y: d.y + offsetY,
  }));
}

function findBestSpawnAnchor(
  points: { cumC1: number; cumC2: number }[],
  mapBounds: MapBounds,
  candidates: { x: number; y: number }[]
): { x: number; y: number } | null {
  if (points.length === 0 || candidates.length === 0) return null;

  let minRawY = Infinity, maxRawY = -Infinity;
  for (const p of points) {
    minRawY = Math.min(minRawY, p.cumC1);
    maxRawY = Math.max(maxRawY, p.cumC1);
  }
  const rawExtentY = maxRawY - minRawY;

  let scaleX = DEFAULT_SCALE;
  let scaleY = DEFAULT_SCALE;
  if (mapBounds.width > 0 && rawExtentY > 0) {
    scaleY = mapBounds.height * MAP_FILL_FACTOR / rawExtentY;
    scaleX = scaleY / (ENCODING_RATIO * mapBounds.width / mapBounds.height);
  }

  const displacements = points.map(p => ({
    x: -p.cumC2 * scaleX,
    y: p.cumC1 * scaleY,
  }));

  const firstX = displacements[0].x;
  const firstY = displacements[0].y;

  let best: { x: number; y: number } | null = null;
  let bestScore = -1;

  for (const cand of candidates) {
    const offX = cand.x - firstX;
    const offY = cand.y - firstY;
    let inside = 0;
    for (const d of displacements) {
      if (d.x + offX >= mapBounds.minX && d.x + offX <= mapBounds.maxX &&
          d.y + offY >= mapBounds.minY && d.y + offY <= mapBounds.maxY) {
        inside++;
      }
    }
    if (inside > bestScore) {
      bestScore = inside;
      best = cand;
    }
  }

  return best;
}

// ── Fire Event Correlation ──
// Use byte offset to interpolate tick, then map tick to world position.

interface OffsetTickWorld {
  offset: number;
  tick: number;
  worldX: number;
  worldY: number;
}

function correlateFireEvents(
  events: FireEvent[],
  offsetTickMap: OffsetTickWorld[]
): AimRay[] {
  if (offsetTickMap.length === 0) return [];

  const rays: AimRay[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // Binary search for surrounding position frames by byte offset
    let lo = 0, hi = offsetTickMap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsetTickMap[mid].offset < ev.offset) lo = mid + 1;
      else hi = mid;
    }

    // lo is now the first position frame at or after the event offset
    // Interpolate between lo-1 and lo
    let worldX: number, worldY: number;

    if (lo === 0) {
      worldX = offsetTickMap[0].worldX;
      worldY = offsetTickMap[0].worldY;
    } else if (lo >= offsetTickMap.length) {
      const last = offsetTickMap[offsetTickMap.length - 1];
      worldX = last.worldX;
      worldY = last.worldY;
    } else {
      const prev = offsetTickMap[lo - 1];
      const next = offsetTickMap[lo];
      const range = next.offset - prev.offset;
      if (range <= 0) {
        worldX = prev.worldX;
        worldY = prev.worldY;
      } else {
        const t = (ev.offset - prev.offset) / range;
        worldX = prev.worldX + t * (next.worldX - prev.worldX);
        worldY = prev.worldY + t * (next.worldY - prev.worldY);
      }
    }

    rays.push({
      origin: { x: worldX, y: worldY },
      direction: ev.aimDirection,
      weaponName: ev.weaponName,
      index: i,
    });
  }

  return rays;
}

// ── Bootstrap ──

main().catch(err => {
  statusEl.textContent = `Error: ${err}`;
  console.error(err);
});
