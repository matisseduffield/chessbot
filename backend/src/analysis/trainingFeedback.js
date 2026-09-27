'use strict';
/** @typedef {{score?:number,mate?:number,depth?:number,pv?:string[]}} Line */
/** @typedef {{status:string,estimated?:boolean,reason?:string,beforeDepth?:number,afterDepth?:number,continuation?:string[],before?:{mate?:number,cp?:number}|null,after?:{mate?:number,cp?:number}|null,lossCp?:number,mateTransition?:boolean}} Feedback */
/** @param {Line|undefined} line @param {string} sideToMove @param {string} player */
function perspective(line, sideToMove, player) {
  const sign = sideToMove === player ? 1 : -1;
  if (typeof line?.mate === 'number') return { mate: line.mate * sign };
  if (typeof line?.score === 'number') return { cp: line.score * sign };
  return null;
}
/** @param {{evaluate:(fen:string,depth:number,options:{movetime:number})=>Promise<{lines?:Line[]}|null>}} engine
 * @param {{before:string,after:string,player:string,variant:string}} attempt
 * @param {()=>boolean} cancelled
 * @returns {Promise<Feedback>}
 */
async function trainingFeedback(engine, attempt, cancelled) {
  if (cancelled()) return { status: 'unavailable', reason: 'Live analysis took priority' };
  const before = await engine.evaluate(attempt.before, 15, { movetime: 1500 });
  if (cancelled()) return { status: 'unavailable', reason: 'Live analysis took priority' };
  const after = await engine.evaluate(attempt.after, 15, { movetime: 1500 });
  if (cancelled()) return { status: 'unavailable', reason: 'Live analysis took priority' };
  const b = before?.lines?.[0],
    a = after?.lines?.[0];
  /** @type {Feedback} */
  const result = {
    status: 'ready',
    estimated: true,
    beforeDepth: b?.depth || 0,
    afterDepth: a?.depth || 0,
    continuation: (b?.pv || []).slice(0, 8),
  };
  if (!b || !a)
    return {
      ...result,
      status: 'unavailable',
      reason: 'The engine did not return both evaluations',
    };
  if (!['chess', 'chess960'].includes(attempt.variant))
    return {
      ...result,
      status: 'ungraded',
      reason: 'Variant evaluation interpretation is not verified',
    };
  result.before = perspective(b, attempt.before.split(' ')[1], attempt.player);
  result.after = perspective(a, attempt.after.split(' ')[1], attempt.player);
  if (result.before?.cp != null && result.after?.cp != null)
    result.lossCp = Math.max(0, result.before.cp - result.after.cp);
  else if (result.before?.mate != null || result.after?.mate != null) result.mateTransition = true;
  return result;
}
module.exports = { trainingFeedback, perspective };
