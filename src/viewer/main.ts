/**
 * FilmShell Binary Viewer — App bootstrap, film loading via API, state management.
 */

import { parseFrames, buildFieldMap, frameAtOffset, type ParsedFrame } from './film-parser.ts';
import { HexView } from './hex-view.ts';
import { FrameTable, type Filters } from './frame-table.ts';

// ── Types ──

interface FilmEntry {
  matchId: string;
  chunks: number;
  totalSize: number;
  players: number;
  duration: string;
  filmLengthMs: number;
  startTime: string;
  mapAssetId: string;
}

// ── DOM Elements ──

const filmSelect = document.getElementById('film-select') as HTMLSelectElement;
const filmMeta = document.getElementById('film-meta')!;
const chunkMapEl = document.getElementById('chunk-map')!;
const workspace = document.getElementById('workspace')!;
const hexContainer = document.getElementById('hex-container')!;
const playerStatsEl = document.getElementById('player-stats')!;
const tableContainer = document.getElementById('frame-table-container')!;
const statusText = document.getElementById('status-text')!;
const tooltipEl = document.getElementById('tooltip')!;
const divider = document.getElementById('divider')!;

const filterPlayer = document.getElementById('filter-player') as HTMLSelectElement;
const filterBase = document.getElementById('filter-base') as HTMLSelectElement;
const filterSubtype = document.getElementById('filter-subtype') as HTMLInputElement;
const filterD0hnib = document.getElementById('filter-d0hnib') as HTMLSelectElement;
const filterPosOnly = document.getElementById('filter-pos-only') as HTMLButtonElement;

// ── State ──

let filmEntries: FilmEntry[] = [];
let allData: Uint8Array | null = null;
let chunkOffsets: number[] = [];
let chunkSizes: number[] = [];
let frames: ParsedFrame[] = [];
let selectedFrameIndex: number | null = null;
let activeMatchId: string | null = null;

// ── Components ──

const hexView = new HexView(hexContainer, {
  onByteClick(offset) {
    const fi = frameAtOffset(offset, frames);
    if (fi !== null) selectFrame(fi);
  },
  onByteHover(offset, x, y) {
    const tip = hexView.getTooltip(offset);
    if (tip) showTooltip(tip, x, y);
    else hideTooltip();
  },
  onHoverEnd() {
    hideTooltip();
  },
});

const frameTable = new FrameTable(tableContainer, (frameIndex) => {
  selectFrame(frameIndex);
});

// ── Film Picker ──

async function loadFilmList(): Promise<void> {
  try {
    const res = await fetch('/api/films');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    filmEntries = await res.json();

    if (filmEntries.length === 0) {
      filmSelect.innerHTML = '<option value="">No films found</option>';
      return;
    }

    filmSelect.innerHTML = '<option value="">Select a film...</option>';
    for (const film of filmEntries) {
      const opt = document.createElement('option');
      opt.value = film.matchId;
      const dur = parseDuration(film.duration);
      opt.textContent = `${film.matchId}  (${film.players}P, ${film.chunks} chunks, ${formatBytes(film.totalSize)}${dur ? ', ' + dur : ''})`;
      filmSelect.appendChild(opt);
    }
    filmSelect.disabled = false;
  } catch (err) {
    filmSelect.innerHTML = `<option value="">Error: ${err}</option>`;
  }
}

filmSelect.addEventListener('change', () => {
  const matchId = filmSelect.value;
  if (!matchId) return;
  const film = filmEntries.find(f => f.matchId === matchId);
  if (film) loadFilm(film);
});

async function loadFilm(film: FilmEntry): Promise<void> {
  if (activeMatchId === film.matchId) return;

  filmSelect.disabled = true;
  activeMatchId = film.matchId;
  statusText.textContent = `Loading ${film.chunks} chunks...`;

  try {
    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < film.chunks; i++) {
      const res = await fetch(`/api/films/${film.matchId}/filmChunk${i}_dec`);
      if (!res.ok) throw new Error(`Chunk ${i}: HTTP ${res.status}`);
      buffers.push(await res.arrayBuffer());
    }

    const totalSize = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    chunkOffsets = [];
    chunkSizes = [];
    let offset = 0;

    for (const buf of buffers) {
      chunkOffsets.push(offset);
      chunkSizes.push(buf.byteLength);
      combined.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    allData = combined;
    selectedFrameIndex = null;

    const dur = parseDuration(film.duration);
    filmMeta.textContent = `${film.chunks} chunks | ${formatBytes(totalSize)} | ${film.players}P${dur ? ' | ' + dur : ''}`;

    processData();
    renderChunkMap(totalSize);
  } catch (err) {
    statusText.textContent = `Error: ${err}`;
    activeMatchId = null;
  } finally {
    filmSelect.disabled = false;
  }
}

