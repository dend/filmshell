import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Vite plugin that serves film data from the films/ directory.
 *
 * GET /api/films          → JSON list of available films with metadata
 * GET /api/films/:guid/:chunk  → Raw binary chunk data
 */
function filmsPlugin(): Plugin {
  const filmsDir = resolve('films');

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

  function scanFilms(): FilmEntry[] {
    if (!existsSync(filmsDir)) return [];

    const entries: FilmEntry[] = [];
    for (const name of readdirSync(filmsDir)) {
      const dir = join(filmsDir, name);
      if (!statSync(dir).isDirectory()) continue;

      // Count chunks
      let chunks = 0;
      let totalSize = 0;
      for (let i = 0; i < 20; i++) {
        const chunkPath = join(dir, `filmChunk${i}_dec`);
        if (existsSync(chunkPath)) {
          chunks++;
          totalSize += statSync(chunkPath).size;
        } else {
          break;
        }
      }
      if (chunks === 0) continue;

      // Read metadata
      let players = 0;
      let duration = '';
      let filmLengthMs = 0;
      let startTime = '';
      let mapAssetId = '';

      const matchMeta = join(dir, 'match-metadata.json');
      if (existsSync(matchMeta)) {
        try {
          const mm = JSON.parse(readFileSync(matchMeta, 'utf-8'));
          players = (mm.Players || []).length;
          duration = mm.MatchInfo?.Duration || '';
          startTime = mm.MatchInfo?.StartTime || '';
          mapAssetId = mm.MatchInfo?.MapVariant?.AssetId || '';
        } catch { /* ignore */ }
      }

      const filmMeta = join(dir, 'film-metadata.json');
      if (existsSync(filmMeta)) {
        try {
          const fm = JSON.parse(readFileSync(filmMeta, 'utf-8'));
          filmLengthMs = fm.CustomData?.FilmLength || 0;
        } catch { /* ignore */ }
      }

      entries.push({
        matchId: name,
        chunks,
        totalSize,
        players,
        duration,
        filmLengthMs,
        startTime,
        mapAssetId,
      });
    }

    return entries.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  return {
    name: 'films-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/films') {
          const films = scanFilms();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(films));
          return;
        }

        // /api/films/:guid/filmChunk0_dec
        const chunkMatch = req.url?.match(/^\/api\/films\/([a-f0-9-]+)\/filmChunk(\d+)_dec$/);
        if (chunkMatch) {
          const [, guid, idx] = chunkMatch;
          const chunkPath = join(filmsDir, guid, `filmChunk${idx}_dec`);
          if (existsSync(chunkPath)) {
            const data = readFileSync(chunkPath);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(data.length));
            res.end(data);
            return;
          }
          res.statusCode = 404;
          res.end('Chunk not found');
          return;
        }

        // /api/films/:guid/objects.json
        const objMatch = req.url?.match(/^\/api\/films\/([a-f0-9-]+)\/objects\.json$/);
        if (objMatch) {
          const [, guid] = objMatch;
          const objPath = join(filmsDir, guid, 'objects.json');
          if (existsSync(objPath)) {
            const data = readFileSync(objPath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(data);
            return;
          }
          res.statusCode = 404;
          res.end('objects.json not found');
          return;
        }

        // Rewrite /aim to /aim.html for SPA-style navigation
        // Must match exactly "/aim" or "/aim?..." — not "/aim-main.ts" etc.
        if (req.url === '/aim' || req.url?.startsWith('/aim?')) {
          req.url = '/aim.html' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: 'src/viewer',
  build: {
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve('src/viewer/index.html'),
        aim: resolve('src/viewer/aim.html'),
      },
    },
  },
  plugins: [filmsPlugin()],
});
