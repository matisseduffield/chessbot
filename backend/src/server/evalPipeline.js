'use strict';
// @ts-check

/**
 * Eval pipeline — the book → cache → engine cascade that runs inside
 * each evaluationQueue slot.
 *
 * Extracted from server.js (plan §2.1, P2.F) so the cascade can be
 * read end-to-end without scrolling past 600 lines of unrelated WS
 * handlers, and so the next refactor (per-connection queue extraction)
 * has a clean seam to land on.
 *
 * Contract:
 *   - The factory `createEvalPipeline(deps)` takes the stable backend
 *     dependencies (config, book, engine getter, cache helpers, etc.)
 *     once and returns a `runFen(ctx)` function.
 *   - `runFen(ctx)` runs the full cascade for one (fen, depth) request.
 *     The caller is responsible for chaining it onto the per-connection
 *     evaluationQueue Promise so requests serialise.
 *   - The caller has already snapshotted the variant + generation
 *     counters at enqueue time; the function takes them in `ctx` so the
 *     "is this result still wanted?" checks can be done correctly.
 *
 * Behaviour preserved exactly from the inline version. No tests yet —
 * the existing server.integration.test.js exercises this path
 * end-to-end through the live backend, which is the regression net for
 * this extraction.
 */

const { parseFen } = require('@chessbot/shared');

/**
 * @typedef {{
 *   config: any,
 *   book: { lookup(fen: string): Promise<string|null>, enabled: boolean, bookPath?: string },
 *   lichessLookup: (fen: string) => Promise<string|null>,
 *   enrichLines: (lines: any[], fen: string) => any[],
 *   acquireEvalLock: () => Promise<() => void>,
 *   getCachedEval: (fen: string, variant: string, depth: number, multiPV: number) => any,
 *   getCachedEvalAtLeast: (fen: string, variant: string, depth: number, multiPV: number) => any,
 *   setCachedEval: (fen: string, variant: string, depth: number, multiPV: number, value: any) => void,
 *   getEngine: () => any,
 *   getEngineSwitchPromise: () => (Promise<any> | null),
 *   broadcast: (senderWs: any, msg: any) => void,
 *   safeSend: (ws: any, msg: any) => boolean,
 *   getEco: (fen: string) => any,
 *   log?: { info: Function, warn: Function, error: Function },
 * }} EvalPipelineDeps
 *
 * @typedef {{
 *   ws: any,
 *   fen: string,
 *   depth: number,
 *   searchOptions: any,
 *   evalVariant: string,
 *   gen: number,
 *   variantGen: number,
 *   getEvalGeneration: () => number,
 *   getGlobalVariantGen: () => number,
 * }} FenContext
 */

/**
 * @param {EvalPipelineDeps} deps
 */
