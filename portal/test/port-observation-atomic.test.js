import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPortObservations } from '../src/internal.js';
function fake(fail = false) {
  const calls = []; let committed = [1000]; let working;
  const client = { release() { calls.push('RELEASE'); }, async query(sql, values) {
    calls.push(sql);
    if (sql === 'BEGIN') working = [...committed];
    else if (sql === 'COMMIT') committed = working;
    else if (sql === 'ROLLBACK') working = undefined;
    else if (sql.startsWith('SELECT port')) return { rows: working.map(port => ({ port })) };
    else if (sql.startsWith('DELETE')) working = [];
    else if (sql.includes('INSERT INTO port_observations')) {
      if (fail && values[2] === 3000) throw new Error('synthetic insert failure');
      working.push(values[2]);
      assert.deepEqual(committed, [1000], 'uncommitted partial snapshot is not visible');
    }
    return { rows: [] };
  } };
  return { calls, get committed() { return committed; }, pool: { connect: async () => client, query: async () => ({ rows: [{ revision: 1 }] }) } };
}
test('listener snapshot replacement is one transaction with per-container lock', async () => {
  const f = fake();
  await recordPortObservations(f.pool, { container: { id: 'c1' }, user: { id: 'u1' }, listeners: [{ port: 2000 }, { port: 3000 }], log: { warn() {} } });
  assert.deepEqual(f.committed, [2000, 3000]);
  assert.match(f.calls[1], /containers WHERE id = \$1 FOR UPDATE/);
  assert.ok(f.calls.indexOf('COMMIT') > f.calls.findIndex(s => s.includes('INSERT INTO port_observations')));
  assert.equal(f.calls.at(-1), 'RELEASE');
});
test('failed replacement rolls back to previous complete snapshot and releases client', async () => {
  const f = fake(true);
  await recordPortObservations(f.pool, { container: { id: 'c1' }, user: { id: 'u1' }, listeners: [{ port: 2000 }, { port: 3000 }], log: { warn() {} } });
  assert.deepEqual(f.committed, [1000]);
  assert.ok(f.calls.includes('ROLLBACK')); assert.equal(f.calls.at(-1), 'RELEASE');
});
