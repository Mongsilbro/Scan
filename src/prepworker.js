// 준비 작업자: 화면 쪽이 그린 쪽 그림을 받아 전처리·표 찾기(1차), 글줄 찾기·자르기(2차)를 대신 함
// makeImgProc(src/imgproc.js)는 화면 쪽이 이 파일 앞에 붙여 넣어 줌. 캔버스는 OffscreenCanvas
let IP = null;
const pages = new Map();          // 2차: 쪽 번호표 → 그 쪽 그림(돌리기·다시 읽기에 씀)
function fromRGBA(m) {
  const c = new OffscreenCanvas(m.W, m.H);
  c.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.W, m.H), 0, 0);
  return c;
}
self.onmessage = e => {
  const m = e.data, tr = [];
  try {
    let out = {};
    if (m.type === 'init') { IP = makeImgProc(m.cfg, () => new OffscreenCanvas(1, 1)); return; }
    if (m.type === 'p1') {            // 1차: 전처리 → 표 찾기 → (표면) 칸 그림들. 정리한 쪽 그림도 돌려줌
      const c = fromRGBA(m);
      if (m.prep) IP.enhance(c);
      const seg = m.table ? IP.segment(c, m.dpi) : null;
      let table = null;
      if (seg && seg.cells.length && m.useTable) {
        const t = IP.tableImages(seg);
        table = { rest: IP.grayOf(t.rest), strips: t.strips.map(IP.grayOf), restInk: t.restInk, sc: seg.sc };
        tr.push(table.rest.gray.buffer, ...table.strips.map(s => s.gray.buffer));
      }
      const img = IP.grayOf(c); img.vertical = IP.linesAreVertical(c); tr.push(img.gray.buffer);
      out = { img, table };
    } else if (m.type === 'open2') {  // 2차: 쪽 받기 → 전처리 → 누운 쪽인지
      const c = fromRGBA(m);
      if (m.prep) IP.enhance(c);
      pages.set(m.pid, { c, dpi: m.dpi });
      out = { vertical: IP.linesAreVertical(c), W0: c.width, H0: c.height };
    } else if (m.type === 'turn') {
      const p = pages.get(m.pid); p.c = IP.rotated(p.c, m.deg);
    } else if (m.type === 'read') {   // 글줄 찾기 → 순서 정하기 → 신경망 입력 만들기
      const p = pages.get(m.pid), res = IP.readLines(p.c, p.dpi, m.sample);
      if (res) for (const t of (res.tensors || res.up.concat(res.dn))) tr.push(t.data.buffer);
      out = { res };
    } else if (m.type === 'close') pages.delete(m.pid);
    self.postMessage(Object.assign(out, { id: m.id }), tr);
  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.stack || err) }); }
};
