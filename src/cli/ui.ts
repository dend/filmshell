/**
 * Centralized TUI module for FilmShell CLI
 * Claude Code-inspired modern terminal UI with gradient spinners,
 * boxed panels, and structured output helpers.
 * Zero-dependency — raw ANSI escape codes only.
 */

// ─── ANSI Color Helpers ─────────────────────────────────────────────────────

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
export const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Apply 24-bit true color foreground */
function rgb(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// ─── Gradient Engine ────────────────────────────────────────────────────────

/** Convert HSL to RGB (h in degrees, s/l in 0-1) */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1: number, g1: number, b1: number;
  if (h < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/** Get gradient color cycling hues 180-300 (cyan→blue→magenta) */
function gradientColor(tick: number): [number, number, number] {
  const hue = 180 + ((tick * 3) % 120); // cycle 180-300
  return hslToRgb(hue, 0.8, 0.65);
}

// ─── Spinner ────────────────────────────────────────────────────────────────

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

const isTTY = process.stdout.isTTY === true;

/** Hide cursor */
function hideCursor(): void {
  if (isTTY) process.stdout.write('\x1b[?25l');
}

/** Show cursor */
function showCursor(): void {
  if (isTTY) process.stdout.write('\x1b[?25h');
}

/** Clear current line and move to start */
function clearLine(): void {
  if (isTTY) process.stdout.write('\x1b[2K\r');
}

export class Spinner {
  private text: string;
  private frameIndex = 0;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(text: string = '') {
    this.text = text;
  }

  start(text?: string): this {
    if (text !== undefined) this.text = text;

    if (!isTTY) {
      console.log(this.text);
      return this;
    }

    this.active = true;
    hideCursor();
    this.render();
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_FRAMES.length;
      this.tick++;
      this.render();
    }, SPINNER_INTERVAL);

    return this;
  }

  update(text: string): void {
    this.text = text;
    if (!isTTY) {
      console.log(text);
      return;
    }
    if (this.active) this.render();
  }

  private render(): void {
    const frame = BRAILLE_FRAMES[this.frameIndex];
    const [r, g, b] = gradientColor(this.tick);
    const coloredFrame = rgb(r, g, b, frame);
    clearLine();
    process.stdout.write(`  ${coloredFrame} ${dim(this.text)}`);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    if (isTTY) {
      clearLine();
      showCursor();
    }
  }

  succeed(text?: string): void {
    this.stop();
    const msg = text ?? this.text;
    console.log(`  ${green('✔')} ${msg}`);
  }

  fail(text?: string): void {
    this.stop();
    const msg = text ?? this.text;
    console.log(`  ${red('✖')} ${msg}`);
  }

  warn(text?: string): void {
    this.stop();
    const msg = text ?? this.text;
    console.log(`  ${yellow('⚠')} ${msg}`);
  }
}

// Ensure cursor is restored on exit
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const restore = () => showCursor();
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
}

registerCleanup();

// ─── Box Drawing ────────────────────────────────────────────────────────────

interface BoxOptions {
  title?: string;
  borderColor?: (s: string) => string;
  style?: 'single' | 'double';
  width?: number;
}

const BOX_CHARS = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
};

/** Strip ANSI escape codes to measure visible length */
function stripAnsi(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function box(lines: string[], options: BoxOptions = {}): void {
  const { title, borderColor = cyan, style = 'single' } = options;
  const chars = BOX_CHARS[style];

  // Calculate width from content or option
  const contentWidths = lines.map(l => stripAnsi(l));
  const titleWidth = title ? stripAnsi(title) + 2 : 0; // +2 for spacing around title
  const innerWidth = options.width ?? Math.max(...contentWidths, titleWidth, 40);

  // Top border
  let topBar: string;
  if (title) {
    const titleStr = ` ${title} `;
    const totalBar = innerWidth + 2; // must match content width between │ and │
    const remaining = totalBar - stripAnsi(titleStr);
    const leftPad = Math.max(1, Math.floor(remaining / 2));
    const rightPad = Math.max(1, remaining - leftPad);
    topBar = borderColor(chars.tl + chars.h.repeat(leftPad)) + bold(titleStr) + borderColor(chars.h.repeat(rightPad) + chars.tr);
  } else {
    topBar = borderColor(chars.tl + chars.h.repeat(innerWidth + 2) + chars.tr);
  }

  console.log(topBar);

  // Content lines
  for (const line of lines) {
    const visLen = stripAnsi(line);
    const pad = Math.max(0, innerWidth - visLen);
    console.log(`${borderColor(chars.v)} ${line}${' '.repeat(pad)} ${borderColor(chars.v)}`);
  }

  // Bottom border
  console.log(borderColor(chars.bl + chars.h.repeat(innerWidth + 2) + chars.br));
}

// ─── Structured Output Helpers ──────────────────────────────────────────────

/** Print a section header */
export function header(text: string): void {
  console.log('');
  console.log(bold(text));
}

/** Print a labeled detail line */
export function detail(label: string, value: string): void {
  console.log(`  ${dim(label + ':')} ${value}`);
}

/** Print a numbered step header */
export function step(n: number, text: string): void {
  console.log('');
  const [r, g, b] = gradientColor(n * 15);
  console.log(`${rgb(r, g, b, `[${n}]`)} ${bold(text)}`);
}

/** Print a success message */
export function success(text: string): void {
  console.log(`  ${green('✔')} ${text}`);
}

/** Print a warning message */
export function warning(text: string): void {
  console.log(`  ${yellow('⚠')} ${text}`);
}

/** Print an error message */
export function error(text: string): void {
  console.log(`  ${red('✖')} ${text}`);
}

/** Print an info message */
export function info(text: string): void {
  console.log(`  ${cyan('ℹ')} ${text}`);
}

/** Print a blank line */
export function gap(): void {
  console.log('');
}
