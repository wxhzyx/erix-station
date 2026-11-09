import test from 'node:test';
import assert from 'node:assert/strict';
import { WORK_ATTACHMENT_LIMITS as L, validateWorkAttachments, workMessageText } from '../src/work-attachments.js';
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
  for (const items of [Array(11).fill(file('a','a')), [file('../a','x')], [file('a','\0')], [file('a','x'.repeat(L.fileBytes + 1))]]) {
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

test('accepts a full 10 MiB file and ten attachments without truncation', () => {
  const text = '界'.repeat(Math.floor((L.fileBytes - 4) / 3)) + 'END!';
  const result = validateWorkAttachments([file('large.txt', text), ...Array.from({length:9},(_,i)=>file(`${i}.txt`,'ok'))], fail);
  assert.equal(result.length,10); assert.equal(result[0].text,text);
  assert.equal(validateWorkAttachments([file('exact.txt','a'.repeat(L.fileBytes))],fail)[0].text.length,L.fileBytes);
});
