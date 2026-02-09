/**
 * SVG generation with map context
 * Generates path visualizations overlaid on map bounds
 */

import type { MotionPoint, MapBounds, MapObject, WorldPosition, PlayerPath } from './types.js';

// Default scale factor when map bounds aren't available
// This is a fallback - prefer using auto-calibration from map bounds
const DEFAULT_SCALE = 0.003;

// When auto-calibrating, target this percentage of map extent
// 0.9 = path should fill ~90% of map (accounting for walls/margins)
const MAP_FILL_FACTOR = 0.85;

/**
 * Convert raw motion points to world coordinates using auto-calibrated scale.
 *
 * Motion encoding:
 * - cumCoord1 → Y axis
 * - cumCoord2 → X axis
 *
 * Scale is automatically calculated based on map bounds when available,
 * so the path fills approximately MAP_FILL_FACTOR of the map extent.
 *
 * @param positions - Raw motion points with cumulative deltas
 * @param mapBounds - Map bounds for auto-calibration and centering
 * @param spawnAnchor - Spawn position to anchor the path start (optional)
 */
export function scaleMotionToWorld(
  positions: MotionPoint[],
  mapBounds: MapBounds | null,
  spawnAnchor?: { x: number; y: number } | null
): WorldPosition[] {
  if (positions.length === 0) return [];

  // First, compute raw path extent
  let minRawX = Infinity, maxRawX = -Infinity;
  let minRawY = Infinity, maxRawY = -Infinity;
  for (const p of positions) {
    minRawX = Math.min(minRawX, p.cumCoord2);
    maxRawX = Math.max(maxRawX, p.cumCoord2);
    minRawY = Math.min(minRawY, p.cumCoord1);
    maxRawY = Math.max(maxRawY, p.cumCoord1);
  }
  const rawExtentX = maxRawX - minRawX;
  const rawExtentY = maxRawY - minRawY;

  // Calculate scale factors based on map bounds
  let scaleX = DEFAULT_SCALE;
  let scaleY = DEFAULT_SCALE;

  if (mapBounds && mapBounds.width > 0 && rawExtentX > 0 && rawExtentY > 0) {
    // Auto-calibrate: scale path to fill MAP_FILL_FACTOR of map
    const targetWidth = mapBounds.width * MAP_FILL_FACTOR;
    const targetHeight = mapBounds.height * MAP_FILL_FACTOR;

    scaleX = targetWidth / rawExtentX;
    scaleY = targetHeight / rawExtentY;
  }

  // Convert raw coords to world coords with axis-specific scales
  // Apply 180° rotation (negate both axes)
  const displacements = positions.map(p => ({
    x: -p.cumCoord2 * scaleX,
    y: p.cumCoord1 * scaleY,
    frame: p.frame,
  }));

  // Compute path bounds after scaling
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const d of displacements) {
    minX = Math.min(minX, d.x);
    maxX = Math.max(maxX, d.x);
    minY = Math.min(minY, d.y);
    maxY = Math.max(maxY, d.y);
  }
  const pathCenterX = (minX + maxX) / 2;
  const pathCenterY = (minY + maxY) / 2;

  let offsetX: number;
  let offsetY: number;

  if (spawnAnchor) {
    // Anchor first frame to spawn position
    // Offset = spawn position - first frame position
    const firstX = displacements[0].x;
    const firstY = displacements[0].y;
    offsetX = spawnAnchor.x - firstX;
    offsetY = spawnAnchor.y - firstY;
  } else if (mapBounds && mapBounds.width > 0) {
    // Center path on map
    offsetX = mapBounds.centerX - pathCenterX;
    offsetY = mapBounds.centerY - pathCenterY;
  } else {
    // No map bounds - center at origin
    offsetX = -pathCenterX;
    offsetY = -pathCenterY;
  }

  // Apply offset to get final world positions
  return displacements.map(d => ({
    x: d.x + offsetX,
    y: d.y + offsetY,
    frame: d.frame,
  }));
}

