/**
 * Object extraction from parsed MVAR Bond documents
 * Ported from extract_mvar.py
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { BondDocument, BondStruct, BondList, MapObject, MapBounds, ObjectIdEntry } from './types.js';
import { dim } from './ui.js';

// Coordinate scale factor (MVAR uses 0.1x game coordinates)
const COORD_SCALE = 10.0;

/**
 * Safely get a nested value from a Bond structure
 */
function getNestedValue(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Load object ID to name mapping from JSON file
 */
export async function loadObjectIds(
  basePath: string = '.',
  onStatus?: (msg: string) => void
): Promise<Map<number, string>> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const objectIdsPath = join(basePath, 'src', 'cli', 'objects.json');

  if (!existsSync(objectIdsPath)) {
    log(`Object IDs file not found at ${objectIdsPath}`);
    return new Map();
  }

  const data = await readFile(objectIdsPath, 'utf-8');
  const entries: ObjectIdEntry[] = JSON.parse(data);

  const mapping = new Map<number, string>();
  for (const entry of entries) {
    mapping.set(entry.id, entry.name);
  }

  log(`Loaded ${mapping.size} object ID mappings`);
  return mapping;
}

/**
 * Extract objects from a parsed Bond MVAR document
 */
export function extractObjects(
  bondDoc: BondDocument,
  objectIds: Map<number, string>
): MapObject[] {
  const objects: MapObject[] = [];

  // Navigate to field_3 (object placements)
  // Path: content.fields.field_3.value.items[]
  const content = bondDoc.content;
  if (!content?.fields) {
    return objects;
  }

  const field3 = content.fields.field_3;
  if (!field3?.value) {
    return objects;
  }

  const field3Value = field3.value as BondList;
  if (!field3Value.items || !Array.isArray(field3Value.items)) {
    return objects;
  }

  for (let i = 0; i < field3Value.items.length; i++) {
    const item = field3Value.items[i] as BondStruct;
    if (!item?.fields) continue;

    // Get object ID from field_2.field_0
    const objId = getNestedValue(
      item, 'fields', 'field_2', 'value', 'fields', 'field_0', 'value'
    ) as number | undefined;

    // Get position from field_3 (multiply by 10 for game coords)
    const posFields = getNestedValue(
      item, 'fields', 'field_3', 'value', 'fields'
    ) as Record<string, { type: string; value: number }> | undefined;

    const rawX = posFields?.field_0?.value ?? 0;
    const rawY = posFields?.field_1?.value ?? 0;
    const rawZ = posFields?.field_2?.value ?? 0;

    // Get forward direction from field_5
    const fwdFields = getNestedValue(
      item, 'fields', 'field_5', 'value', 'fields'
    ) as Record<string, { type: string; value: number }> | undefined;

    const fwdX = fwdFields?.field_0?.value ?? 0;
    const fwdY = fwdFields?.field_1?.value ?? 0;

    // Get category from field_7
    const category = getNestedValue(
      item, 'fields', 'field_7', 'value'
    ) as number | undefined;

    // Calculate heading from forward vector
    let heading = 0;
    if (fwdX !== 0 || fwdY !== 0) {
      heading = Math.atan2(fwdY, fwdX) * (180 / Math.PI);
    }

    // Resolve object name
    let name = `Unknown (${objId})`;
    if (objId !== undefined && objectIds.has(objId)) {
      name = objectIds.get(objId)!;
    }

    // Rotate 90 degrees counter-clockwise: (x,y) -> (-y, x)
    objects.push({
      index: i,
      objectId: objId ?? 0,
      name,
      position: {
        x: Math.round(-rawY * COORD_SCALE * 100) / 100,  // -Y becomes X
        y: Math.round(rawX * COORD_SCALE * 100) / 100,   // X becomes Y
        z: Math.round(rawZ * COORD_SCALE * 100) / 100,
      },
      forward: {
        x: Math.round(fwdX * 10000) / 10000,
        y: Math.round(fwdY * 10000) / 10000,
      },
      heading: Math.round(heading * 100) / 100,
      category,
    });
  }

  return objects;
}

/**
 * Compute map bounds from extracted objects.
 * Prefers using gameplay objects (spawns, flags, objectives) for bounds,
 * with a buffer. Falls back to IQR-filtered all-object bounds.
 */
export function computeMapBounds(objects: MapObject[]): MapBounds {
  if (objects.length === 0) {
    return {
      minX: 0, maxX: 0,
      minY: 0, maxY: 0,
      minZ: 0, maxZ: 0,
      width: 0, height: 0, depth: 0,
      centerX: 0, centerY: 0, centerZ: 0,
    };
  }

  // Try gameplay-based bounds first (spawns, flags, objectives)
  const gameplayObjects = objects.filter(o =>
    o.name.includes('Spawn Point') ||
    o.name.includes('Flag') ||
    o.name.includes('Zone') ||
    o.name.includes('Capture') ||
    o.name.includes('Ball')
  );

  let boundsObjects: MapObject[];

  if (gameplayObjects.length >= 4) {
    boundsObjects = gameplayObjects;
  } else {
    boundsObjects = objects;
  }

  const xValues = boundsObjects.map(o => o.position.x);
  const yValues = boundsObjects.map(o => o.position.y);
  const zValues = boundsObjects.map(o => o.position.z);

  let minX = Math.min(...xValues);
  let maxX = Math.max(...xValues);
  let minY = Math.min(...yValues);
  let maxY = Math.max(...yValues);
  let minZ = Math.min(...zValues);
  let maxZ = Math.max(...zValues);

  // Add 20% buffer around gameplay bounds to show surrounding area
  if (gameplayObjects.length >= 4) {
    const bufferX = (maxX - minX) * 0.2;
    const bufferY = (maxY - minY) * 0.2;
    minX -= bufferX;
    maxX += bufferX;
    minY -= bufferY;
    maxY += bufferY;
  }

  return {
    minX, maxX,
    minY, maxY,
    minZ, maxZ,
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/**
 * Filter objects to get spawn points and other important markers
 */
export function filterImportantObjects(objects: MapObject[]): MapObject[] {
  const importantNames = [
    'Spawn Point [Initial]',
    'Spawn Point [Respawn]',
    'Flag Spawn',
    'Flag Delivery Plate',
    'Zone Capture Plate',
    'Landgrab Capture Zone',
    'Ball Stand',
  ];

  return objects.filter(obj =>
    importantNames.some(name => obj.name.includes(name))
  );
}
