/**
 * Frame table with filtering, sorting, and virtual scrolling.
 */

import type { ParsedFrame } from './film-parser.ts';

const ROW_HEIGHT = 20;
const OVERSCAN = 10;

type SortKey = keyof ParsedFrame | 'd0hnib';
type SortDir = 'asc' | 'desc';

export interface Filters {
  player: number | null;
  base: number | null;
  subtype: string;
  d0hnib: number | null;
  posOnly: boolean;
}

interface Column {
  key: SortKey;
  label: string;
  cssClass: string;
  format: (f: ParsedFrame) => string;
}

const COLUMNS: Column[] = [
  { key: 'index', label: '#', cssClass: 'col-idx', format: f => String(f.index) },
  { key: 'chunkIndex', label: 'Chk', cssClass: 'col-chunk', format: f => String(f.chunkIndex) },
  { key: 'offset', label: 'Offset', cssClass: 'col-offset', format: f => f.offset.toString(16).padStart(6, '0') },
  { key: 'tick', label: 'Tick', cssClass: 'col-tick', format: f => String(f.tick) },
  { key: 'playerIndex', label: 'P', cssClass: 'col-player', format: f => String(f.playerIndex) },
  { key: 'baseType', label: 'Base', cssClass: 'col-base', format: f => '0x' + f.baseType.toString(16).padStart(2, '0') },
  { key: 'byte7', label: 'Sub', cssClass: 'col-subtype', format: f => f.subtypeHex },
  { key: 'formatByte', label: 'Fmt', cssClass: 'col-fmt', format: f => f.formatByte.toString(16).padStart(2, '0') },
  {
    key: 'dataBytes' as SortKey,
    label: 'd0-d3',
    cssClass: 'col-data',
    format: f => f.dataBytes.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join(' '),
  },
  { key: 'coord1' as SortKey, label: 'c1', cssClass: 'col-c1', format: f => f.coord1 !== undefined ? String(f.coord1) : '' },
  { key: 'coord2' as SortKey, label: 'c2', cssClass: 'col-c2', format: f => f.coord2 !== undefined ? String(f.coord2) : '' },
  { key: 'd0hnib', label: 'hnib', cssClass: 'col-hnib', format: f => String(f.dataBytes[0] >> 4) },
];

/** Pre-render a row's inner HTML from a frame. */
function rowHTML(frame: ParsedFrame): string {
  let h = '';
  for (const col of COLUMNS) {
    h += `<span class="col ${col.cssClass}">${col.format(frame)}</span>`;
  }
  return h;
}

export class FrameTable {
  private container: HTMLElement;
  private allFrames: ParsedFrame[] = [];
  private filtered: ParsedFrame[] = [];
  private sortKey: SortKey = 'index';
  private sortDir: SortDir = 'asc';
  private selectedFrameIndex: number | null = null;
  private onFrameClick: (frameIndex: number) => void;

  private headerEl: HTMLElement;
  private scrollContainer: HTMLElement;
  private spacerTop: HTMLElement;
  private spacerBottom: HTMLElement;
  private rowMap = new Map<number, HTMLElement>(); // filteredIdx → element
  private visibleStart = -1;
  private visibleEnd = -1;
  private rafId = 0;

