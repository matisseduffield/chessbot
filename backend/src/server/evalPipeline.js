'use strict';
// @ts-check

/** Book/cache/engine evaluation for one scheduler-owned request.
 * The caller serializes all engine operations and supplies cancellation checks.
 * Mutable resources are read through getters after ownership is acquired.
 */

const { parseFen } = require('@chessbot/shared');

/**
 * @typedef {{
 *   config: any,
 *   getBook: () => { lookup(fen: string): Promise<string|null>, enabled: boolean, bookPath?: string },
 *   lichessLookup: (fen: string) => Promise<string|null>,
 *   enrichLines: (lines: any[], fen: string) => any[],
 *   getCachedEval: (fen: string, variant: string, depth: number, multiPV: number) => any,
 *   getCachedEvalAtLeast: (fen: string, variant: string, depth: number, multiPV: number) => any,
 *   setCachedEval: (fen: string, variant: string, depth: number, multiPV: number, value: any) => void,
 *   getEngine: () => any,
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
    getBook,
    lichessLookup,
    enrichLines,
    getCachedEval,
    getCachedEvalAtLeast,
    setCachedEval,
    getEngine,
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

    const book = getBook();
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
    if (isStandard && moveNumber <= 15 && !searchOptions.training) {
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
    const cacheVariant =
      evalVariant +
      '|' +
      require('../engine/cacheIdentity').cacheIdentity(
        config.stockfishPath,
        engine.getSettings(),
        searchOptions,
      );
    if (depth > 0) {
      // First try the exact depth, then fall back to any deeper cached
      // entry (deeper analysis subsumes shallower at the same position).
      let cached = getCachedEval(fen, cacheVariant, depth, multiPV);
      let cachedFromDepth = depth;
      if (!cached) {
        const fallback = getCachedEvalAtLeast(fen, cacheVariant, depth, multiPV);
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
          depth: cached.depth || cachedFromDepth,
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

    // The scheduler owns the engine until this request settles.
    {
      if (gen !== getEvalGeneration() || ws.readyState !== ws.OPEN) return;

      // Send engine progress updates to panel.
      let _lastProgressDepth = 0;
      const liveStream = !!config.liveEngineStream;
      const liveStreamMinDepth = Number(config.liveEngineStreamMinDepth) || 6;
      searchOptions.onInfo = (/** @type {any} */ info) => {
        if (gen !== getEvalGeneration() || ws.readyState !== ws.OPEN) return;
        const d = info.depth || 0;
        const isFinalDepthMode = depth === 0;
        // Stream full PV updates when: (a) infinite analysis (existing
        // behaviour) OR (b) the panel has enabled live engine streaming
        // and the engine has reached a non-noisy depth.
        const shouldStreamPV = isFinalDepthMode || (liveStream && d >= liveStreamMinDepth);

        if (shouldStreamPV) {
          const enrichedLines = enrichLines(info.lines || [], fen);
          const infoMsg = {
            type: 'bestmove',
            bestmove: info.bestmove,
            lines: enrichedLines,
            source: 'engine',
            depth: d,
            targetDepth: isFinalDepthMode ? 0 : depth,
            fen,
            variant: evalVariant,
            eco: posEco ? posEco.name : null,
            ecoCode: posEco ? posEco.code : null,
            streaming: true,
          };
          safeSend(ws, infoMsg);
          broadcast(ws, infoMsg);
        }
        // Always emit lightweight progress for fixed-depth so the
        // "Depth N/M · K nps" indicator updates regardless of streaming.
        if (!isFinalDepthMode && d > _lastProgressDepth) {
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
      if (!result || result.crashed) {
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

      // A configured tablebase and a centipawn score do not prove root WDL.
      // Native probing remains enabled; reserve a result label for an explicit root probe.
      const tbResult = null;

      const engineMsg = {
        type: 'bestmove',
        bestmove: result.bestmove,
        ponder: result.ponder || null,
        lines: enrichedLines,
        source: 'engine',
        depth: result.lines?.length
          ? Math.min(...result.lines.map((/** @type {{depth?:number}} */ l) => l.depth || 0))
          : 0,
        requestedDepth: depth,
        fen,
        variant: evalVariant,
        eco: posEco ? posEco.name : null,
        ecoCode: posEco ? posEco.code : null,
        tablebase: tbResult,
      };
      // Cache the result for future lookups (skip infinite analysis).
      if (depth > 0 && result.bestmove && engineMsg.depth > 0) {
        setCachedEval(fen, cacheVariant, engineMsg.depth, multiPV, {
          depth: engineMsg.depth,
          bestmove: result.bestmove,
          ponder: result.ponder || null,
          lines: enrichedLines,
          tablebase: tbResult,
        });
      }
      safeSend(ws, engineMsg);
      broadcast(ws, engineMsg);
    }
  };
}

module.exports = { createEvalPipeline };
