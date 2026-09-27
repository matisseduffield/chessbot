import { PROTOCOL_VERSION } from '@chessbot/shared';
import './sessionUI.css';

// Adds session/review controls inside the existing Position and Training groups.
// No site interaction: previews only replace the dashboard's local render state.
export function createSessionUI({ state, render, toast, layout = () => {}, doc = document }) {
  const position =
    doc.querySelector('[data-section-id="position"]') ||
    doc.getElementById('fen-display').parentElement;
  const select = doc.createElement('select');
  select.id = 'board-session';
  select.setAttribute('aria-label', 'Board session');
  select.className = 'session-select';
  const sessionControl = doc.createElement('div');
  sessionControl.className = 'session-control';
  sessionControl.hidden = true;
  const sessionLabel = doc.createElement('label');
  sessionLabel.className = 'sub-label';
  sessionLabel.htmlFor = select.id;
  sessionLabel.textContent = 'Board';
  sessionControl.append(sessionLabel, select);
  position.appendChild(sessionControl);
  const section = doc.querySelector('[data-section-id="training"]');
  const details = doc.createElement('details');
  details.id = 'training-review';
  details.className = 'training-review';
  details.innerHTML = `
    <summary><span>Mistake review</span><span class="review-count" id="training-history-count">0</span></summary>
    <div class="review-body">
      <div class="review-latest"><div class="sub-label">Latest feedback</div><p id="training-feedback" role="status">Feedback appears after a training move.</p></div>
      <p class="review-muted" id="training-assisted">0 assisted · 0 unassisted attempts</p>
      <div class="review-filter"><label for="training-history-filter" class="sub-label">Saved history</label><select id="training-history-filter" class="session-select"><option value="mistakes">Mistakes & ungraded</option><option value="all">All attempts</option></select></div>
      <div id="training-attempts" class="review-list" role="region" aria-label="Saved training attempts" tabindex="0"></div>
      <div class="review-actions"><button class="panel-btn" id="more-attempts" hidden>Show more</button><button class="panel-btn review-quiet" id="clear-training-history" disabled>Clear history</button></div>
      <p class="review-muted">History is stored on this computer. Clearing it keeps your stats.</p>
    </div>`;
  section.appendChild(details);
  const previewNotice = doc.createElement('div');
  previewNotice.className = 'review-preview';
  previewNotice.hidden = true;
  previewNotice.innerHTML =
    '<span><strong>Reviewing a saved position</strong><span id="review-preview-label"></span></span><button class="panel-btn" id="return-live">Return to live board</button>';
  (doc.getElementById('left-col') || section).prepend(previewNotice);
  const confirmation = doc.createElement('dialog');
  confirmation.className = 'review-dialog';
  confirmation.setAttribute('role', 'alertdialog');
  confirmation.setAttribute('aria-labelledby', 'review-confirm-title');
  confirmation.setAttribute('aria-describedby', 'review-confirm-description');
  confirmation.innerHTML =
    '<form method="dialog"><h2 id="review-confirm-title">Clear saved history?</h2><p id="review-confirm-description"></p><div class="review-actions"><button class="panel-btn" value="cancel" autofocus>Cancel</button><button class="panel-btn" id="review-confirm-delete" value="confirm">Clear history</button></div></form>';
  doc.body.appendChild(confirmation);
  let confirmedAction = null;
  confirmation.addEventListener('close', () => {
    const action = confirmedAction;
    confirmedAction = null;
    if (confirmation.returnValue === 'confirm') action?.();
  });
  function confirmRemoval(title, description, label, action) {
    doc.getElementById('review-confirm-title').textContent = title;
    doc.getElementById('review-confirm-description').textContent = description;
    doc.getElementById('review-confirm-delete').textContent = label;
    confirmedAction = action;
    confirmation.returnValue = '';
    confirmation.showModal();
  }
  details.addEventListener('toggle', layout);
  let selected = null,
    live = null,
    reviewing = false,
    records = [],
    count = 20,
    seq = 0,
    pending = new Map();
  let refreshTimer = null;
  let liveFlipped = false;
  let liveGameInfo = null;
  let reviewId = null;
  const defaults = new Map(
    [...doc.querySelectorAll('input')].map((el) => [el, { checked: el.checked, value: el.value }]),
  );
  function hideAnswer() {
    if (reviewing) return;
    const data = state.currentData;
    state.currentData = {
      ...data,
      trainingHidden: true,
      bestmove: null,
      ponder: null,
      lines: (data.lines || [])
        .slice(0, 1)
        .map(({ score, mate, wdl, depth }) => ({ score, mate, wdl, depth })),
    };
    globalThis.speechSynthesis?.cancel();
    render();
  }
  doc.getElementById('chk-training-mode')?.addEventListener('change', (event) => {
    if (event.target.checked) hideAnswer();
  });
  const send = (frame) => {
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(frame));
  };
  select.addEventListener('change', () =>
    send({
      type: 'subscribe_session',
      sessionId: select.value || undefined,
      followFocus: !select.value,
    }),
  );
  doc.getElementById('clear-training-history').onclick = () =>
    confirmRemoval(
      'Clear saved history?',
      `Delete all ${records.length} saved attempts from this computer? This cannot be undone. Your statistics will stay unchanged.`,
      'Clear history',
      () => send({ type: 'clear_training_history' }),
    );
  function returnToLive() {
    reviewing = false;
    reviewId = null;
    state.boardFlipped = liveFlipped;
    if (liveGameInfo) state.gameInfo = liveGameInfo;
    previewNotice.hidden = true;
    if (live) {
      state.currentData = live;
      render();
    }
    renderHistory();
  }
  doc.getElementById('return-live').onclick = returnToLive;
  doc.getElementById('training-history-filter').onchange = () => {
    count = 20;
    renderHistory();
  };
  doc.getElementById('more-attempts').onclick = () => {
    count += 20;
    renderHistory();
  };
  function score(value) {
    return value?.mate != null
      ? `mate ${value.mate}`
      : value?.cp != null
        ? `${value.cp > 0 ? '+' : ''}${(value.cp / 100).toFixed(2)}`
        : '—';
  }
  function feedbackText(attempt) {
    const f = attempt.feedback || {};
    if (f.status === 'pending') return 'Evaluation pending…';
    if (f.status === 'unavailable' || f.status === 'ungraded')
      return f.reason || 'Evaluation unavailable.';
    if (!f.before || !f.after) return 'Evaluation unavailable.';
    return `Estimated ${score(f.before)} → ${score(f.after)}${f.lossCp != null ? ` · ${f.lossCp} cp loss` : ''}${f.mateTransition ? ' · mate transition' : ''} · depth ${f.beforeDepth}/${f.afterDepth}`;
  }
  const siteName = (site) =>
    ({ chesscom: 'Chess.com', lichess: 'Lichess', unknown: 'Chess board' })[site] ||
    site ||
    'Chess board';
  const variantName = (variant) => (variant === 'chess' || !variant ? 'Standard' : variant);
  const choiceText = (attempt) =>
    attempt.correct === null ? 'Ungraded' : attempt.correct ? 'Correct' : 'Mistake';
  function renderHistory() {
    const container = doc.getElementById('training-attempts');
    const scrollTop = container.scrollTop;
    container.replaceChildren();
    const all = doc.getElementById('training-history-filter').value === 'all';
    const filtered = all ? records : records.filter((a) => a.correct !== true);
    doc.getElementById('training-history-count').textContent = records.length;
    for (const attempt of filtered.slice(0, count)) {
      const row = doc.createElement('article');
      row.className = 'review-attempt';
      row.classList.toggle('is-reviewing', attempt.id === reviewId);
      const heading = doc.createElement('div');
      heading.className = 'review-attempt-heading';
      const status = doc.createElement('strong');
      status.textContent = choiceText(attempt);
      const assisted = doc.createElement('span');
      assisted.className = 'review-muted';
      assisted.textContent = attempt.assisted ? 'Assisted' : 'Unassisted';
      heading.append(status, assisted);
      const meta = doc.createElement('p');
      meta.className = 'review-muted';
      meta.textContent = `${new Date(attempt.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${siteName(attempt.site)} · ${variantName(attempt.variant)}`;
      const moves = doc.createElement('p');
      moves.className = 'review-moves';
      moves.textContent = `Played ${attempt.playedMove || 'unverified'} · Suggested ${attempt.recommendation || '—'}`;
      const text = doc.createElement('p');
      text.className = 'review-muted';
      text.textContent = feedbackText(attempt);
      const actions = doc.createElement('div');
      actions.className = 'review-actions';
      const preview = doc.createElement('button');
      preview.className = 'panel-btn';
      preview.textContent = 'Review position';
      preview.setAttribute('aria-pressed', String(attempt.id === reviewId));
      preview.onclick = () => {
        if (!reviewing) {
          live = state.currentData;
          liveFlipped = !!state.boardFlipped;
          liveGameInfo = state.gameInfo;
        }
        reviewing = true;
        reviewId = attempt.id;
        state.boardFlipped = attempt.player === 'b';
        state.gameInfo = { white: {}, black: {}, moveNumber: 0 };
        previewNotice.hidden = false;
        doc.getElementById('review-preview-label').textContent =
          `${siteName(attempt.site)} · ${variantName(attempt.variant)} · ${choiceText(attempt)}`;
        state.currentData = {
          fen: attempt.before,
          variant: attempt.variant,
          source: 'review',
          bestmove: attempt.recommendation,
          flipped: attempt.player === 'b',
          lines: [
            {
              move: attempt.recommendation,
              pv: attempt.feedback?.continuation?.length
                ? attempt.feedback.continuation
                : [attempt.recommendation],
            },
          ],
        };
        state.selectedPV = 1;
        render();
        renderHistory();
        doc.getElementById('return-live').focus();
      };
      const remove = doc.createElement('button');
      remove.className = 'panel-btn review-quiet';
      remove.textContent = 'Delete';
      remove.setAttribute(
        'aria-label',
        `Delete attempt: ${attempt.playedMove || 'unverified'} on ${new Date(attempt.timestamp).toLocaleDateString()}`,
      );
      remove.onclick = () =>
        confirmRemoval(
          'Delete this attempt?',
          'Remove this saved attempt? This cannot be undone. Your statistics will stay unchanged.',
          'Delete attempt',
          () => send({ type: 'delete_training_attempt', id: attempt.id }),
        );
      actions.append(preview, remove);
      row.append(heading, meta, moves, text, actions);
      container.appendChild(row);
    }
    container.scrollTop = scrollTop;
    doc.getElementById('more-attempts').hidden = filtered.length <= count;
    doc.getElementById('clear-training-history').disabled = !records.length;
    if (!filtered.length) {
      const empty = doc.createElement('p');
      empty.className = 'review-empty';
      empty.textContent = records.length
        ? 'No mistakes saved. Choose All attempts to review your correct moves.'
        : 'Play a move with Training mode enabled to save your first attempt.';
      container.appendChild(empty);
    }
    const latest = records.find((a) => !selected || a.sessionId === selected);
    doc.getElementById('training-feedback').textContent = latest
      ? `${choiceText(latest)} · played ${latest.playedMove || 'unverified'}. ${feedbackText(latest)}`
      : 'Feedback appears after a training move.';
    layout();
  }
  function applyPreferences(msg) {
    const check = {
      set_training_mode: 'chk-training-mode',
      set_training_auto_reveal: 'chk-training-auto-reveal',
      set_training_sound: 'chk-training-sound',
      set_training_strict: 'chk-training-strict',
      set_auto_move: 'chk-auto-move',
      set_bullet_mode: 'chk-bullet-mode',
      set_voice: 'chk-voice',
      set_voice_eval: 'chk-voice-eval',
      set_voice_opening: 'chk-voice-opening',
      set_show_opponent_response: 'chk-opponent-response',
      set_show_depth_overlay: 'chk-website-depth-overlay',
    };
    for (const [key, id] of Object.entries(check)) {
      const el = doc.getElementById(id),
        pref = msg.preferences?.[key];
      if (el) el.checked = pref ? !!pref.value : !!defaults.get(el)?.checked;
    }
    for (const [key, name] of Object.entries({
      set_training_difficulty: 'training-difficulty',
      set_display_mode: 'display-mode',
      set_run_engine_for: 'run-for',
    })) {
      const value = msg.preferences?.[key]?.value;
      for (const radio of doc.querySelectorAll(`input[name="${name}"]`))
        radio.checked = value != null ? radio.value === value : !!defaults.get(radio)?.checked;
    }
    const streaming = doc.getElementById('chk-live-engine-stream');
    if (streaming) streaming.checked = !!msg.liveEngineStream;
    const lichess = doc.getElementById('chk-lichess-book');
    if (lichess) lichess.checked = !!msg.lichessBook;
    const timeCheck = doc.getElementById('chk-time-limit'),
      timeSlider = doc.getElementById('time-slider');
    if (timeCheck) timeCheck.checked = !!msg.searchMovetime;
    if (timeSlider) {
      timeSlider.disabled = !msg.searchMovetime;
      if (msg.searchMovetime) {
        timeSlider.value = msg.searchMovetime;
        const value = doc.getElementById('time-value');
        if (value) value.textContent = msg.searchMovetime + 'ms';
      }
    }
    const setValue = (id, value) => {
      const el = doc.getElementById(id);
      if (el) {
        el.value = value ?? defaults.get(el)?.value;
        const label = doc.getElementById(id + '-value');
        if (label) label.textContent = el.value;
      }
    };
    setValue('auto-move-delay-min', msg.preferences?.set_auto_move_delay?.min);
    setValue('auto-move-delay-max', msg.preferences?.set_auto_move_delay?.max);
    setValue('voice-speed-slider', msg.preferences?.set_voice_speed?.value);
    state.voiceEnabled = !!doc.getElementById('chk-voice')?.checked;
    for (const [kind, value] of [
      ['movetime', msg.searchMovetime],
      ['nodes', msg.searchNodes],
    ]) {
      const chk = doc.getElementById(`chk-${kind}-limit`),
        input = doc.getElementById(`${kind}-input`);
      if (chk) chk.checked = !!value;
      if (input) {
        input.disabled = !value;
        if (value) input.value = value;
      }
    }
    const options = doc.getElementById('training-options');
    options?.classList.toggle('training-enabled', doc.getElementById('chk-training-mode')?.checked);
    options?.classList.toggle(
      'training-disabled-overlay',
      !doc.getElementById('chk-training-mode')?.checked,
    );
    for (const el of doc.querySelectorAll('select')) el._syncCustomUI?.();
  }
  return {
    connect(socket) {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        const msg = JSON.parse(data);
        if (msg.type !== 'hello' && msg.type !== 'subscribe_session')
          msg.sessionId = selected || undefined;
        msg.requestId ??= `panel-${++seq}`;
        if (
          [
            'set_option',
            'switch_engine',
            'switch_book',
            'switch_syzygy',
            'switch_variant',
            'set_live_engine_stream',
            'set_lichess_book',
            'broadcast',
          ].includes(msg.type)
        ) {
          const requestId = msg.requestId;
          pending.set(
            requestId,
            setTimeout(() => {
              pending.delete(requestId);
              toast('Setting was not confirmed; refreshing current settings.', 'warning');
              send({ type: 'get_settings' });
            }, 12000),
          );
        }
        nativeSend(JSON.stringify(msg));
      };
      send({ type: 'hello', client: 'panel', protocolVersion: PROTOCOL_VERSION });
      send({ type: 'get_training_history' });
    },
    applySettings: applyPreferences,
    consume(msg) {
      if (pending.has(msg.requestId)) {
        clearTimeout(pending.get(msg.requestId));
        pending.delete(msg.requestId);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => send({ type: 'get_settings' }), 100);
      }
      if (msg.type === 'sessions') {
        select.replaceChildren();
        const follow = doc.createElement('option');
        follow.value = '';
        follow.textContent = 'Follow focused board';
        select.appendChild(follow);
        for (const [index, session] of msg.sessions.entries()) {
          const opt = doc.createElement('option');
          opt.value = session.id;
          opt.textContent = `${siteName(session.site)} · ${variantName(session.variant)} · Board ${index + 1}`;
          select.appendChild(opt);
        }
        if (
          !msg.followFocus &&
          msg.selectedSessionId &&
          !msg.sessions.some((s) => s.id === msg.selectedSessionId)
        ) {
          const offline = doc.createElement('option');
          offline.value = msg.selectedSessionId;
          offline.textContent = 'Pinned board · disconnected';
          select.appendChild(offline);
        }
        select.value = msg.followFocus ? '' : msg.selectedSessionId || '';
        sessionControl.hidden = msg.sessions.length < 2 && msg.followFocus;
        layout();
        if (selected !== msg.selectedSessionId) {
          selected = msg.selectedSessionId;
          reviewing = false;
          reviewId = null;
          live = null;
          liveGameInfo = null;
          previewNotice.hidden = true;
          doc.getElementById('training-assisted').textContent =
            '0 assisted · 0 unassisted attempts';
          state.evalHistory = [];
          state.boardFlipped = false;
          state.gameInfo = { white: {}, black: {}, moveNumber: 0 };
          state.currentData = { fen: '8/8/8/8/8/8/8/8 w - - 0 1', lines: [] };
          render();
          renderHistory();
          send({ type: 'get_settings' });
          send({ type: 'get_training_history' });
        }
        return true;
      }
      if (msg.type === 'training_history') {
        records = msg.attempts || [];
        if (reviewId && !records.some((a) => a.id === reviewId)) returnToLive();
        renderHistory();
        return true;
      }
      if (msg.sessionId && selected && msg.sessionId !== selected) return true;
      if (msg.type === 'training_stats_update')
        doc.getElementById('training-assisted').textContent =
          `${msg.assisted || 0} assisted · ${msg.unassisted || 0} unassisted attempts`;
      if (msg.type === 'set_training_mode' && msg.value) hideAnswer();
      if (msg.type === 'bestmove') {
        live = msg;
        if (reviewing) return true;
      }
      if (reviewing && ['game_info', 'eval_progress'].includes(msg.type)) {
        if (msg.type === 'game_info') {
          liveGameInfo = { ...liveGameInfo, ...msg };
          if (msg.flipped !== undefined) liveFlipped = !!msg.flipped;
        }
        return true;
      }
      return false;
    },
    disconnect() {
      confirmedAction = null;
      if (confirmation.open) confirmation.close();
      clearTimeout(refreshTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
