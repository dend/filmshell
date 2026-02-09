/**
 * Map metadata fetching module
 * Fetches map assets and MVAR files from Halo API
 */

import { HaloInfiniteClient, isSuccess, isNotModified } from '@dendotdev/grunt';
import * as readline from 'node:readline';
import { dim, yellow, green, red } from './ui.js';

// The API returns different casing - use loose typing
interface AssetFiles {
  prefix?: string;
  Prefix?: string;
  fileRelativePaths?: string[];
  FileRelativePaths?: string[];
}

interface MapAssetResponse {
  assetId?: string;
  AssetId?: string;
  versionId?: string;
  VersionId?: string;
  name?: string;
  Name?: string;
  publicName?: string;
  description?: string;
  Description?: string;
  files?: AssetFiles;
  Files?: AssetFiles;
  // Authoring endpoint uses AssetVersionFiles
  assetVersionFiles?: AssetFiles;
  AssetVersionFiles?: AssetFiles;
}

export interface MvarInfo {
  path: string;
  buffer: Buffer;
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function fetchMapMvar(
  client: HaloInfiniteClient,
  matchStats: unknown,
  onStatus?: (msg: string) => void
): Promise<MvarInfo | null> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  // Extract MapVariant.AssetId from match stats
  const statsObj = matchStats as Record<string, unknown>;
  const matchInfo = (statsObj.MatchInfo ?? statsObj.matchInfo) as Record<string, unknown> | undefined;
  const mapVariant = (matchInfo?.MapVariant ?? matchInfo?.mapVariant) as Record<string, unknown> | undefined;

  if (!mapVariant) {
    log('No MapVariant found in match stats.');
    return null;
  }

  const assetId = (mapVariant.AssetId ?? mapVariant.assetId) as string | undefined;
  const versionId = (mapVariant.VersionId ?? mapVariant.versionId) as string | undefined;

  if (!assetId) {
    log('No MapVariant AssetId found.');
    return null;
  }

  log(`Map Asset ID: ${assetId}`);
  if (versionId) {
    log(`Map Version ID: ${versionId}`);
  }

  // Fetch map asset metadata
  log('Fetching map asset metadata...');

  let asset: MapAssetResponse | null = null;

  // Try ugcDiscovery.getAssetDetails first
  log(`Request: ugcDiscovery.getAssetDetails('Maps', '${assetId}')`);

  // @ts-expect-error - API expects "Maps" but library types expect AssetKind enum
  const discoveryResult = await client.ugcDiscovery.getAssetDetails('Maps', assetId);

  if (isSuccess(discoveryResult) || isNotModified(discoveryResult)) {
    asset = discoveryResult.result as unknown as MapAssetResponse;
  } else {
    log(`Discovery endpoint failed (${discoveryResult.response.code}), trying authoring endpoint...`);

    // Fallback to authoring endpoint
    const version = versionId ?? 'latest';
    log(`Request: ugc.getSpecificAssetVersion('hi', 'Maps', '${assetId}', '${version}')`);

    const authoringResult = await client.ugc.getSpecificAssetVersion('hi', 'Maps', assetId, version);

    if (!isSuccess(authoringResult) && !isNotModified(authoringResult)) {
      log(`Failed to fetch map asset from both endpoints: ${authoringResult.response.code}`);
      return null;
    }

    asset = authoringResult.result as unknown as MapAssetResponse;
  }

  if (!asset) {
    log('Failed to fetch map asset.');
    return null;
  }
  const mapName = asset.publicName ?? asset.name ?? asset.Name ?? 'Unknown';

  log(`Map Name: ${mapName}`);

  // Get file paths - handle different endpoint response structures
  // Discovery uses: files/Files
  // Authoring uses: assetVersionFiles/AssetVersionFiles
  const files = asset.files ?? asset.Files ?? asset.assetVersionFiles ?? asset.AssetVersionFiles;
  const prefix = files?.prefix ?? files?.Prefix;
  const filePaths = files?.fileRelativePaths ?? files?.FileRelativePaths;

  if (!prefix || !filePaths?.length) {
    log('Map asset has no files.');
    return null;
  }

  // Filter for MVAR files
  const mvarPaths = filePaths.filter(
    (p: string) => p.toLowerCase().endsWith('.mvar')
  );

  if (mvarPaths.length === 0) {
    log('No MVAR files found in map asset.');
    return null;
  }

  let selectedMvar: string;

  if (mvarPaths.length === 1) {
    selectedMvar = mvarPaths[0];
    log(`Found MVAR: ${selectedMvar}`);
  } else {
    // Multiple MVAR files - auto-select "map.mvar" if present, otherwise prompt
    const mapMvar = mvarPaths.find((p: string) => p.toLowerCase() === 'map.mvar');

    if (mapMvar) {
      selectedMvar = mapMvar;
      log(`Multiple MVARs found, auto-selected: ${selectedMvar}`);
    } else if (process.stdin.isTTY) {
      console.log('');
      console.log('Multiple MVAR files found:');
      mvarPaths.forEach((p: string, i: number) => {
        console.log(`  ${i + 1}. ${p}`);
      });
      console.log('');

      const answer = await askQuestion(`Select MVAR file (1-${mvarPaths.length}): `);
      const selection = parseInt(answer, 10);

      if (isNaN(selection) || selection < 1 || selection > mvarPaths.length) {
        log('Invalid selection, using first MVAR.');
        selectedMvar = mvarPaths[0];
      } else {
        selectedMvar = mvarPaths[selection - 1];
      }
    } else {
      selectedMvar = mvarPaths[0];
      log(`Multiple MVARs found, auto-selected first: ${selectedMvar}`);
    }
  }

  // Download the MVAR blob
  log(`Downloading MVAR: ${selectedMvar}...`);

  // Build the full blob path
  // The prefix is typically something like "ugcstorage/map/{guid}/{guid}/..."
  // We need to construct the blob path correctly
  let blobPath = prefix;
  if (!blobPath.endsWith('/')) {
    blobPath += '/';
  }
  blobPath += selectedMvar;

  // Strip origin if present
  const blobOrigin = 'https://blobs-infiniteugc.svc.halowaypoint.com';
  if (blobPath.startsWith(blobOrigin)) {
    blobPath = blobPath.slice(blobOrigin.length);
  }

  const blobResult = await client.ugc.getBlob(blobPath);

  if (!isSuccess(blobResult) && !isNotModified(blobResult)) {
    log(`Failed to download MVAR: ${blobResult.response.code}`);
    return null;
  }

  // getBlob returns Uint8Array, convert to Buffer
  const mvarBuffer = Buffer.from(blobResult.result!);
  log(`Downloaded MVAR (${(mvarBuffer.length / 1024).toFixed(1)} KB)`);

  return {
    path: selectedMvar,
    buffer: mvarBuffer,
  };
}
