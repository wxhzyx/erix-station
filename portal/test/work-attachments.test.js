import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkAttachments, workMessageText } from '../src/work-attachments.js';
import { validateMessageBody } from '../src/sessions.js';
const fail = message => { throw new Error(message); };
const file = (name, text) => ({ kind: 'file', path: '/etc/passwd', name, text });
test('multiple uploads are normalized, not read as server paths, and included in model text', () => {
  const attachments = validateWorkAttachments([file('a.txt', 'alpha'), file('b.js', 'beta')], fail);
  assert.equal(attachments[0].path, 'upload:a.txt');
  const text = workMessageText('compare', attachments);
  assert.match(text, /alpha/); assert.match(text, /beta/);
  assert.equal(workMessageText('legacy', [{kind:'file',path:'/etc/passwd'}]), 'legacy');
});
test('reject invalid count, filenames, binary, per-file and total limits', () => {
  for (const items of [Array(9).fill(file('a','a')), [file('../a','x')], [file('a','\0')], [file('a','x'.repeat(65537))], Array(5).fill(file('a','x'.repeat(65536)))]) {
    assert.throws(() => validateWorkAttachments(items, fail));
  }
});
test('message validation is repeatable for queued delivery without duplicating text', () => {
  const original = { content: 'inspect', attachments: [file('a.txt','uploaded')] };
  const first = validateMessageBody(original);
  assert.deepEqual(validateMessageBody(first), first);
  assert.equal(first.content, 'inspect');
  assert.equal(workMessageText(first.content,first.attachments).match(/uploaded/g).length,1);
});
