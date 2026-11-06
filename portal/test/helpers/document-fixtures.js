// Synthetic, generated entirely locally; no real user documents or binary fixtures.
import { deflateRawSync } from 'node:zlib';
export function zipFixture(entries, { encrypted = false } = {}) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value); const filename = Buffer.from(name); const packed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const b of data) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encrypted ? 1 : 0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(encrypted ? 1 : 0, 8); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, filename, packed); central.push(dir, filename); offset += local.length + filename.length + packed.length;
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(central.length / 2, 8); tail.writeUInt16LE(central.length / 2, 10);
  tail.writeUInt32LE(Buffer.concat(central).length, 12); tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, tail]);
}
const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
export function officeFixture(ext, { empty = false, text = 'Synthetic document text', entries = {}, encrypted = false } = {}) {
  const content = empty ? '' : text;
  let files;
  if (ext === 'docx') files = { 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${content}</w:t></w:r></w:p>${empty ? '' : '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Table B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'}</w:body></w:document>` };
  if (ext === 'xlsx') files = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst><si><t>${content}</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${empty ? '' : '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>2+3</f><v>5</v></c><c r="C1" t="inlineStr"><is><t>Inline text</t></is></c></row>'}</sheetData></worksheet>`,
  };
  if (ext === 'pptx') files = {
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${content}</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${empty ? '' : 'Speaker note'}</a:t></a:r></a:p></p:notes>`,
  };
  return zipFixture({ '[Content_Types].xml': types, ...files, ...entries }, { encrypted });
}
export function pdfFixture({ empty = false, pages = 1, text = 'Synthetic PDF text', encrypted = false } = {}) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < pages; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = empty ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj 160 0 Td (Table column) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  if (encrypted) objects.push('<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>');
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt ${objects.length} 0 R /ID [<0000000000000000><0000000000000000>]` : ''} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
export const documentFixture = ext => ext === 'pdf' ? pdfFixture() : officeFixture(ext);

// A real raster page with no text layer: the old parser rejected it as empty.
export async function visualFixture(ext, { images = 1, text = 'SCAN 73921 TOTAL 84' } = {}) {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  const { fileURLToPath } = await import('node:url');
  GlobalFonts.registerFromPath(fileURLToPath(new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)), 'FixtureSans');
  const canvas = createCanvas(640, 320), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 320);
  ctx.fillStyle = '#000'; ctx.font = '32px FixtureSans'; ctx.fillText(text, 30, 100);
  const jpeg = canvas.toBuffer('image/jpeg');
  if (ext !== 'pdf') {
    const root = { docx: 'word', xlsx: 'xl', pptx: 'ppt' }[ext];
    return officeFixture(ext, { empty: true, entries: Object.fromEntries(
      Array.from({ length: images }, (_, i) => [`${root}/media/image${i + 1}.jpeg`, jpeg])) });
  }
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: images }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${images} >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 640 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')])];
  for (let i = 0; i < images; i++) {
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 320] /Resources << /XObject << /Im1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`));
    const stream = 'q 640 0 0 320 0 0 cm /Im1 Do Q';
    objects.push(Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((obj, i) => { offsets.push(length); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')]); chunks.push(chunk); length += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(chunks);
}
