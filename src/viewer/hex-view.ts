/**
 * Hex dump view with virtual scrolling and color overlays.
 */

import { FieldType, type ParsedFrame } from './film-parser.ts';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 18;
const OVERSCAN = 10;

const FIELD_CLASS: Record<number, string> = {
  [FieldType.Marker]: 'b-marker',
  [FieldType.Tick]: 'b-tick',
  [FieldType.FrameType]: 'b-type',
  [FieldType.FormatByte]: 'b-format',
  [FieldType.DataPos]: 'b-data-pos',
  [FieldType.DataState]: 'b-data-state',
  [FieldType.DataExt]: 'b-data-ext',
};

const FIELD_LABELS: Record<number, string> = {
  [FieldType.Marker]: 'Frame marker A0 7B 42',
  [FieldType.Tick]: 'Tick',
  [FieldType.FrameType]: 'Frame type',
  [FieldType.FormatByte]: 'Format byte',
  [FieldType.DataPos]: 'Position data',
  [FieldType.DataState]: 'State data',
  [FieldType.DataExt]: 'Extended data',
};

export interface HexViewState {
  data: Uint8Array;
  fieldMap: Uint8Array;
  frames: ParsedFrame[];
  chunkOffsets: number[];
  selectedFrameIndex: number | null;
}

interface HexViewCallbacks {
  onByteClick: (offset: number) => void;
  onByteHover: (offset: number, x: number, y: number) => void;
  onHoverEnd: () => void;
}

export class HexView {
  private container: HTMLElement;
  private state: HexViewState | null = null;
  private callbacks: HexViewCallbacks;
  private spacerTop: HTMLElement;
  private spacerBottom: HTMLElement;
  private rowPool: HTMLElement[] = [];
  private totalRows = 0;
  private visibleStart = -1;
  private visibleEnd = -1;
  private chunkBoundaryRows = new Set<number>();
  private frameBoundaryRows = new Set<number>();

  constructor(container: HTMLElement, callbacks: HexViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.spacerTop = document.createElement('div');
    this.spacerTop.className = 'virtual-spacer';
    this.spacerBottom = document.createElement('div');
    this.spacerBottom.className = 'virtual-spacer';

    this.container.appendChild(this.spacerTop);
    this.container.appendChild(this.spacerBottom);

    this.container.addEventListener('scroll', () => this.render());
  }

  setState(state: HexViewState): void {
    this.state = state;
    this.totalRows = Math.ceil(state.data.length / BYTES_PER_ROW);

    this.chunkBoundaryRows.clear();
    for (const offset of state.chunkOffsets) {
      if (offset > 0) {
        this.chunkBoundaryRows.add(Math.floor(offset / BYTES_PER_ROW));
      }
    }

    this.frameBoundaryRows.clear();
    for (const frame of state.frames) {
      this.frameBoundaryRows.add(Math.floor(frame.offset / BYTES_PER_ROW));
    }

    this.visibleStart = -1;
    this.visibleEnd = -1;
    this.clearPool();
    this.render();
  }

  updateSelection(selectedFrameIndex: number | null): void {
    if (!this.state) return;
    this.state.selectedFrameIndex = selectedFrameIndex;
    this.refreshSelection();
  }

  scrollToOffset(offset: number): void {
    const row = Math.floor(offset / BYTES_PER_ROW);
    const viewportRows = Math.floor(this.container.clientHeight / ROW_HEIGHT);
    const targetRow = Math.max(0, row - Math.floor(viewportRows / 2));
    this.container.scrollTop = targetRow * ROW_HEIGHT;
  }

  private clearPool(): void {
    for (const el of this.rowPool) {
      el.remove();
    }
    this.rowPool = [];
  }

  private render(): void {
    if (!this.state) return;

    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(
      this.totalRows - 1,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
    );

    if (firstVisible === this.visibleStart && lastVisible === this.visibleEnd) return;

    // Update spacers
    this.spacerTop.style.height = firstVisible * ROW_HEIGHT + 'px';
    this.spacerBottom.style.height = Math.max(0, (this.totalRows - lastVisible - 1) * ROW_HEIGHT) + 'px';

    // Remove rows outside new range
    const toRemove: HTMLElement[] = [];
    for (const el of this.rowPool) {
      const rowIdx = parseInt(el.dataset.row!, 10);
      if (rowIdx < firstVisible || rowIdx > lastVisible) {
        toRemove.push(el);
      }
    }
    for (const el of toRemove) {
      el.remove();
      this.rowPool.splice(this.rowPool.indexOf(el), 1);
    }

    // Existing rendered row indices
    const existing = new Set(this.rowPool.map(el => parseInt(el.dataset.row!, 10)));

    // Create missing rows
    const fragment = document.createDocumentFragment();
    for (let row = firstVisible; row <= lastVisible; row++) {
      if (existing.has(row)) continue;
      const el = this.createRow(row);
      fragment.appendChild(el);
      this.rowPool.push(el);
    }

    // Insert fragment before bottom spacer
    this.container.insertBefore(fragment, this.spacerBottom);

    this.visibleStart = firstVisible;
    this.visibleEnd = lastVisible;
  }