// ── Chunk Map ──

const CHUNK_COLORS = [
  '#1e3a5f', '#3b1f2b', '#1f3d2e', '#3d3520',
  '#2d1f4d', '#1f3d3d', '#4d1f1f', '#2e3d1f',
  '#1f2d4d', '#3d2e1f', '#1f4d3b', '#4d3b1f',
  '#2b1f4d', '#1f4d2d', '#4d1f3b', '#3d1f4d',
];

function renderChunkMap(totalSize: number): void {
  chunkMapEl.innerHTML = '';
  chunkMapEl.classList.remove('hidden');

  for (let i = 0; i < chunkSizes.length; i++) {
    const pct = (chunkSizes[i] / totalSize) * 100;
    const seg = document.createElement('div');
    seg.className = 'chunk-seg';
    seg.style.width = `${pct}%`;
    seg.style.background = CHUNK_COLORS[i % CHUNK_COLORS.length];
    seg.textContent = `${i}`;
    seg.title = `Chunk ${i}: ${formatBytes(chunkSizes[i])} @ 0x${chunkOffsets[i].toString(16).padStart(6, '0')}`;

    seg.addEventListener('click', () => {
      hexView.scrollToOffset(chunkOffsets[i]);
    });

    chunkMapEl.appendChild(seg);
  }
}

// ── Player Stats ──

const PLAYER_COLORS = [
  '#4fc3f7', '#f06292', '#aed581', '#ffb74d',
  '#ba68c8', '#4dd0e1', '#e57373', '#81c784',
];

function renderPlayerStats(players: [number, number][]): void {
  playerStatsEl.innerHTML = '';
  playerStatsEl.classList.remove('hidden');

  const maxCount = Math.max(...players.map(([, n]) => n));

  for (const [playerIdx, count] of players) {
    const color = PLAYER_COLORS[playerIdx % PLAYER_COLORS.length];
    const pct = (count / maxCount) * 100;

    const stat = document.createElement('div');
    stat.className = 'player-stat';
    stat.innerHTML =
      `<div class="player-color" style="background:${color}"></div>` +
      `<span class="player-label">P${playerIdx}</span>` +
      `<div class="player-bar"><div class="player-bar-fill" style="width:${pct}%;background:${color}"></div></div>` +
      `<span class="player-count">${count}</span>`;

    stat.addEventListener('click', () => {
      filterPlayer.value = String(playerIdx);
      filterPlayer.dispatchEvent(new Event('change'));
    });
    stat.style.cursor = 'pointer';

    playerStatsEl.appendChild(stat);
  }
}

function processData(): void {
  if (!allData) return;

  frames = parseFrames(allData, chunkOffsets);
  const fieldMap = buildFieldMap(allData, frames);

  hexView.setState({
    data: allData,
    fieldMap,
    frames,
    chunkOffsets,
    selectedFrameIndex: null,
  });

  frameTable.setFrames(frames, getFilters());
  populateFilters();
  workspace.classList.remove('hidden');

  // Player breakdown — only count frames where playerIndex is meaningful
  // (byte5=0x40 with baseType 0x09 or 0x08, matching CLI detectPlayers logic)
  const playerCounts = new Map<number, number>();
  for (const f of frames) {
    if (f.byte5 === 0x40 && (f.baseType === 0x09 || f.baseType === 0x08)) {
      playerCounts.set(f.playerIndex, (playerCounts.get(f.playerIndex) || 0) + 1);
    }
  }
  const players = [...playerCounts.entries()].sort((a, b) => a[0] - b[0]);

  filmMeta.textContent += ` | ${frames.length} frames | ${players.length} player${players.length !== 1 ? 's' : ''}`;
  statusText.textContent = `${frames.length} frames parsed from ${chunkOffsets.length} chunks`;

  renderPlayerStats(players);
}