function createEvalPipeline(deps) {
  const {
    config,
    book,
    lichessLookup,
    enrichLines,
    acquireEvalLock,
    getCachedEval,
    getCachedEvalAtLeast,
    setCachedEval,
    getEngine,
    getEngineSwitchPromise,
    broadcast,
    safeSend,
    getEco,
  } = deps;
  const log = deps.log || console;

  /** @param {FenContext} ctx */
  return async function runFen(ctx) {
    const {
      ws,
      fen,
      depth,
      searchOptions,
      evalVariant,
      gen,
      variantGen,
      getEvalGeneration,
      getGlobalVariantGen,
    } = ctx;

    // If client disconnected, bail — prevents stale queue handlers
    // from racing with a new client's evaluations on the shared engine.
    if (ws.readyState !== ws.OPEN) return;

    const engine = getEngine();

    // Abort any in-progress evaluation now that we own the queue slot.
    await engine.abort();

    // If an engine/variant switch is in progress, wait for it.
    const inFlightSwitch = getEngineSwitchPromise();
    if (inFlightSwitch) {
      log.info(`[server] eval gen ${gen} waiting for engine switch to complete...`);
      await inFlightSwitch;
    }

    // If a newer FEN arrived or variant switched since we queued, skip.
    if (gen !== getEvalGeneration() || variantGen !== getGlobalVariantGen()) {
      log.info(
        `[server] skipping stale eval gen ${gen} (current: ${getEvalGeneration()}, variantGen: ${variantGen}→${getGlobalVariantGen()})`,
      );
      return;
    }

    // Look up ECO for current position (standard chess only).
    const isStandard = evalVariant === 'chess' || evalVariant === 'chess960';
    const posEco = isStandard ? getEco(fen) : null;

    // Try opening book first (standard chess only, skip for deep positions).
    const moveNumber = parseFen(fen)?.fullmove ?? 1;
    if (isStandard && moveNumber <= 15) {
      const bookMove = await book.lookup(fen);
      if (bookMove) {
        if (gen !== getEvalGeneration()) return;
        log.info(`[server] → bestmove (book): ${bookMove}`);
        const bookMsg = {
          type: 'bestmove',
          bestmove: bookMove,
          source: 'book',
          fen,
          variant: evalVariant,
          eco: posEco ? posEco.name : null,
          ecoCode: posEco ? posEco.code : null,
        };
        safeSend(ws, bookMsg);
        broadcast(ws, bookMsg);
        return;
      }

      // Try Lichess opening explorer as fallback.
      const lichessMove = await lichessLookup(fen);
      if (lichessMove) {
        if (gen !== getEvalGeneration()) return;
        log.info(`[server] → bestmove (lichess): ${lichessMove}`);
        const lichessMsg = {
          type: 'bestmove',
          bestmove: lichessMove,
          source: 'lichess',
          fen,
          variant: evalVariant,
          eco: posEco ? posEco.name : null,
          ecoCode: posEco ? posEco.code : null,
        };
        safeSend(ws, lichessMsg);
        broadcast(ws, lichessMsg);
        return;
      }
    }

    // Fall back to Stockfish — check eval cache first (skip for infinite analysis).
    const multiPV = Number(engine.getSettings().MultiPV) || 1;
    if (depth > 0) {
      // First try the exact depth, then fall back to any deeper cached
      // entry (deeper analysis subsumes shallower at the same position).
      let cached = getCachedEval(fen, evalVariant, depth, multiPV);
      let cachedFromDepth = depth;
      if (!cached) {
        const fallback = getCachedEvalAtLeast(fen, evalVariant, depth, multiPV);
        if (fallback) {
          cached = fallback.result;
          cachedFromDepth = fallback.depth;
          log.info(`[server] cache depth-fallback: requested ${depth}, served ${cachedFromDepth}`);
        }
      }
      if (cached) {
        log.info(`[server] → bestmove (cache): ${cached.bestmove}`);
        const cacheMsg = {
          type: 'bestmove',
          bestmove: cached.bestmove,
          lines: cached.lines,
          source: 'engine',
          fen,
          variant: evalVariant,
          eco: posEco ? posEco.name : null,
          ecoCode: posEco ? posEco.code : null,
          tablebase: cached.tablebase,
          cached: true,
          // Set when we satisfied the request from a deeper cached
          // entry; clients can render a small badge.
          ...(cachedFromDepth > depth ? { cachedFromDepth } : {}),
        };
        safeSend(ws, cacheMsg);
        broadcast(ws, cacheMsg);
        return;
      }
    }

    // Acquire global lock to prevent cross-client interleave.
    const releaseEval = await acquireEvalLock();
    try {
      if (gen !== getEvalGeneration() || ws.readyState !== ws.OPEN) return;

      // Send engine progress updates to panel.
      let _lastProgressDepth = 0;
      searchOptions.onInfo = (/** @type {any} */ info) => {
        if (gen !== getEvalGeneration() || ws.readyState !== ws.OPEN) return;
        const d = info.depth || 0;
        if (depth === 0) {
          // For infinite analysis, send full intermediate results.
          const enrichedLines = enrichLines(info.lines || [], fen);
          const infoMsg = {
            type: 'bestmove',
            bestmove: info.bestmove,
            lines: enrichedLines,
            source: 'engine',
            depth: d,
            fen,
            variant: evalVariant,
            eco: posEco ? posEco.name : null,
            ecoCode: posEco ? posEco.code : null,
            streaming: true,
          };
          safeSend(ws, infoMsg);
          broadcast(ws, infoMsg);
        } else if (d > _lastProgressDepth) {
          // For fixed-depth analysis, send lightweight progress.
          _lastProgressDepth = d;
          const first = (info.lines && info.lines[0]) || {};
          const progressMsg = {
            type: 'eval_progress',
            depth: d,
            targetDepth: depth,
            nodes: first.nodes || null,
            nps: first.nps || null,
            fen,
          };
          safeSend(ws, progressMsg);
          broadcast(ws, progressMsg);
        }
      };

      // Only set infinite if there's no movetime/nodes limit.
      if (depth === 0 && !searchOptions.movetime && !searchOptions.nodes) {
        searchOptions.infinite = true;
      }
      let result = await engine.evaluate(fen, depth, searchOptions);
      // Check again after eval finishes — a newer FEN may have arrived.
      if (gen !== getEvalGeneration()) {
        log.info(`[server] discarding stale result gen ${gen}`);
        return;
      }

      // If engine crashed due to a corrupt Syzygy tablebase, disable
      // Syzygy and retry once so the user gets a valid move instead of
      // a hang.
      if (
        result &&
        result.crashed &&
        result.reason &&
        result.reason.startsWith('corrupt_tablebase')
      ) {
        const corruptFile = result.reason.split(':').slice(1).join(':');
        log.error(
          `[server] engine crashed: corrupt tablebase file ${corruptFile} — disabling Syzygy and retrying`,
        );
        safeSend(ws, {
          type: 'warning',
          code: 'corrupt_tablebase',
          message: `Corrupt Syzygy tablebase file detected (${corruptFile}). Syzygy has been disabled for this session; re-download the file to restore it.`,
          file: corruptFile,
        });
        try {
          await engine.setOption('SyzygyPath', '<empty>');
          config.syzygyPath = null;
        } catch (e) {
          log.error(
            '[server] failed to disable Syzygy after crash:',
            e instanceof Error ? e.message : String(e),
          );
        }
        if (gen === getEvalGeneration()) {
          result = await engine.evaluate(fen, depth, searchOptions);
          if (gen !== getEvalGeneration()) {
            log.info(`[server] discarding stale retry result gen ${gen}`);
            return;
          }
        }
      }

      // If engine still crashed / returned null, surface a proper
      // error instead of silently sending bestmove:null (which hangs
      // the client).
      if (!result || !result.bestmove) {
        log.error(
          `[server] null bestmove (crashed=${result?.crashed}, reason=${result?.reason || 'unknown'})`,
        );
        safeSend(ws, {
          type: 'error',
          code: result?.crashed ? 'engine_crash' : 'engine_no_move',
          message: result?.crashed
            ? `Engine crashed during analysis (${result.reason || 'unknown'}). The engine has been restarted — try again.`
            : 'Engine returned no move for this position.',
          fen,
        });
        return;
      }

      const enrichedLines = enrichLines(result.lines || [], fen);
      log.info(`[server] → bestmove (engine): ${result.bestmove}`);

      // Endgame tablebase classification.
      let tbResult = null;
      if (config.syzygyPath && isStandard) {
        const pieceCount = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
        if (pieceCount <= 7 && result.lines && result.lines[0]) {
          const line = result.lines[0];
          const score = line.score;
          const mate = line.mate;
          if (mate !== undefined && mate !== null) {
            tbResult = mate > 0 ? 'win' : 'loss';
          } else if (score !== undefined && score !== null) {
            if (Math.abs(score) >= 9000) tbResult = score > 0 ? 'win' : 'loss';
            else if (Math.abs(score) <= 5) tbResult = 'draw';
            else tbResult = score > 0 ? 'win' : 'loss';
          }
        }
      }

      const engineMsg = {
        type: 'bestmove',
        bestmove: result.bestmove,
        ponder: result.ponder || null,
        lines: enrichedLines,
        source: 'engine',
        fen,
        variant: evalVariant,
        eco: posEco ? posEco.name : null,
        ecoCode: posEco ? posEco.code : null,
        tablebase: tbResult,
      };
      // Cache the result for future lookups (skip infinite analysis).
      if (depth > 0 && result.bestmove) {
        setCachedEval(fen, evalVariant, depth, multiPV, {
          bestmove: result.bestmove,
          ponder: result.ponder || null,
          lines: enrichedLines,
          tablebase: tbResult,
        });
      }
      safeSend(ws, engineMsg);
      broadcast(ws, engineMsg);
    } finally {
      releaseEval();
    }
  };
}

module.exports = { createEvalPipeline };