  private createRow(rowIdx: number): HTMLElement {
    const state = this.state!;
    const startOffset = rowIdx * BYTES_PER_ROW;
    const endOffset = Math.min(startOffset + BYTES_PER_ROW, state.data.length);

    const row = document.createElement('div');
    row.className = 'hex-row';
    if (this.chunkBoundaryRows.has(rowIdx)) {
      row.className += ' chunk-boundary';
    } else if (this.frameBoundaryRows.has(rowIdx)) {
      row.className += ' frame-boundary';
    }
    row.dataset.row = String(rowIdx);

    // Offset column
    const offsetEl = document.createElement('span');
    offsetEl.className = 'hex-offset';
    offsetEl.textContent = startOffset.toString(16).padStart(6, '0');
    row.appendChild(offsetEl);

    // Hex bytes
    const bytesEl = document.createElement('span');
    bytesEl.className = 'hex-bytes';

    for (let i = startOffset; i < startOffset + BYTES_PER_ROW; i++) {
      // Add gap after byte 7 (between groups of 8)
      if (i === startOffset + 8) {
        const gap = document.createElement('span');
        gap.className = 'hex-byte gap';
        bytesEl.appendChild(gap);
      }

      const byteEl = document.createElement('span');
      byteEl.className = 'hex-byte';

      if (i < endOffset) {
        const val = state.data[i];
        byteEl.textContent = val.toString(16).padStart(2, '0');
        byteEl.dataset.offset = String(i);

        const fieldType = state.fieldMap[i];
        if (fieldType !== FieldType.None) {
          byteEl.classList.add(FIELD_CLASS[fieldType]);
        }

        // Check if this byte belongs to the selected frame
        if (state.selectedFrameIndex !== null) {
          const frame = state.frames[state.selectedFrameIndex];
          if (frame && i >= frame.offset && i < frame.offset + 20) {
            byteEl.classList.add('frame-selected');
          }
        }

        byteEl.addEventListener('click', () => {
          this.callbacks.onByteClick(i);
        });
        byteEl.addEventListener('mouseenter', (e) => {
          this.callbacks.onByteHover(i, e.clientX, e.clientY);
        });
        byteEl.addEventListener('mouseleave', () => {
          this.callbacks.onHoverEnd();
        });
      } else {
        byteEl.textContent = '  ';
      }

      bytesEl.appendChild(byteEl);
    }
    row.appendChild(bytesEl);

    // ASCII column
    const asciiEl = document.createElement('span');
    asciiEl.className = 'hex-ascii';
    let asciiStr = '';
    for (let i = startOffset; i < startOffset + BYTES_PER_ROW; i++) {
      if (i < endOffset) {
        const v = state.data[i];
        asciiStr += (v >= 0x20 && v <= 0x7e) ? String.fromCharCode(v) : '.';
      } else {
        asciiStr += ' ';
      }
    }
    asciiEl.textContent = asciiStr;
    row.appendChild(asciiEl);

    return row;
  }

  private refreshSelection(): void {
    // Rebuild visible rows to update selection highlight
    const start = this.visibleStart;
    const end = this.visibleEnd;
    this.visibleStart = -1;
    this.visibleEnd = -1;
    this.clearPool();
    this.visibleStart = start;
    this.visibleEnd = end;
    // Force re-render
    this.visibleStart = -1;
    this.visibleEnd = -1;
    this.render();
  }

  /**
   * Build a tooltip string for the byte at the given offset.
   */
  getTooltip(offset: number): string | null {
    if (!this.state) return null;
    const { fieldMap, data, frames } = this.state;

    const fieldType = fieldMap[offset];
    if (fieldType === FieldType.None) return null;

    const label = FIELD_LABELS[fieldType] || '';

    // Find which frame this byte belongs to
    let frame: ParsedFrame | null = null;
    // Linear search is fine for tooltip (rare interaction)
    for (const f of frames) {
      if (offset >= f.offset && offset < f.offset + 20) {
        frame = f;
        break;
      }
    }

    if (!frame) return `${label}\n0x${data[offset].toString(16).padStart(2, '0')}`;

    switch (fieldType) {
      case FieldType.Marker:
        return 'Frame marker A0 7B 42';

      case FieldType.Tick:
        return `Tick: ${frame.tick} (0x${frame.tick.toString(16).padStart(4, '0')})`;

      case FieldType.FrameType:
        return `Type: ${frame.frameTypeHex}\nPlayer ${frame.playerIndex} | Base 0x${frame.baseType.toString(16).padStart(2, '0')} | Subtype ${frame.subtypeHex}`;

      case FieldType.FormatByte:
        return `Format: 0x${frame.formatByte.toString(16).padStart(2, '0')}`;

      case FieldType.DataPos:
        return `Position data\nd0=0x${frame.dataBytes[0].toString(16).padStart(2, '0')} d1=0x${frame.dataBytes[1].toString(16).padStart(2, '0')} d2=0x${frame.dataBytes[2].toString(16).padStart(2, '0')} d3=0x${frame.dataBytes[3].toString(16).padStart(2, '0')}\nc1=${frame.coord1} c2=${frame.coord2}`;

      case FieldType.DataState:
        return `State data\nd0=0x${frame.dataBytes[0].toString(16).padStart(2, '0')} d1=0x${frame.dataBytes[1].toString(16).padStart(2, '0')} d2=0x${frame.dataBytes[2].toString(16).padStart(2, '0')} d3=0x${frame.dataBytes[3].toString(16).padStart(2, '0')}`;

      case FieldType.DataExt: {
        const dIdx = offset - frame.offset - 10;
        return `Extended data byte d${dIdx}\n0x${data[offset].toString(16).padStart(2, '0')}`;
      }

      default:
        return `0x${data[offset].toString(16).padStart(2, '0')}`;
    }
  }
}