function populateFilters(): void {
  const opts = frameTable.getFilterOptions();

  // Save current selections
  const prevPlayer = filterPlayer.value;
  const prevBase = filterBase.value;
  const prevD0hnib = filterD0hnib.value;

  filterPlayer.innerHTML = '<option value="">Player</option>';
  for (const p of opts.players) {
    const opt = document.createElement('option');
    opt.value = String(p);
    opt.textContent = `P${p}`;
    filterPlayer.appendChild(opt);
  }

  filterBase.innerHTML = '<option value="">Base</option>';
  for (const b of opts.bases) {
    const opt = document.createElement('option');
    opt.value = String(b);
    opt.textContent = '0x' + b.toString(16).padStart(2, '0');
    filterBase.appendChild(opt);
  }

  filterD0hnib.innerHTML = '<option value="">d0 hnib</option>';
  for (const h of opts.d0hnibs) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = String(h);
    filterD0hnib.appendChild(opt);
  }

  // Restore selections (if the value still exists in the new options)
  filterPlayer.value = prevPlayer;
  filterBase.value = prevBase;
  filterD0hnib.value = prevD0hnib;
}

function getFilters(): Filters {
  return {
    player: filterPlayer.value ? parseInt(filterPlayer.value, 10) : null,
    base: filterBase.value ? parseInt(filterBase.value, 10) : null,
    subtype: filterSubtype.value.trim(),
    d0hnib: filterD0hnib.value !== '' ? parseInt(filterD0hnib.value, 10) : null,
    posOnly: filterPosOnly.classList.contains('active'),
  };
}

// ── Selection (bidirectional linking) ──

function selectFrame(frameIndex: number): void {
  selectedFrameIndex = frameIndex;
  const frame = frames[frameIndex];

  hexView.updateSelection(frameIndex);
  hexView.scrollToOffset(frame.offset);
  frameTable.updateSelection(frameIndex);
  frameTable.scrollToFrame(frameIndex);

  const hnib = frame.dataBytes[0] >> 4;
  statusText.textContent =
    `Frame #${frame.index} | Offset 0x${frame.offset.toString(16).padStart(6, '0')} | ` +
    `Tick ${frame.tick} | Type ${frame.frameTypeHex} | Player ${frame.playerIndex} | ` +
    `Base 0x${frame.baseType.toString(16).padStart(2, '0')} | Sub ${frame.subtypeHex} | ` +
    `Fmt 0x${frame.formatByte.toString(16).padStart(2, '0')} | d0 hnib=${hnib}` +
    (frame.isPositionFrame ? ` | c1=${frame.coord1} c2=${frame.coord2}` : '');
}

// ── Tooltip ──

function showTooltip(text: string, x: number, y: number): void {
  tooltipEl.textContent = text;
  tooltipEl.classList.remove('hidden');
  tooltipEl.style.left = (x + 12) + 'px';
  tooltipEl.style.top = (y - 8) + 'px';
}

function hideTooltip(): void {
  tooltipEl.classList.add('hidden');
}

// ── Resizable Divider ──

let isDragging = false;

divider.addEventListener('mousedown', (e) => {
  isDragging = true;
  divider.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const hexPane = document.getElementById('hex-pane')!;
  const workspaceRect = workspace.getBoundingClientRect();
  const newWidth = Math.max(300, Math.min(e.clientX - workspaceRect.left, workspaceRect.width - 300));
  hexPane.style.width = newWidth + 'px';
  hexPane.style.flex = 'none';
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    divider.classList.remove('dragging');
  }
});

// ── Filter Events ──

filterPlayer.addEventListener('change', () => frameTable.applyFilter(getFilters()));
filterBase.addEventListener('change', () => frameTable.applyFilter(getFilters()));
filterSubtype.addEventListener('input', () => frameTable.applyFilter(getFilters()));
filterD0hnib.addEventListener('change', () => frameTable.applyFilter(getFilters()));
filterPosOnly.addEventListener('click', () => {
  filterPosOnly.classList.toggle('active');
  frameTable.applyFilter(getFilters());
});

// ── Util ──

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function parseDuration(iso: string): string {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return '';
  const h = m[1] ? parseInt(m[1]) : 0;
  const min = m[2] ? parseInt(m[2]) : 0;
  const sec = m[3] ? Math.round(parseFloat(m[3])) : 0;
  if (h) return `${h}h${min}m`;
  return `${min}m${sec}s`;
}

// ── Init ──

loadFilmList();