/**
 * Scale multiple players' motion to world coordinates using a UNIFIED scale.
 *
 * CumCoord values start at 0 for each player, but players start at different
 * physical positions on the map. To put all players in the same coordinate frame,
 * we add each player's first-frame raw values (raw1/raw2) as a baseline offset.
 * This gives absolute physical coordinates: physCoord = rawFirstFrame + cumCoord.
 *
 * The combined physical extent determines a single scale factor, and a single
 * offset centers the combined paths on the map.
 *
 * @param allPlayerPositions - Array of raw motion points per player
 * @param mapBounds - Map bounds for auto-calibration and centering
 * @param spawnAnchor - Spawn position to anchor the first player's start (optional)
 * @returns Array of WorldPosition[] arrays, one per player (same order as input)
 */
export function scaleAllPlayersToWorld(
  allPlayerPositions: MotionPoint[][],
  mapBounds: MapBounds | null,
  spawnAnchor?: { x: number; y: number } | null
): WorldPosition[][] {
  if (allPlayerPositions.length === 0) return [];

  // First-frame raw values serve as each player's absolute position baseline.
  // Physical position = baseline + cumCoord, putting all players in one frame.
  const baselines = allPlayerPositions.map(positions => {
    if (positions.length === 0) return { raw1: 0, raw2: 0 };
    return { raw1: positions[0].raw1, raw2: positions[0].raw2 };
  });

  // Compute combined PHYSICAL extent across all players
  // physC2 (cumCoord2 axis) → X, physC1 (cumCoord1 axis) → Y
  let minPhysC2 = Infinity, maxPhysC2 = -Infinity;
  let minPhysC1 = Infinity, maxPhysC1 = -Infinity;
  for (let i = 0; i < allPlayerPositions.length; i++) {
    const { raw1, raw2 } = baselines[i];
    for (const p of allPlayerPositions[i]) {
      const physC2 = raw2 + p.cumCoord2;
      const physC1 = raw1 + p.cumCoord1;
      minPhysC2 = Math.min(minPhysC2, physC2);
      maxPhysC2 = Math.max(maxPhysC2, physC2);
      minPhysC1 = Math.min(minPhysC1, physC1);
      maxPhysC1 = Math.max(maxPhysC1, physC1);
    }
  }
  const physExtentX = maxPhysC2 - minPhysC2;
  const physExtentY = maxPhysC1 - minPhysC1;

  // Unified scale factors from physical extent
  let scaleX = DEFAULT_SCALE;
  let scaleY = DEFAULT_SCALE;
  if (mapBounds && mapBounds.width > 0 && physExtentX > 0 && physExtentY > 0) {
    scaleX = (mapBounds.width * MAP_FILL_FACTOR) / physExtentX;
    scaleY = (mapBounds.height * MAP_FILL_FACTOR) / physExtentY;
  }

  // Combined center in world coords (for centering on map)
  const combinedCenterX = -(minPhysC2 + maxPhysC2) / 2 * scaleX;
  const combinedCenterY = (minPhysC1 + maxPhysC1) / 2 * scaleY;

  // Compute a single offset (same for all players since physical coords are absolute)
  let offsetX: number;
  let offsetY: number;

  if (spawnAnchor) {
    // Anchor player 0's first frame to spawn position
    // cumCoord is 0 at first frame, so physical pos = baseline
    const b0 = baselines[0];
    offsetX = spawnAnchor.x - (-b0.raw2 * scaleX);
    offsetY = spawnAnchor.y - (b0.raw1 * scaleY);
  } else if (mapBounds && mapBounds.width > 0) {
    offsetX = mapBounds.centerX - combinedCenterX;
    offsetY = mapBounds.centerY - combinedCenterY;
  } else {
    offsetX = -combinedCenterX;
    offsetY = -combinedCenterY;
  }

  // Apply to each player using absolute physical coordinates
  return allPlayerPositions.map((positions, playerIdx) => {
    if (positions.length === 0) return [];
    const { raw1, raw2 } = baselines[playerIdx];
    return positions.map(p => ({
      x: -(raw2 + p.cumCoord2) * scaleX + offsetX,
      y: (raw1 + p.cumCoord1) * scaleY + offsetY,
      frame: p.frame,
    }));
  });
}

