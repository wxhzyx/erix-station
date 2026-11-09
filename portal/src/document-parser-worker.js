import { DOCUMENT_BODY_BYTES } from './attachment-limits.js';
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DOCUMENT_LIMITS as L } from './document-parser.js';

const fail = (code, message, status = 422) => { throw Object.assign(new Error(message), { code, status, safeDocumentError: true }); };
const warnings = [];
const images = [];
let output = '';
let outputBytes = 0;
let truncated = false;
const notice = '\n[内容已截断：超过解析或 10 MiB 文本限制，请拆分文件。]';
function add(value) {
  if (truncated) return;
  const text = String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/g, ' ');
  const available = Math.max(0, L.textBytes - 2048 - outputBytes);
  const size = Buffer.byteLength(text);
  if (size <= available) { output += text; outputBytes += size; return; }
  // Trim at a UTF-8 boundary without building millions of one-character strings.
  const bytes = Buffer.from(text);
  let end = available;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  output += bytes.subarray(0, end).toString('utf8'); outputBytes += end; truncated = true;
}
function limit() { truncated = true; }
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
  trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: true,
  // This parser version gates XML numeric character references on htmlEntities.
  // Supply only XML's five named entities; never decode the resulting text twice.
  htmlEntities: { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } });
function xml(text) {
  // No DTD/entity definitions (including external entities); only built-in XML escapes.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('unsafe_xml', '文档包含不支持的 XML 实体或 DTD');
  if (XMLValidator.validate(text) !== true) fail('corrupt', '文档 XML 已损坏');
  return parser.parse(text);
}
const tag = node => Object.keys(node).find(k => k !== ':@');
const local = name => name?.split(':').pop();
function children(node) { const value = node?.[tag(node)]; return Array.isArray(value) ? value : []; }
function attr(node, name) {
  const attributes = node?.[':@'] ?? {};
  return attributes[name] ?? Object.entries(attributes).find(([k]) => local(k) === name)?.[1];
}
function relationshipId(node) {
  return Object.entries(node?.[':@'] ?? {}).find(([key]) => key.includes(':') && local(key) === 'id')?.[1];
}
function find(nodes, name) {
  const result = [];
  function visit(list) { for (const node of list ?? []) { if (local(tag(node)) === name) result.push(node); visit(children(node)); } }
  visit(nodes); return result;
}
function textOf(nodes) { return (nodes ?? []).map(n => tag(n) === '#text' ? String(n['#text']) : textOf(children(n))).join(''); }
function runText(nodes) {
  let result = '';
  for (const node of nodes ?? []) {
    const key = local(tag(node));
    if (key === 't') result += textOf(children(node));
    else if (key === 'tab') result += '\t';
    else if (key === 'br' || key === 'cr') result += '\n';
    else result += runText(children(node));
  }
  return result;
}
async function readZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const files = new Map(); let count = 0; let total = 0; let closed = false;
      const bad = error => { if (closed) return; closed = true; zip.close(); reject(error); };
      zip.on('error', bad);
      zip.on('end', () => { if (!closed) { closed = true; resolve(files); } });
      zip.on('entry', entry => {
        try {
          const name = entry.fileName;
          if (++count > L.entries || total + entry.uncompressedSize > L.expandedBytes || entry.uncompressedSize > L.entryBytes)
            fail('archive_limit', '文档解压大小或条目数量超限', 413);
          total += entry.uncompressedSize;
          if (entry.generalPurposeBitFlag & 1) fail('encrypted', '不支持加密文档，请先移除密码');
          if (/^(\/|[A-Za-z]:)|\\|(?:^|\/)\.\.(?:\/|$)|\x00/.test(name) || files.has(name))
            fail('unsafe_archive', '文档归档路径无效或重复');
          if (/vbaProject|(?:^|\/)embeddings\//i.test(name)) fail('active_content', '不支持包含宏或嵌入对象的文档，请移除后重试');
          files.set(name, null);
          // Never extract to disk. Only supported internal raster images join XML input.
          const media = /^(word|xl|ppt)\/media\/[^/]+\.(png|jpe?g|webp)$/i.test(name);
          if (!media && !/\.(xml|rels)$/i.test(name)) { zip.readEntry(); return; }
          zip.openReadStream(entry, (error, stream) => {
            if (error) return bad(error);
            const chunks = []; let size = 0;
            stream.on('error', bad);
            stream.on('data', chunk => {
              size += chunk.length;
              if (size > L.entryBytes || size > entry.uncompressedSize) { stream.destroy(); bad(Object.assign(new Error('文档解压大小超限'), { code: 'archive_limit', status: 413, safeDocumentError: true })); }
              else chunks.push(chunk);
            });
            stream.on('end', () => {
              if (closed) return;
              try {
                if (media) { files.set(name, Buffer.concat(chunks)); zip.readEntry(); return; }
                const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                if (/<!DOCTYPE|<!ENTITY/i.test(value)) fail('unsafe_xml', '文档包含不支持的 XML 实体或 DTD');
                files.set(name, value); zip.readEntry();
              } catch (e) { bad(e); }
            });
          });
        } catch (error) { bad(error); }
      });
      zip.readEntry();
    });
  });
}
function required(files, name) { if (typeof files.get(name) !== 'string') fail('corrupt', '文档缺少必要内容或格式与扩展名不符'); return xml(files.get(name)); }
function relationships(files, name) {
  return new Map(find(required(files, name), 'Relationship').filter(n => attr(n, 'TargetMode') !== 'External').map(n => [attr(n, 'Id'), attr(n, 'Target')]));
}
function packageTarget(base, target) {
  if (typeof target !== 'string' || /[:\\\x00]/.test(target)) fail('corrupt', '文档内部引用无效');
  const parts = (target.startsWith('/') ? target.slice(1) : `${base}/${target}`).split('/'); const clean = [];
  for (const p of parts) { if (p === '..') { if (!clean.length) fail('corrupt', '文档内部引用越界'); clean.pop(); } else if (p && p !== '.') clean.push(p); }
  return clean.join('/');
}
function word(files) {
  const doc = required(files, 'word/document.xml');
  function render(nodes) { for (const node of nodes) {
    const key = local(tag(node));
    if (key === 'p') add(runText(children(node)) + '\n');
    else if (key === 'tbl') {
      for (const row of children(node).filter(n => local(tag(n)) === 'tr')) {
        add(children(row).filter(n => local(tag(n)) === 'tc').map(c => find(children(c), 'p').map(p => runText(children(p))).join(' / ')).join('\t') + '\n');
      }
    } else render(children(node));
    if (truncated) return;
  } }
  render(doc);
  warnings.push('Word 提取正文段落和表格；内嵌图片由视觉模型读取，页眉页脚、修订语义及版式不保留。');
}
function excel(files) {
  const book = required(files, 'xl/workbook.xml');
  const rels = relationships(files, 'xl/_rels/workbook.xml.rels');
  const strings = files.has('xl/sharedStrings.xml') ? find(required(files, 'xl/sharedStrings.xml'), 'si').map(n => runText(children(n))) : [];
  const sheets = find(book, 'sheet'); let cells = 0;
  if (sheets.length > L.sheets) limit();
  // Process a bounded prefix, with an explicit notice if there are more sheets.
  const tooMany = truncated; truncated = false;
  for (const sheet of sheets.slice(0, L.sheets)) {
    add(`\n[工作表：${attr(sheet, 'name') ?? ''}]\n`);
    const target = rels.get(relationshipId(sheet));
    const rows = find(required(files, packageTarget('xl', target)), 'row');
    for (const row of rows) {
      const values = [];
      for (const cell of children(row).filter(n => local(tag(n)) === 'c')) {
        if (++cells > L.cells) { limit(); break; }
        const type = attr(cell, 't'); const raw = textOf(children(find(children(cell), 'v')[0]));
        let value = type === 's' ? strings[Number(raw)] ?? '' : type === 'inlineStr' ? runText(children(cell)) : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
        const formula = find(children(cell), 'f')[0];
        if (formula) value += ` [公式：${textOf(children(formula))}；仅缓存结果，未计算]`;
        if (value.trim()) values.push(`${attr(cell, 'r') ?? '?'}=${value}`);
      }
      add(values.join('\t') + '\n');
      if (truncated) break;
    }
    if (truncated) break;
  }
  if (tooMany) limit();
  warnings.push('Excel 提取工作表、单元格和公式缓存值；不执行公式、不刷新外链。内嵌图片由视觉模型读取，原生图表与版式不保留。');
}
function powerpoint(files) {
  const presentation = required(files, 'ppt/presentation.xml');
  const rels = relationships(files, 'ppt/_rels/presentation.xml.rels');
  const slides = find(presentation, 'sldId');
  for (const [index, slide] of slides.slice(0, L.slides).entries()) {
    const path = packageTarget('ppt', rels.get(relationshipId(slide)));
    add(`\n[幻灯片 ${index + 1}]\n`);
    for (const p of find(required(files, path), 'p')) add(runText(children(p)) + '\n');
    const relPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    if (files.has(relPath)) {
      const notes = find(required(files, relPath), 'Relationship').find(n => /\/notesSlide$/.test(attr(n, 'Type') ?? '') && attr(n, 'TargetMode') !== 'External');
      if (notes) {
        add('[演讲者备注]\n');
        const notePath = packageTarget(path.substring(0, path.lastIndexOf('/')), attr(notes, 'Target'));
        for (const p of find(required(files, notePath), 'p')) add(runText(children(p)) + '\n');
      }
    }
    if (truncated) break;
  }
  if (slides.length > L.slides) limit();
  warnings.push('PPT 提取幻灯片文本、表格文本和备注；内嵌图片由视觉模型读取，原生图表、动画及版式不保留。');
}
async function pdf(bytes) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('corrupt', 'PDF 文件签名无效');
  // Node 22's lazy Fetch/Response bootstrap compiles WASM even for a data-only
  // PDF. The child disables fetch so JIT-less mode remains usable. PDF.js checks
  // Response.prototype.bytes at import time; provide only a fail-closed sentinel,
  // NOT a network polyfill. This parser never constructs a Response or fetches.
  globalThis.fetch = async () => { throw new Error('Document network access disabled'); };
  globalThis.Response = class DisabledDocumentResponse {
    constructor() { throw new Error('Document network access disabled'); }
    bytes() { throw new Error('Document network access disabled'); }
  };
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, disableRange: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, enableXfa: false, verbosity: 0, useWasm: false,
    // No URL or CMap/font/wasm URL supplied: text extraction never fetches resources.
  });
  try {
    const doc = await task.promise;
    const metadata = await doc.getMetadata();
    if (metadata.info?.EncryptFilterName) fail('encrypted', '不支持加密 PDF，请先移除密码');
    for (let n = 1; n <= Math.min(doc.numPages, L.pages); n++) {
      const page = await doc.getPage(n); const content = await page.getTextContent();
      add(`\n[第 ${n} 页]\n`);
      let lastY = null; let lastEnd = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const x = item.transform[4]; const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 3) { add('\n'); lastEnd = null; }
        else if (lastEnd !== null) add(x - lastEnd > 12 ? '\t' : ' ');
        add(item.str); lastY = y; lastEnd = x + item.width;
        if (item.hasEOL) { add('\n'); lastY = null; lastEnd = null; }
        if (truncated) break;
      }
      const operators = await page.getOperatorList();
      if (operators.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op))) {
        checkImageCount();
        const viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, L.imageSide / Math.max(viewport.width, viewport.height));
        const view = page.getViewport({ scale });
        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        addCanvas(canvas, `第 ${n} 页`);
      }
      page.cleanup(); if (truncated) break;
    }
    if (doc.numPages > L.pages) limit();
  } catch (error) {
    if (error.name === 'PasswordException') fail('encrypted', '不支持加密 PDF，请先移除密码');
    throw error;
  } finally { await task.destroy(); }
  warnings.push('PDF 提取文本；含图片的页面由视觉模型读取，模糊文字可能无法辨认。');
}
function checkImageCount() {
  if (images.length >= L.imageCount) fail('visual_limit', '文档包含超过 5 页图片或 5 张插图，请拆分后上传', 413);
}
function addCanvas(canvas, label) {
  const bytes = canvas.toBuffer('image/jpeg', 85);
  canvas.width = 1; canvas.height = 1;
  if (bytes.length > L.imageBytes) fail('visual_limit', '文档图片过于复杂，请拆分或降低分辨率后上传', 413);
  images.push({ label, mime_type: 'image/jpeg', data_base64: bytes.toString('base64') });
}
async function officeImages(files) {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  for (const [name, bytes] of files) {
    if (!Buffer.isBuffer(bytes)) continue;
    checkImageCount();
    const image = await loadImage(bytes);
    if (!image.width || !image.height || image.width * image.height > L.imagePixels) fail('visual_limit', '文档图片分辨率过大', 413);
    const scale = Math.min(1, L.imageSide / Math.max(image.width, image.height));
    const canvas = createCanvas(Math.ceil(image.width * scale), Math.ceil(image.height * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    addCanvas(canvas, name);
  }
}
try {
  const input = []; let inputSize = 0;
  for await (const chunk of process.stdin) {
    inputSize += chunk.length;
    if (inputSize > DOCUMENT_BODY_BYTES) fail('size', '文档输入超限', 413);
    input.push(chunk);
  }
  const workerData = JSON.parse(Buffer.concat(input).toString('utf8'));
  const bytes = Buffer.from(workerData.data, 'base64');
  if (workerData.ext === 'pdf') await pdf(bytes);
  else {
    if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) fail('encrypted', '文件为加密 Office 或旧版二进制格式，请解密并另存为 DOCX/XLSX/PPTX');
    const files = await readZip(bytes);
    required(files, '[Content_Types].xml');
    if (/macroEnabled|vbaProject/i.test(files.get('[Content_Types].xml'))) fail('active_content', '不支持宏文档，请移除宏后重试');
    if (workerData.ext === 'docx') word(files);
    else if (workerData.ext === 'xlsx') excel(files);
    else powerpoint(files);
    if ([...files.values()].some(Buffer.isBuffer)) await officeImages(files);
  }
  // Structural labels alone do not count as extracted user content.
  const substantive = output.replace(/\[(?:第 \d+ 页|工作表：[^\]]*|幻灯片 \d+|演讲者备注)\]/g, '').trim();
  if (!substantive && !images.length) fail('empty', '文档中没有可读取的文字或图片，请检查文件内容');
  if (truncated) { output += notice; warnings.push('内容已截断，请拆分文件以读取剩余内容。'); }
  output += '\n[解析说明]\n' + warnings.join('\n');
  process.stdout.write(JSON.stringify({ result: { text: output.trim(), warnings, ...(images.length ? { images } : {}) } }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.safeDocumentError ? error.code : 'corrupt', message: error.safeDocumentError ? error.message : '文档损坏、格式不符或无法解析', status: error.safeDocumentError ? error.status : 422 } }));
}
