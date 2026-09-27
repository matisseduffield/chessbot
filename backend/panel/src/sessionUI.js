import { PROTOCOL_VERSION } from '@chessbot/shared';

// Adds session/review controls inside the existing Position and Training groups.
// No site interaction: previews only replace the dashboard's local render state.
export function createSessionUI({ state, render, toast, layout = () => {}, doc = document }) {
  const position =
    doc.querySelector('[data-section-id="position"]') ||
    doc.getElementById('fen-display').parentElement;
  const select = doc.createElement('select');
  select.id = 'board-session';
  select.setAttribute('aria-label', 'Board session');
  select.style.cssText =
    'width:100%;margin:6px 0 0;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-card,#191e2a);color:inherit;font:inherit;font-size:11px';
  select.hidden = true;
  position.appendChild(select);
  const section = doc.querySelector('[data-section-id="training"]');
  const details = doc.createElement('details');
  details.id = 'training-review';
  details.style.cssText = 'margin-top:12px;font-size:11px;line-height:1.5';
  details.innerHTML =
    '<summary>Mistake review</summary><p id="training-feedback" role="status">Feedback appears after a training move.</p><p id="training-assisted"></p><button class="panel-btn" id="return-live" hidden>Return to live board</button><div id="training-attempts"></div><button class="panel-btn" id="more-attempts" hidden>Show more</button><button class="panel-btn" id="clear-training-history">Clear history</button>';
  section.appendChild(details);
  details.addEventListener('toggle', layout);
  let selected = null,
    live = null,
    reviewing = false,
    records = [],
    count = 20,
    seq = 0,
    pending = new Map();
  let refreshTimer = null;
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
    send({ type: 'clear_training_history' });
  doc.getElementById('return-live').onclick = () => {
    reviewing = false;
    doc.getElementById('return-live').hidden = true;
    if (live) {
      state.currentData = live;
      render();
    }
  };
  doc.getElementById('more-attempts').onclick = () => {
    count += 20;
    renderHistory();
  };
  function score(value) {
    return value?.mate != null
      ? `mate ${value.mate}`
      : value?.cp != null
        ? (value.cp / 100).toFixed(2)
        : '—';
  }
  function feedbackText(attempt) {
    const f = attempt.feedback || {};
    const choice = attempt.correct === null ? 'Ungraded' : attempt.correct ? 'Correct' : 'Mistake';
    const prefix = `${choice} · ${attempt.assisted ? 'assisted' : 'unassisted'} · played ${attempt.playedMove || 'unverified'} · suggested ${attempt.recommendation}`;
    if (f.status === 'pending') return `${prefix}. Feedback pending.`;
    if (f.status === 'unavailable' || f.status === 'ungraded')
      return `${prefix}. ${f.reason || 'Feedback unavailable'}.`;
    return `${prefix}. Estimated evaluation ${score(f.before)} → ${score(f.after)}${f.lossCp != null ? ` (${f.lossCp}cp loss)` : ''}${f.mateTransition ? ' · mate transition' : ''}. Depth ${f.beforeDepth}/${f.afterDepth}.`;
  }
  function renderHistory() {
    const container = doc.getElementById('training-attempts');
    container.replaceChildren();
    const mistakes = records.filter((a) => a.correct !== true);
    for (const attempt of mistakes.slice(0, count)) {
      const row = doc.createElement('div');
      row.style.cssText = 'border-top:1px solid var(--border);padding:8px 0';
      const text = doc.createElement('p');
      text.textContent = `${new Date(attempt.timestamp).toLocaleString()} · ${attempt.site} · ${attempt.variant}. ${feedbackText(attempt)}`;
      const preview = doc.createElement('button');
      preview.className = 'panel-btn';
      preview.textContent = 'Review position';
      preview.onclick = () => {
        if (!reviewing) live = state.currentData;
        reviewing = true;
        doc.getElementById('return-live').hidden = false;
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
      };
      const remove = doc.createElement('button');
      remove.className = 'panel-btn';
      remove.textContent = 'Delete';
      remove.onclick = () => send({ type: 'delete_training_attempt', id: attempt.id });
      row.append(text, preview, remove);
      container.appendChild(row);
    }
    doc.getElementById('more-attempts').hidden = mistakes.length <= count;
    if (!mistakes.length) container.textContent = 'No recorded mistakes.';
    const latest = records.find((a) => !selected || a.sessionId === selected);
    doc.getElementById('training-feedback').textContent = latest
      ? feedbackText(latest)
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
        for (const session of msg.sessions) {
          const opt = doc.createElement('option');
          opt.value = session.id;
          opt.textContent = `${session.site} · ${session.variant} · ${session.id}`;
          select.appendChild(opt);
        }
        select.value = msg.followFocus ? '' : msg.selectedSessionId;
        select.hidden = msg.sessions.length < 2;
        layout();
        if (selected !== msg.selectedSessionId) {
          selected = msg.selectedSessionId;
          reviewing = false;
          live = null;
          doc.getElementById('return-live').hidden = true;
          state.evalHistory = [];
          state.gameInfo = { white: {}, black: {}, moveNumber: 0 };
          state.currentData = { fen: '8/8/8/8/8/8/8/8 w - - 0 1', lines: [] };
          render();
          send({ type: 'get_settings' });
          send({ type: 'get_training_history' });
        }
        return true;
      }
      if (msg.type === 'training_history') {
        records = msg.attempts || [];
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
      if (reviewing && ['game_info', 'eval_progress'].includes(msg.type)) return true;
      return false;
    },
    disconnect() {
      clearTimeout(refreshTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
