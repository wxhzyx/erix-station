import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, DOCUMENT_LIMITS as L } from '../src/document-parser.js';
import { documentFixture, officeFixture, pdfFixture, zipFixture, visualFixture } from './helpers/document-fixtures.js';
const parse = (ext, bytes) => parseDocument({ name: `fixture.${ext}`, data: bytes.toString('base64') });
for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
  test(`${ext}: image-only documents produce bounded images for the member's vision model`, async () => {
    const result = await parse(ext, await visualFixture(ext));
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mime_type, 'image/jpeg');
    const bytes = Buffer.from(result.images[0].data_base64, 'base64');
    assert.ok(bytes.length <= L.imageBytes); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216);
  });
}
test('visual pages never silently disappear past the image limit', async () => {
  for (const ext of ['pdf', 'xlsx']) await assert.rejects(parse(ext, await visualFixture(ext, { images: 6 })), { code: 'document_visual_limit' });
});
test('XML decimal and hex references decode once, preserving escaped literal entity text', async () => {
  const result = await parse('docx', officeFixture('docx', { text: '&#20013;&#x6587; &amp;#65; &lt;x&gt;' }));
  assert.match(result.text, /中文 &#65; <x>/);
});
for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
  test(`${ext}: extracts actual content and discloses representation limits`, async () => {
    const result = await parse(ext, documentFixture(ext));
    assert.match(result.text, /Synthetic/); assert.ok(result.warnings.length);
    assert.equal(result.name, `fixture.${ext}`); assert.ok(Buffer.byteLength(result.text) <= L.textBytes);
    if (ext === 'docx') assert.match(result.text, /Table A\tTable B/);
    if (ext === 'xlsx') { assert.match(result.text, /工作表：Budget/); assert.match(result.text, /B1=5.*公式：2\+3/); assert.match(result.text, /Inline text/); }
    if (ext === 'pptx') assert.match(result.text, /Speaker note/);
  });
  test(`${ext}: corrupt, empty and encrypted are explicit errors`, async () => {
    await assert.rejects(parse(ext, Buffer.from('corrupt binary')), e => e.status === 422);
    await assert.rejects(parse(ext, ext === 'pdf' ? pdfFixture({ empty: true }) : officeFixture(ext, { empty: true })), e => e.code === 'document_empty');
    await assert.rejects(parse(ext, ext === 'pdf' ? pdfFixture({ encrypted: true }) : officeFixture(ext, { encrypted: true })), e => e.code === 'document_encrypted');
  });
  test(`${ext}: oversized input rejected before parsing`, async () => {
    await assert.rejects(parse(ext, Buffer.alloc(L.inputBytes + 1)), e => e.status === 413);
  });
}
test('text truncation is explicit and respects multibyte UTF-8 limit', async () => {
  const result = await parse('docx', officeFixture('docx', { text: '界'.repeat(Math.ceil(L.textBytes / 3) + 100) }));
  assert.match(result.text, /内容已截断/); assert.ok(Buffer.byteLength(result.text) <= L.textBytes);
  assert.doesNotMatch(result.text, /\ufffd/); assert.ok(result.warnings.some(s => s.includes('截断')));
});
test('PDF page limit truncates explicitly', async () => {
  const result = await parse('pdf', pdfFixture({ pages: L.pages + 1 }));
  assert.match(result.text, /第 200 页/); assert.doesNotMatch(result.text, /第 201 页/); assert.match(result.text, /内容已截断/);
});
test('legacy and macro extensions cannot be silently accepted', async () => {
  for (const ext of ['doc', 'xls', 'ppt', 'docm', 'xlsm', 'pptm', 'zip', 'exe'])
    await assert.rejects(parse(ext, Buffer.from('data')), e => e.code === 'document_unsupported' && e.status === 415);
});
test('filename and base64 are canonical and bounded', async () => {
  for (const name of ['', '../a.pdf', 'C:\\a.pdf', 'a\x00.pdf']) await assert.rejects(parseDocument({name,data:'YWJj'}), e => e.code === 'document_name');
  for (const data of ['', 'a', '====', 'YWJj\n', 'Zh==']) await assert.rejects(parseDocument({name:'a.pdf',data}), e => e.code === 'document_encoding');
  // Long but valid base64 must not overflow a regexp stack.
  await assert.rejects(parse('pdf', Buffer.alloc(1024 * 1024)), e => e.code === 'document_corrupt');
});
test('ZIP entry size, total expansion and entry count are bounded', async () => {
  await assert.rejects(parse('docx', officeFixture('docx', {entries:{'big.xml':'x'.repeat(L.entryBytes + 1)}})), e => e.code === 'document_archive_limit');
  const many = Object.fromEntries(Array.from({length:L.entries+1},(_,i)=>[`part${i}.xml`,'<x/>']));
  await assert.rejects(parse('docx', zipFixture(many)), e => e.code === 'document_archive_limit');
  const expanded = Object.fromEntries(Array.from({length:9},(_,i)=>[`part${i}.bin`,Buffer.alloc(L.entryBytes)]));
  await assert.rejects(parse('docx', zipFixture(expanded)), e => e.code === 'document_archive_limit');
});
test('path traversal, DTD/entities, malformed XML, macros and embedded objects rejected', async () => {
  const cases = [
    {'../outside.xml':'<x/>'},
    {'word/document.xml':'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>'},
    {'word/document.xml':'<w:document><unclosed></w:document>'},
    {'word/vbaProject.bin':'macro'},
    {'word/embeddings/oleObject1.bin':'object'},
    {'[Content_Types].xml':'<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>'},
  ];
  for (const entries of cases) await assert.rejects(parse('docx', officeFixture('docx',{entries})), e=>e.status===422);
});
test('external relationships are not followed and formulas never evaluated', async () => {
  const result = await parse('docx', officeFixture('docx',{entries:{'word/_rels/document.xml.rels':'<Relationships><Relationship Id="rId1" Target="http://127.0.0.1:1/secret" TargetMode="External"/></Relationships>'}}));
  assert.match(result.text, /Synthetic/); assert.doesNotMatch(result.text, /secret/);
  const xlsx = await parse('xlsx', officeFixture('xlsx', {entries:{'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1"><f>WEBSERVICE("http://127.0.0.1:1/secret")</f><v>cached</v></c></row></sheetData></worksheet>'}}));
  assert.match(xlsx.text, /cached/); assert.match(xlsx.text, /未计算/);
});
test('concurrent workers are bounded and capacity returns after completion', async () => {
  const first = parse('pdf', pdfFixture()); const second = parse('pdf', pdfFixture());
  await assert.rejects(parse('pdf', pdfFixture()), e => e.code === 'document_busy');
  await Promise.all([first, second]); assert.match((await parse('docx',officeFixture('docx'))).text,/Synthetic/);
});
test('sheet and slide counts truncate visibly in source order', async () => {
  const sheetEntries = {'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${Array.from({length:L.sheets+1},(_,i)=>`<sheet name="Sheet${i+1}" r:id="rId1"/>`).join('')}</sheets></workbook>`};
  const sheetResult = await parse('xlsx',officeFixture('xlsx',{entries:sheetEntries}));
  assert.match(sheetResult.text,/工作表：Sheet50/); assert.doesNotMatch(sheetResult.text,/工作表：Sheet51/); assert.match(sheetResult.text,/内容已截断/);
  const slideEntries = {'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({length:L.slides+1},(_,i)=>`<p:sldId id="${i+256}" r:id="rId1"/>`).join('')}</p:sldIdLst></p:presentation>`};
  const slideResult = await parse('pptx',officeFixture('pptx',{entries:slideEntries}));
  assert.match(slideResult.text,/幻灯片 200/); assert.doesNotMatch(slideResult.text,/幻灯片 201/); assert.match(slideResult.text,/内容已截断/);
});
test('document-controlled external URLs do not generate network requests', async () => {
  const {createServer} = await import('node:http'); let requests = 0;
  const server = createServer((_req,res)=>{requests++;res.end('NETWORK LEAK');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/document-external`;
    const docx = await parse('docx',officeFixture('docx',{entries:{'word/_rels/document.xml.rels':`<Relationships><Relationship Id="r1" Target="${url}" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate"/></Relationships>`}}));
    assert.doesNotMatch(docx.text,/NETWORK LEAK/);
    // PDF URL-looking text is data, never a URL input to the parser.
    await parse('pdf',pdfFixture({text:url}));
    assert.equal(requests,0);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('subprocess hard allocation failure and timeout do not kill portal or block later parses', async () => {
  const { runDocumentProcess } = await import('../src/document-parser.js');
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(),'document-process-test-'));
  try {
    const memory = join(dir,'memory.mjs'); const hang = join(dir,'hang.mjs');
    await writeFile(memory,'new ArrayBuffer(2 * 1024 * 1024 * 1024); process.stdout.write(JSON.stringify({result:{text:"UNBOUNDED",warnings:[]}}));');
    await writeFile(hang,'for (;;) {}');
    await assert.rejects(runDocumentProcess({name:'test',data:'',ext:'pdf'},{scriptPath:memory}),e=>e.code==='document_failed');
    const start=Date.now();
    await assert.rejects(runDocumentProcess({name:'test',data:'',ext:'pdf'},{scriptPath:hang,timeoutMs:150}),e=>e.code==='document_timeout');
    assert.ok(Date.now()-start<5000,'wall timer kills the child and awaits close promptly');
    assert.match((await parse('pdf',pdfFixture())).text,/Synthetic/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('subprocess environment excludes portal credentials and inherited Node hooks', async () => {
  const {runDocumentProcess} = await import('../src/document-parser.js');
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises'); const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'document-env-test-'));
  const old=process.env.DOCUMENT_TEST_SECRET; process.env.DOCUMENT_TEST_SECRET='synthetic-secret';
  try {
    const script=join(dir,'env.mjs');
    await writeFile(script,'process.stdout.write(JSON.stringify({result:{text:JSON.stringify(process.env),warnings:[]}}));');
    const result=await runDocumentProcess({name:'test',data:'',ext:'pdf'},{scriptPath:script});
    assert.doesNotMatch(result.text,/synthetic-secret|DOCUMENT_TEST_SECRET|NODE_OPTIONS/);
    assert.equal(JSON.parse(result.text).MALLOC_ARENA_MAX,'2');
  } finally {if(old===undefined)delete process.env.DOCUMENT_TEST_SECRET;else process.env.DOCUMENT_TEST_SECRET=old;await rm(dir,{recursive:true,force:true});}
});

test('text above old 64 KiB budget is retained through the final marker', async () => {
  const text = '界'.repeat(50000) + 'FINAL_MARKER';
  const result = await parse('docx',officeFixture('docx',{text}));
  assert.match(result.text,/FINAL_MARKER/);assert.ok(Buffer.byteLength(result.text)>65536);assert.doesNotMatch(result.text,/内容已截断/);
});
test('exact 10 MiB PDF passes the upload and worker envelopes', async () => {
  const source=pdfFixture();const bytes=Buffer.concat([source,Buffer.alloc(L.inputBytes-source.length,32)]);
  assert.match((await parse('pdf',bytes)).text,/Synthetic/);
});