  constructor(container: HTMLElement, onFrameClick: (frameIndex: number) => void) {
    this.container = container;
    this.onFrameClick = onFrameClick;

    // Build header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'frame-table-header';
    for (const col of COLUMNS) {
      const colEl = document.createElement('span');
      colEl.className = `col ${col.cssClass}`;
      colEl.textContent = col.label;
      colEl.addEventListener('click', () => this.setSort(col.key));
      this.headerEl.appendChild(colEl);
    }
    this.container.appendChild(this.headerEl);

    // Build scroll area
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.style.flex = '1';
    this.scrollContainer.style.overflowY = 'auto';
    this.scrollContainer.style.position = 'relative';
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';

    this.spacerTop = document.createElement('div');
    this.spacerTop.className = 'virtual-spacer';
    this.spacerBottom = document.createElement('div');
    this.spacerBottom.className = 'virtual-spacer';

    this.scrollContainer.appendChild(this.spacerTop);
    this.scrollContainer.appendChild(this.spacerBottom);
    this.container.appendChild(this.scrollContainer);

    // Delegated click handler — one listener instead of per-row
    this.scrollContainer.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('.frame-row') as HTMLElement | null;
      if (row?.dataset.frameIndex) {
        this.onFrameClick(parseInt(row.dataset.frameIndex, 10));
      }
    });

    this.scrollContainer.addEventListener('scroll', () => {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        this.render();
      });
    });
  }

  setFrames(frames: ParsedFrame[], filters?: Filters): void {
    this.allFrames = frames;
    this.applyFilter(filters ?? { player: null, base: null, subtype: '', d0hnib: null, posOnly: false });
  }

  applyFilter(filters: Filters): void {
    this.filtered = this.allFrames.filter(f => {
      if (filters.player !== null && (!f.hasPlayer || f.playerIndex !== filters.player)) return false;
      if (filters.base !== null && f.baseType !== filters.base) return false;
      if (filters.subtype && !f.subtypeHex.includes(filters.subtype.toLowerCase())) return false;
      if (filters.d0hnib !== null && (f.dataBytes[0] >> 4) !== filters.d0hnib) return false;
      if (filters.posOnly && !f.isPositionFrame) return false;
      return true;
    });
    this.applySortToFiltered();
    this.resetView();
  }

  updateSelection(selectedFrameIndex: number | null): void {
    this.selectedFrameIndex = selectedFrameIndex;
    this.refreshVisible();
  }

  scrollToFrame(frameIndex: number): void {
    const idx = this.filtered.findIndex(f => f.index === frameIndex);
    if (idx === -1) return;
    const viewportRows = Math.floor(this.scrollContainer.clientHeight / ROW_HEIGHT);
    const targetRow = Math.max(0, idx - Math.floor(viewportRows / 2));
    this.scrollContainer.scrollTop = targetRow * ROW_HEIGHT;
  }

  getFilterOptions(): { players: number[]; bases: number[]; d0hnibs: number[] } {
    const players = new Set<number>();
    const bases = new Set<number>();
    const d0hnibs = new Set<number>();
    for (const f of this.allFrames) {
      if (f.hasPlayer) players.add(f.playerIndex);
      bases.add(f.baseType);
      d0hnibs.add(f.dataBytes[0] >> 4);
    }
    return {
      players: [...players].sort((a, b) => a - b),
      bases: [...bases].sort((a, b) => a - b),
      d0hnibs: [...d0hnibs].sort((a, b) => a - b),
    };
  }

  get filteredCount(): number {
    return this.filtered.length;
  }

  private setSort(key: SortKey): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = 'asc';
    }
    this.updateHeaderSort();
    this.applySortToFiltered();
    this.resetView();
  }

  private updateHeaderSort(): void {
    const cols = this.headerEl.querySelectorAll('.col');
    cols.forEach((col, i) => {
      col.classList.remove('sorted-asc', 'sorted-desc');
      if (COLUMNS[i].key === this.sortKey) {
        col.classList.add(this.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  private applySortToFiltered(): void {
    const key = this.sortKey;
    const dir = this.sortDir === 'asc' ? 1 : -1;

    this.filtered.sort((a, b) => {
      let av: number;
      let bv: number;

      if (key === 'd0hnib') {
        av = a.dataBytes[0] >> 4;
        bv = b.dataBytes[0] >> 4;
      } else if (key === 'coord1' as SortKey) {
        av = a.coord1 ?? -1;
        bv = b.coord1 ?? -1;
      } else if (key === 'coord2' as SortKey) {
        av = a.coord2 ?? -1;
        bv = b.coord2 ?? -1;
      } else if (key === 'dataBytes' as SortKey) {
        av = a.dataBytes[0];
        bv = b.dataBytes[0];
      } else {
        av = a[key] as number;
        bv = b[key] as number;
      }

      return (av - bv) * dir;
    });
  }

  private resetView(): void {
    this.visibleStart = -1;
    this.visibleEnd = -1;
    for (const el of this.rowMap.values()) el.remove();
    this.rowMap.clear();
    this.render();
  }

  private render(): void {
    const totalRows = this.filtered.length;
    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

    if (firstVisible === this.visibleStart && lastVisible === this.visibleEnd) return;

    this.spacerTop.style.height = firstVisible * ROW_HEIGHT + 'px';
    this.spacerBottom.style.height = Math.max(0, (totalRows - lastVisible - 1) * ROW_HEIGHT) + 'px';

    // Clear all existing rows and rebuild the visible range.
    // With innerHTML-based row creation, ~50 rows is trivially fast.
    for (const el of this.rowMap.values()) el.remove();
    this.rowMap.clear();

    const fragment = document.createDocumentFragment();
    for (let i = firstVisible; i <= lastVisible; i++) {
      const frame = this.filtered[i];
      if (!frame) continue;

      const row = document.createElement('div');
      row.className = frame.hasPlayer ? `frame-row player-${frame.playerIndex}` : 'frame-row';
      if (frame.index === this.selectedFrameIndex) row.className += ' selected';
      row.dataset.filteredIdx = String(i);
      row.dataset.frameIndex = String(frame.index);
      row.innerHTML = rowHTML(frame);

      fragment.appendChild(row);
      this.rowMap.set(i, row);
    }

    this.scrollContainer.insertBefore(fragment, this.spacerBottom);
    this.visibleStart = firstVisible;
    this.visibleEnd = lastVisible;
  }

  private refreshVisible(): void {
    for (const el of this.rowMap.values()) {
      const frameIndex = parseInt(el.dataset.frameIndex!, 10);
      if (frameIndex === this.selectedFrameIndex) {
        el.classList.add('selected');
      } else {
        el.classList.remove('selected');
      }
    }
  }
}
