import { it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
const { TrainingStore } = createRequire(import.meta.url)('./trainingStore');
it('persists bounded history, de-duplicates attempts and keeps reset separate from deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chessbot-training-'));
  try {
    const file = join(dir, 'history.json'),
      store = new TrainingStore(file);
    for (let i = 0; i < 502; i++)
      store.add('one', { id: String(i), correct: true, assisted: i % 2 === 0 });
    expect(store.add('one', { id: '501', correct: false })).toBe(false);
    expect(store.history()).toHaveLength(500);
    store.reset('one');
    expect(store.history()).toHaveLength(500);
    expect(store.stats('one').total).toBe(0);
    await store.save();
    const restored = new TrainingStore(file);
    expect(restored.history()).toHaveLength(500);
    restored.delete('501');
    expect(restored.history()).toHaveLength(499);
    restored.clear();
    expect(restored.history()).toHaveLength(0);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('chessbot-training-'));
    await rm(dir, { recursive: true, force: true });
  }
});