/**
 * Generate SVG visualization of the motion path with map context
 * @param wuLabel - Optional label for diagnostic WU assumption (e.g., "100 WU")
 */
export function generateSvg(
  worldPositions: WorldPosition[],
  mapBounds: MapBounds | null,
  objects: MapObject[],
  matchId: string,
  wuLabel?: string
): string {
  if (worldPositions.length < 2) {
    return createEmptySvg(matchId, 'Not enough position data');
  }

  // Calculate view bounds - include both map bounds AND path positions
  let viewMinX = Infinity, viewMaxX = -Infinity;
  let viewMinY = Infinity, viewMaxY = -Infinity;

  // Include path positions
  for (const p of worldPositions) {
    viewMinX = Math.min(viewMinX, p.x);
    viewMaxX = Math.max(viewMaxX, p.x);
    viewMinY = Math.min(viewMinY, p.y);
    viewMaxY = Math.max(viewMaxY, p.y);
  }

  // Also include map bounds if available
  // Map bounds are already rotated 90° CCW in object-extractor, use directly
  if (mapBounds && mapBounds.width > 0) {
    viewMinX = Math.min(viewMinX, mapBounds.minX);
    viewMaxX = Math.max(viewMaxX, mapBounds.maxX);
    viewMinY = Math.min(viewMinY, mapBounds.minY);
    viewMaxY = Math.max(viewMaxY, mapBounds.maxY);
  }

  // Add padding
  const rangeX = viewMaxX - viewMinX;
  const rangeY = viewMaxY - viewMinY;
  const padding = Math.max(rangeX, rangeY) * 0.1;
  viewMinX -= padding;
  viewMaxX += padding;
  viewMinY -= padding;
  viewMaxY += padding;

  const svgWidth = 800;
  const svgHeight = 800;
  const worldWidth = viewMaxX - viewMinX;
  const worldHeight = viewMaxY - viewMinY;
  const scale = Math.min(svgWidth / worldWidth, svgHeight / worldHeight);

  // Transform functions
  const svgX = (x: number) => (x - viewMinX) * scale;
  const svgY = (y: number) => svgHeight - (y - viewMinY) * scale;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">\n`;

  // Background
  svg += `  <rect width="100%" height="100%" fill="#0d1117"/>\n`;

  // Title
  const titleSuffix = wuLabel ? ` [${wuLabel}]` : '';
  svg += `  <text x="${svgWidth / 2}" y="30" text-anchor="middle" font-size="18" font-family="sans-serif" fill="white">Film: ${matchId}${titleSuffix}</text>\n`;

  // Grid
  svg += `  <g stroke="#21262d" stroke-width="0.5">\n`;
  const gridStep = Math.pow(10, Math.floor(Math.log10(Math.max(worldWidth, worldHeight) / 10)));
  for (let gx = Math.floor(viewMinX / gridStep) * gridStep; gx <= viewMaxX; gx += gridStep) {
    svg += `    <line x1="${svgX(gx)}" y1="0" x2="${svgX(gx)}" y2="${svgHeight}"/>\n`;
  }
  for (let gy = Math.floor(viewMinY / gridStep) * gridStep; gy <= viewMaxY; gy += gridStep) {
    svg += `    <line x1="0" y1="${svgY(gy)}" x2="${svgWidth}" y2="${svgY(gy)}"/>\n`;
  }
  svg += `  </g>\n`;

  // Map bounds rectangle (if available)
  // Map bounds are already rotated 90° CCW in object-extractor, use directly
  if (mapBounds && mapBounds.width > 0) {
    svg += `  <rect x="${svgX(mapBounds.minX)}" y="${svgY(mapBounds.maxY)}" `;
    svg += `width="${mapBounds.width * scale}" height="${mapBounds.height * scale}" `;
    svg += `fill="none" stroke="#30363d" stroke-width="2" stroke-dasharray="10,5"/>\n`;
  }

  // Draw objects (spawn points, zones, etc.)
  // Objects are already rotated 90° CCW in object-extractor, use directly
  if (objects.length > 0) {
    // First pass: draw all circles
    svg += `  <g>\n`;
    const labelData: Array<{x: number; y: number; label: string; color: string; radius: number; index: number}> = [];

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      // Use object positions directly (already in correct coordinate system)
      const x = svgX(obj.position.x);
      const y = svgY(obj.position.y);

      // Skip if outside view
      if (x < 0 || x > svgWidth || y < 0 || y > svgHeight) continue;

      let color = '#666';
      let radius = 4;
      let label = '';

      if (obj.name.includes('Spawn Point [Initial]')) {
        color = '#00ff00';
        radius = 6;
        label = 'Initial Spawn';
      } else if (obj.name.includes('Spawn Point [Respawn]')) {
        // Skip respawns
        continue;
      } else if (obj.name.includes('Flag') && obj.name.includes('Delivery')) {
        color = '#ffff00';
        radius = 6;
        label = 'Flag Delivery';
      } else if (obj.name.includes('Flag') && obj.name.includes('Spawn')) {
        color = '#ffaa00';
        radius = 5;
        label = 'Flag Spawn';
      } else if (obj.name.includes('Flag')) {
        color = '#ffcc00';
        radius = 5;
        label = 'Flag';
      } else if (obj.name.includes('Zone') || obj.name.includes('Capture')) {
        // Skip capture zones
        continue;
      } else if (obj.name.includes('Ball')) {
        // Skip ball stands
        continue;
      } else if (obj.name.includes('Weapon') || obj.name.includes('Gun') || obj.name.includes('Rifle') ||
                 obj.name.includes('Pistol') || obj.name.includes('Shotgun') || obj.name.includes('Sniper') ||
                 obj.name.includes('Rocket') || obj.name.includes('Sword') || obj.name.includes('Hammer') ||
                 obj.name.includes('Needler') || obj.name.includes('Plasma') || obj.name.includes('BR') ||
                 obj.name.includes('DMR') || obj.name.includes('Commando') || obj.name.includes('Sidekick') ||
                 obj.name.includes('Mangler') || obj.name.includes('Bulldog') || obj.name.includes('Heatwave') ||
                 obj.name.includes('Shock') || obj.name.includes('Stalker') || obj.name.includes('Skewer') ||
                 obj.name.includes('Cindershot') || obj.name.includes('Ravager') || obj.name.includes('Hydra') ||
                 obj.name.includes('Sentinel') || obj.name.includes('Disruptor')) {
        color = '#ff6666';
        radius = 5;
        label = obj.name;
      } else if (obj.name.includes('Equipment') || obj.name.includes('Grenade') || obj.name.includes('Overshield') ||
                 obj.name.includes('Camo') || obj.name.includes('Grapple') || obj.name.includes('Thruster') ||
                 obj.name.includes('Repulsor') || obj.name.includes('Drop Wall') || obj.name.includes('Threat Sensor')) {
        color = '#cc66ff';
        radius = 5;
        label = obj.name;
      } else {
        // Skip unknown objects
        continue;
      }

      svg += `    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="${color}" opacity="0.7"/>\n`;

      if (label) {
        labelData.push({ x, y, label, color, radius, index: i });
      }
    }
    svg += `  </g>\n`;

    // Second pass: draw labels with pointer lines and backgrounds
    if (labelData.length > 0) {
      svg += `  <g font-family="sans-serif" font-size="7">\n`;
      const labelOffset = 18; // Distance from dot to label

      for (const { x, y, label, color, radius, index } of labelData) {
        // Alternate position: 0=right, 1=below, 2=left, 3=above
        const pos = index % 4;
        const textWidth = label.length * 4.2 + 4;
        let tx: number, ty: number, lx: number, ly: number;

        if (pos === 0) {
          tx = x + labelOffset; ty = y + 2;
          lx = x + radius; ly = y;
        } else if (pos === 1) {
          tx = x - textWidth / 2; ty = y + labelOffset + 2;
          lx = x; ly = y + radius;
        } else if (pos === 2) {
          tx = x - labelOffset - textWidth; ty = y + 2;
          lx = x - radius; ly = y;
        } else {
          tx = x - textWidth / 2; ty = y - labelOffset;
          lx = x; ly = y - radius;
        }

        // Pointer line
        const lineEndX = pos === 0 ? tx - 2 : pos === 2 ? tx + textWidth + 2 : tx + textWidth / 2;
        const lineEndY = pos === 1 ? ty - 8 : pos === 3 ? ty + 2 : ty - 3;
        svg += `    <line x1="${lx.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${lineEndX.toFixed(1)}" y2="${lineEndY.toFixed(1)}" stroke="${color}" stroke-width="0.5" opacity="0.6"/>\n`;

        // Background rect for readability
        svg += `    <rect x="${(tx - 2).toFixed(1)}" y="${(ty - 7).toFixed(1)}" width="${textWidth}" height="10" fill="#0d1117" opacity="0.85" rx="2"/>\n`;
        svg += `    <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="${color}">${label}</text>\n`;
      }
      svg += `  </g>\n`;
    }
  }

  // Draw motion path as raw dots (no lines)
  const totalFrames = worldPositions.length;

  for (let i = 0; i < totalFrames; i++) {
    const p = worldPositions[i];
    const t = i / totalFrames;
    const r = Math.round(t * 255);
    const g = Math.round((1 - t) * 255);

    svg += `  <circle cx="${svgX(p.x).toFixed(1)}" cy="${svgY(p.y).toFixed(1)}" r="1.5" fill="rgb(${r}, ${g}, 100)" opacity="0.7"/>\n`;
  }

  // Start marker
  const startPos = worldPositions[0];
  svg += `  <circle cx="${svgX(startPos.x)}" cy="${svgY(startPos.y)}" r="8" fill="#00ff00" stroke="white" stroke-width="2"/>\n`;
  svg += `  <text x="${svgX(startPos.x) + 12}" y="${svgY(startPos.y) + 4}" font-size="12" fill="#00ff00" font-family="sans-serif">Start</text>\n`;

  // End marker
  const endPos = worldPositions[worldPositions.length - 1];
  svg += `  <circle cx="${svgX(endPos.x)}" cy="${svgY(endPos.y)}" r="6" fill="#ff4444" stroke="white" stroke-width="2"/>\n`;
  svg += `  <text x="${svgX(endPos.x) + 10}" y="${svgY(endPos.y) + 4}" font-size="12" fill="#ff4444" font-family="sans-serif">End</text>\n`;

  // Stats overlay
  const distance = Math.sqrt(
    Math.pow(endPos.x - startPos.x, 2) + Math.pow(endPos.y - startPos.y, 2)
  );

  svg += `  <text x="20" y="${svgHeight - 65}" font-size="11" fill="#8b949e" font-family="sans-serif">Frames: ${totalFrames} (~${(totalFrames / 60).toFixed(1)}s at 60Hz)</text>\n`;
  svg += `  <text x="20" y="${svgHeight - 50}" font-size="11" fill="#8b949e" font-family="sans-serif">Distance: ${distance.toFixed(1)} units</text>\n`;
  svg += `  <text x="20" y="${svgHeight - 35}" font-size="11" fill="#8b949e" font-family="sans-serif">End position: (${endPos.x.toFixed(1)}, ${endPos.y.toFixed(1)})</text>\n`;

  if (mapBounds && mapBounds.width > 0) {
    svg += `  <text x="20" y="${svgHeight - 20}" font-size="11" fill="#8b949e" font-family="sans-serif">Map bounds: ${mapBounds.width.toFixed(0)} x ${mapBounds.height.toFixed(0)} units</text>\n`;
  }

  // Object count
  if (objects.length > 0) {
    svg += `  <text x="${svgWidth - 20}" y="${svgHeight - 20}" text-anchor="end" font-size="11" fill="#8b949e" font-family="sans-serif">${objects.length} map objects</text>\n`;
  }

  svg += `</svg>\n`;
  return svg;
}

