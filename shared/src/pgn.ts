/**
 * PGN import/export — small, dependency-free.
 *
 * Not a full PGN parser (no variations, no NAGs beyond what we write).
 * Handles the 99% case for this app: import a game from chess.com /
 * lichess, analyse it, export with {[%eval ...]} comments so the file
 * round-trips into Lichess Studies. Plan §8.5.
 */

export interface PgnHeaders {
  [key: string]: string;
}

export interface ParsedPgn {
  headers: PgnHeaders;
  /** SAN moves in play order. Comments and annotations stripped. */
  moves: string[];
  result: string;
}

export interface AnnotatedMove {
  san: string;
  /** Score from White's perspective, in cp. */
  scoreCp?: number;
  /** Mate-in-N from the side-to-move perspective. */
  mate?: number;
  /** Optional move-quality symbol (`!`, `?`, `?!`, `??`). */
  nag?: string;
  /** Free-form comment. */
  comment?: string;
}

const HEADER_RE = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]$/;

export function parsePgn(text: string): ParsedPgn {
  const headers: PgnHeaders = {};
  const moveLines: string[] = [];

  const lines = text.split(/\r?\n/);
  let inMoves = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inMoves) {
      if (line === '') {
        if (Object.keys(headers).length > 0) inMoves = true;
        continue;
      }
      const m = HEADER_RE.exec(line);
      if (m) {
        headers[m[1]] = m[2];
        continue;
      }
      inMoves = true;
    }
    if (line) moveLines.push(line);
  }

  let body = moveLines.join(' ');
  body = body.replace(/\{[^}]*\}/g, ' ');
  body = body.replace(/\([^)]*\)/g, ' ');
  body = body.replace(/\$\d+/g, ' ');
  body = body.replace(/\d+\.(\.\.)?/g, ' ');

  const tokens = body.split(/\s+/).filter(Boolean);

  let result = headers.Result || '*';
  const resultTokens = new Set(['1-0', '0-1', '1/2-1/2', '*']);
  const moves: string[] = [];
  for (const tok of tokens) {
    if (resultTokens.has(tok)) {
      result = tok;
      break;
    }
    moves.push(tok);
  }

  return { headers, moves, result };
}

function formatEvalComment(m: AnnotatedMove): string | null {
  if (m.mate !== undefined) return `[%eval #${m.mate}]`;
  if (m.scoreCp !== undefined) return `[%eval ${(m.scoreCp / 100).toFixed(2)}]`;
  return null;
}

export function buildAnnotatedPgn(
  headers: PgnHeaders,
  moves: readonly AnnotatedMove[],
  result = '*',
): string {
  const out: string[] = [];
  const defaults: PgnHeaders = {
    Event: headers.Event ?? '?',
    Site: headers.Site ?? '?',
    Date: headers.Date ?? '????.??.??',
    Round: headers.Round ?? '?',
    White: headers.White ?? '?',
    Black: headers.Black ?? '?',
    Result: headers.Result ?? result,
  };
  const ordered = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  for (const k of ordered) out.push(`[${k} "${escapeHeader(defaults[k])}"]`);
  for (const [k, v] of Object.entries(headers)) {
    if (!ordered.includes(k)) out.push(`[${k} "${escapeHeader(v)}"]`);
  }
  out.push('');

  const body: string[] = [];
  moves.forEach((m, i) => {
    const ply = i;
    if (ply % 2 === 0) body.push(`${Math.floor(ply / 2) + 1}.`);
    const sanWithNag = m.nag ? `${m.san}${m.nag}` : m.san;
    body.push(sanWithNag);
    const parts: string[] = [];
    const evalComment = formatEvalComment(m);
    if (evalComment) parts.push(evalComment);
    if (m.comment) parts.push(m.comment);
    if (parts.length > 0) body.push(`{ ${parts.join(' ')} }`);
  });
  body.push(result);

  out.push(wrapLine(body.join(' '), 80));
  return out.join('\n') + '\n';
}

function escapeHeader(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function wrapLine(s: string, width: number): string {
  const words = s.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}