/**
 * Per-player color palette for multi-player rendering
 */
const PLAYER_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
];

export interface PlayerWorldPath {
  playerIndex: number;
  label: string;  // P1, P2, P3, etc.
  positions: WorldPosition[];
  color: string;
}

/**
 * Generate SVG visualization with multiple player paths overlaid on the map.
 */
export function generateMultiPlayerSvg(
  playerPaths: PlayerWorldPath[],
  mapBounds: MapBounds | null,
  objects: MapObject[],
  matchId: string,
  wuLabel?: string
): string {
  const allPositions = playerPaths.flatMap(p => p.positions);
  if (allPositions.length < 2) {
    return createEmptySvg(matchId, 'Not enough position data');
  }

  // Calculate view bounds from all paths AND map bounds
  let viewMinX = Infinity, viewMaxX = -Infinity;
  let viewMinY = Infinity, viewMaxY = -Infinity;

  for (const p of allPositions) {
    viewMinX = Math.min(viewMinX, p.x);
    viewMaxX = Math.max(viewMaxX, p.x);
    viewMinY = Math.min(viewMinY, p.y);
    viewMaxY = Math.max(viewMaxY, p.y);
  }

  if (mapBounds && mapBounds.width > 0) {
    viewMinX = Math.min(viewMinX, mapBounds.minX);
    viewMaxX = Math.max(viewMaxX, mapBounds.maxX);
    viewMinY = Math.min(viewMinY, mapBounds.minY);
    viewMaxY = Math.max(viewMaxY, mapBounds.maxY);
  }

  // Add padding
  const rangeX = viewMaxX - viewMinX;
  const rangeY = viewMaxY - viewMinY;
  const padding = Math.max(rangeX, rangeY) * 0.1;
  viewMinX -= padding;
  viewMaxX += padding;
  viewMinY -= padding;
  viewMaxY += padding;

  const svgWidth = 800;
  const svgHeight = 800;
  const worldWidth = viewMaxX - viewMinX;
  const worldHeight = viewMaxY - viewMinY;
  const scale = Math.min(svgWidth / worldWidth, svgHeight / worldHeight);

  const svgX = (x: number) => (x - viewMinX) * scale;
  const svgY = (y: number) => svgHeight - (y - viewMinY) * scale;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">\n`;

  // Background
  svg += `  <rect width="100%" height="100%" fill="#0d1117"/>\n`;

  // Title
  const titleSuffix = wuLabel ? ` [${wuLabel}]` : '';
  svg += `  <text x="${svgWidth / 2}" y="30" text-anchor="middle" font-size="18" font-family="sans-serif" fill="white">Film: ${matchId}${titleSuffix}</text>\n`;

  // Grid
  svg += `  <g stroke="#21262d" stroke-width="0.5">\n`;
  const gridStep = Math.pow(10, Math.floor(Math.log10(Math.max(worldWidth, worldHeight) / 10)));
  for (let gx = Math.floor(viewMinX / gridStep) * gridStep; gx <= viewMaxX; gx += gridStep) {
    svg += `    <line x1="${svgX(gx)}" y1="0" x2="${svgX(gx)}" y2="${svgHeight}"/>\n`;
  }
  for (let gy = Math.floor(viewMinY / gridStep) * gridStep; gy <= viewMaxY; gy += gridStep) {
    svg += `    <line x1="0" y1="${svgY(gy)}" x2="${svgWidth}" y2="${svgY(gy)}"/>\n`;
  }
  svg += `  </g>\n`;

  // Map bounds rectangle
  if (mapBounds && mapBounds.width > 0) {
    svg += `  <rect x="${svgX(mapBounds.minX)}" y="${svgY(mapBounds.maxY)}" `;
    svg += `width="${mapBounds.width * scale}" height="${mapBounds.height * scale}" `;
    svg += `fill="none" stroke="#30363d" stroke-width="2" stroke-dasharray="10,5"/>\n`;
  }

  // Draw objects (same as single-player)
  if (objects.length > 0) {
    svg += `  <g>\n`;
    const labelData: Array<{x: number; y: number; label: string; color: string; radius: number; index: number}> = [];

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      const x = svgX(obj.position.x);
      const y = svgY(obj.position.y);
      if (x < 0 || x > svgWidth || y < 0 || y > svgHeight) continue;

      let color = '#666';
      let radius = 4;
      let label = '';

      if (obj.name.includes('Spawn Point [Initial]')) {
        color = '#00ff00'; radius = 6; label = 'Initial Spawn';
      } else if (obj.name.includes('Spawn Point [Respawn]')) {
        continue;
      } else if (obj.name.includes('Flag') && obj.name.includes('Delivery')) {
        color = '#ffff00'; radius = 6; label = 'Flag Delivery';
      } else if (obj.name.includes('Flag') && obj.name.includes('Spawn')) {
        color = '#ffaa00'; radius = 5; label = 'Flag Spawn';
      } else if (obj.name.includes('Flag')) {
        color = '#ffcc00'; radius = 5; label = 'Flag';
      } else if (obj.name.includes('Zone') || obj.name.includes('Capture')) {
        continue;
      } else if (obj.name.includes('Ball')) {
        continue;
      } else if (obj.name.includes('Weapon') || obj.name.includes('Gun') || obj.name.includes('Rifle') ||
                 obj.name.includes('Pistol') || obj.name.includes('Shotgun') || obj.name.includes('Sniper') ||
                 obj.name.includes('Rocket') || obj.name.includes('Sword') || obj.name.includes('Hammer') ||
                 obj.name.includes('Needler') || obj.name.includes('Plasma') || obj.name.includes('BR') ||
                 obj.name.includes('DMR') || obj.name.includes('Commando') || obj.name.includes('Sidekick') ||
                 obj.name.includes('Mangler') || obj.name.includes('Bulldog') || obj.name.includes('Heatwave') ||
                 obj.name.includes('Shock') || obj.name.includes('Stalker') || obj.name.includes('Skewer') ||
                 obj.name.includes('Cindershot') || obj.name.includes('Ravager') || obj.name.includes('Hydra') ||
                 obj.name.includes('Sentinel') || obj.name.includes('Disruptor')) {
        color = '#ff6666'; radius = 5; label = obj.name;
      } else if (obj.name.includes('Equipment') || obj.name.includes('Grenade') || obj.name.includes('Overshield') ||
                 obj.name.includes('Camo') || obj.name.includes('Grapple') || obj.name.includes('Thruster') ||
                 obj.name.includes('Repulsor') || obj.name.includes('Drop Wall') || obj.name.includes('Threat Sensor')) {
        color = '#cc66ff'; radius = 5; label = obj.name;
      } else {
        continue;
      }

      svg += `    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="${color}" opacity="0.7"/>\n`;
      if (label) {
        labelData.push({ x, y, label, color, radius, index: i });
      }
    }
    svg += `  </g>\n`;

    // Labels
    if (labelData.length > 0) {
      svg += `  <g font-family="sans-serif" font-size="7">\n`;
      const labelOffset = 18;
      for (const { x, y, label, color, radius, index } of labelData) {
        const pos = index % 4;
        const textWidth = label.length * 4.2 + 4;
        let tx: number, ty: number, lx: number, ly: number;
        if (pos === 0) { tx = x + labelOffset; ty = y + 2; lx = x + radius; ly = y; }
        else if (pos === 1) { tx = x - textWidth / 2; ty = y + labelOffset + 2; lx = x; ly = y + radius; }
        else if (pos === 2) { tx = x - labelOffset - textWidth; ty = y + 2; lx = x - radius; ly = y; }
        else { tx = x - textWidth / 2; ty = y - labelOffset; lx = x; ly = y - radius; }
        const lineEndX = pos === 0 ? tx - 2 : pos === 2 ? tx + textWidth + 2 : tx + textWidth / 2;
        const lineEndY = pos === 1 ? ty - 8 : pos === 3 ? ty + 2 : ty - 3;
        svg += `    <line x1="${lx.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${lineEndX.toFixed(1)}" y2="${lineEndY.toFixed(1)}" stroke="${color}" stroke-width="0.5" opacity="0.6"/>\n`;
        svg += `    <rect x="${(tx - 2).toFixed(1)}" y="${(ty - 7).toFixed(1)}" width="${textWidth}" height="10" fill="#0d1117" opacity="0.85" rx="2"/>\n`;
        svg += `    <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="${color}">${label}</text>\n`;
      }
      svg += `  </g>\n`;
    }
  }

  // Draw each player's path as raw dots (no lines)
  for (const playerPath of playerPaths) {
    const { positions, color } = playerPath;
    if (positions.length < 1) continue;

    for (const p of positions) {
      svg += `  <circle cx="${svgX(p.x).toFixed(1)}" cy="${svgY(p.y).toFixed(1)}" r="1.5" fill="${color}" opacity="0.7"/>\n`;
    }

    // Start marker
    const startPos = positions[0];
    svg += `  <circle cx="${svgX(startPos.x).toFixed(1)}" cy="${svgY(startPos.y).toFixed(1)}" r="6" fill="${color}" stroke="white" stroke-width="1.5"/>\n`;

    // End marker
    const endPos = positions[positions.length - 1];
    svg += `  <circle cx="${svgX(endPos.x).toFixed(1)}" cy="${svgY(endPos.y).toFixed(1)}" r="4" fill="${color}" stroke="white" stroke-width="1.5" opacity="0.6"/>\n`;
  }

  // Legend
  svg += `  <g font-family="sans-serif" font-size="12">\n`;
  for (let i = 0; i < playerPaths.length; i++) {
    const pp = playerPaths[i];
    const ly = 55 + i * 20;
    svg += `    <rect x="18" y="${ly - 8}" width="12" height="12" fill="${pp.color}" rx="2"/>\n`;
    svg += `    <text x="36" y="${ly + 2}" fill="${pp.color}">${pp.label} (${pp.positions.length} frames)</text>\n`;
  }
  svg += `  </g>\n`;

  // Stats
  const totalFrames = playerPaths.reduce((sum, p) => sum + p.positions.length, 0);
  svg += `  <text x="20" y="${svgHeight - 50}" font-size="11" fill="#8b949e" font-family="sans-serif">Players: ${playerPaths.length} | Total frames: ${totalFrames}</text>\n`;

  if (mapBounds && mapBounds.width > 0) {
    svg += `  <text x="20" y="${svgHeight - 35}" font-size="11" fill="#8b949e" font-family="sans-serif">Map bounds: ${mapBounds.width.toFixed(0)} x ${mapBounds.height.toFixed(0)} units</text>\n`;
  }

  if (objects.length > 0) {
    svg += `  <text x="${svgWidth - 20}" y="${svgHeight - 20}" text-anchor="end" font-size="11" fill="#8b949e" font-family="sans-serif">${objects.length} map objects</text>\n`;
  }

  svg += `</svg>\n`;
  return svg;
}

/**
 * Get a player color from the palette
 */
export function getPlayerColor(playerIndex: number): string {
  return PLAYER_COLORS[playerIndex % PLAYER_COLORS.length];
}

function createEmptySvg(matchId: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <text x="200" y="80" text-anchor="middle" font-size="14" fill="white" font-family="sans-serif">Film: ${matchId}</text>
  <text x="200" y="120" text-anchor="middle" font-size="12" fill="#8b949e" font-family="sans-serif">${message}</text>
</svg>
`;
}
