(async () => {
  const $ = id => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file'), bar = $('bar'), statusEl = $('status');
  const qEl = $('q'), hitsEl = $('hits'), chipsEl = $('chips'), summaryEl = $('summary');
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }
  let early = null;                     // 준비가 끝나기 전에 고른 파일은 기억했다가 준비되면 분석
  fileInput.onchange = () => { early = fileInput.files[0]; };
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- 내장 자원 ----------
  const b64 = t => { const bin = atob(t); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  async function asset(id, gunzip) {
    const u = b64($(id).textContent);
    if (!gunzip) return u;
    const st = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  const jsUrl = async id => URL.createObjectURL(new Blob([await asset(id, true)], { type: 'text/javascript' }));
  const loadScript = async id => { const el = document.createElement('script'); el.src = await jsUrl(id);
    await new Promise((ok, no) => { el.onload = ok; el.onerror = no; document.head.appendChild(el); }); };

  // ---------- 설정 (주소 뒤에 ?dpi=250&workers=2 처럼 붙여 조정 가능) ----------
  const Q = new URLSearchParams(location.search);
  const cores = navigator.hardwareConcurrency || 4;
  let autoWorkers = Math.max(1, Math.min(8, cores));   // 코어가 많은 컴퓨터는 최대 8개까지 동시 처리
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) autoWorkers = Math.min(autoWorkers, 2);
  const CFG = {
    dpi: +Q.get('dpi') || 200,
    dpi1: +Q.get('dpi1') || +Q.get('dpi') || 170,   // 1차 판독(Tesseract) 해상도            // OCR용 렌더링 해상도
    psm: Q.get('psm') || '3',             // 3 = 자동 레이아웃 분석(다단·표), 6 = 한 덩어리
    workers: +Q.get('workers') || autoWorkers,
    prep: Q.get('prep') !== '0',          // 배경 제거·대비 보정
    psm2: Q.get('psm2') || '3',           // 정밀 인식 2차 판독의 레이아웃 방식
    engine: Q.get('engine') || 'nn',      // nn = 신경망(PP-OCRv5), tess = Tesseract
    gap: +Q.get('gap') || 1.1,            // 글줄 찾기: 같은 줄로 이어 붙일 최대 간격(글자 높이의 배수)
    thin: +Q.get('thin') || 0, pad: +Q.get('pad') || 0.3,
    squeeze: +Q.get('squeeze') || 1,
    skip2: +Q.get('skip2') || 100,          // 1차 신뢰도가 이 값 이상인 쪽은 2차 판독 생략   // 신경망 입력의 가로 압축(작을수록 빠름)
    table: Q.get('table') !== '0',        // 표 칸 단위 인식
    psmc: Q.get('psmc') || '6',           // 표 칸을 읽을 때의 방식
    rot: Q.get('rot') === '1',            // 기울기 자동 보정
    chunk: +Q.get('chunk') || 8,          // 2차 판독에서 작업자에게 한 번에 넘기는 글줄 수
    ahead: Q.has('ahead') ? +Q.get('ahead') : 1,   // 2차에서 신경망 작업자 수보다 몇 쪽 더 미리 준비할지
    overlap: Q.get('overlap') !== '0',    // 1차 판독이 끝난 작업자부터 바로 2차 판독 시작
    warm: Q.get('warm') !== '0',          // 페이지를 열 때 판독 엔진 미리 준비
    maxPx: 3800
  };

  try {
    await loadScript('a-pdf'); await loadScript('a-tess');
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(await jsUrl('a-pdfworker'));
  } catch (e) {
    console.error(e);
    setStatus('프로그램을 시작하지 못했습니다. 최신 버전의 크롬·엣지·파이어폭스·사파리에서 열어주세요.', 'err');
    return;
  }
  let cmaps = null;
  class EmbeddedCMaps {
    async fetch({ name }) {
      if (!cmaps) cmaps = JSON.parse(new TextDecoder().decode(await asset('a-cmaps', true)));
      if (!cmaps[name]) throw new Error('CMap 없음: ' + name);
      return { cMapData: b64(cmaps[name]), compressionType: pdfjsLib.CMapCompressionType.BINARY };
    }
  }

  let analyzedLang = '';
  let pdf = null, curFile = null, pages = [], total = 0, runId = 0, running = false;

  // ---------- 글자 정규화 ----------
  // 공백 제거 + 소문자화. map[i] = 정규화된 i번째 글자의 원문 위치
  // jamo=true 이면 한글을 자모 단위로 풀어서(비슷한 글자 찾기용) 반환
  const KEEP = /[\p{L}\p{N}]/u;
  function normalize(s, jamo) {
    let out = ''; const map = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!KEEP.test(c)) continue;      // 공백·문장부호·기호는 무시 (인식 잡티에 강해짐)
      const l = (jamo ? c.normalize('NFD') : c.normalize('NFC')).toLowerCase();
      for (let k = 0; k < l.length; k++) { out += l[k]; map.push(i); }
    }
    return { out, map };
  }

  // ---------- OCR 작업자 풀 ----------
  let pool = [], poolLang = '', tessUrlP = null; const langData = {};
  function makeWorker(lang) {
    return (async () => {
      if (!tessUrlP) tessUrlP = (async () => URL.createObjectURL(new Blob(
        [await asset('a-core', true), '\n;', await asset('a-tessworker', true)], { type: 'text/javascript' })))();
      const url = await tessUrlP;
      const langs = [];
      for (const code of lang.split('+')) {
        if (!langData[code]) langData[code] = await asset('a-lang-' + code, false);
        langs.push({ code, data: langData[code] });
      }
      const w = await Tesseract.createWorker(langs, 1, { workerPath: url, workerBlobURL: false, cacheMethod: 'none' });
      await w.setParameters({ tessedit_pageseg_mode: CFG.psm, user_defined_dpi: String(CFG.dpi) });
      w.__psm = CFG.psm;
      return w;
    })();
  }
  async function resetPool(lang) {
    if (poolLang === lang) return;
    const old = pool; pool = []; poolLang = lang;
    for (const p of old) p.then(w => w.terminate()).catch(() => {});
  }

  // ---------- 렌더링과 전처리 ----------
  async function renderToCanvas(page, scale, maxPx) {
    const base = page.getViewport({ scale: 1 });
    scale = Math.max(1, Math.min(scale, maxPx / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }
  // 흑백 변환 + 배경(종이색)을 흰색으로, 글자를 검게 늘려 대비를 높임
  function enhance(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
    const hist = new Uint32Array(256); const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = g; hist[g]++; }
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.005) { lo = v; break; } }
    acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.5) { hi = v; break; } }
    hi = Math.max(lo + 1, hi - 6);
    const ok = hi - lo >= 50;          // 대비가 거의 없는 쪽(빈 쪽, 어두운 바탕)은 흑백 변환만
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ok ? (v - lo) * 255 / (hi - lo) : v;
    for (let i = 0; i < d.length; i += 4) { const g = lut[d[i]]; d[i] = d[i + 1] = d[i + 2] = g; }
    ctx.putImageData(im, 0, 0);
  }
  function rotated(canvas, deg) {
    const c = document.createElement('canvas'); const q = deg % 180 !== 0;
    c.width = q ? canvas.height : canvas.width; c.height = q ? canvas.width : canvas.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }
  // 글줄 방향 추정: 가로줄이면 행 방향 농도 변화가 크고, 옆으로 누운 스캔이면 열 방향 변화가 큼
  function linesAreVertical(canvas) {
    const s = 600 / Math.max(canvas.width, canvas.height);
    const w = Math.max(8, Math.round(canvas.width * s)), h = Math.max(8, Math.round(canvas.height * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i];
    const thr = sum / (w * h) * 0.8;
    const rows = new Float32Array(h), cols = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < thr) { rows[y]++; cols[x]++; }
    const rough = (a, norm) => { let r = 0; for (let i = 1; i < a.length; i++) { const v = (a[i] - a[i - 1]) / norm; r += v * v; } return r / a.length; };
    const rr = rough(rows, w), rc = rough(cols, h);
    return rc > rr * 2.5 && rc > 1e-5;
  }
  const OUT = { text: true, blocks: false, hocr: false, tsv: false };
  async function recog(w, canvas, deg) {
    const c = deg ? rotated(canvas, deg) : canvas;
    const r = (await w.recognize(c, { rotateAuto: CFG.rot }, OUT)).data;
    if (deg) c.width = c.height = 0;
    const text = r.text || '', conf = r.confidence || 0;
    // 품질 점수: 신뢰도 × 제대로 된 글자(한글 음절·영문자) 비율. 뒤집힌 글자는 숫자·기호로 읽혀 점수가 낮아짐
    const body = text.replace(/\s/g, ''), letters = (body.match(/[가-힣A-Za-z]/g) || []).length;
    const ratio = body.length ? letters / body.length : 0;
    if (Q.get('debug')) console.log('recog', deg, 'conf', conf, 'ratio', ratio.toFixed(2), 'len', body.length, JSON.stringify(text.slice(0, 60)));
    return { text, conf, deg, ratio, len: body.length, score: conf * (0.2 + ratio) };
  }
  // 반환: { text, deg } — deg 는 글자가 바로 서는 회전 각도
  async function ocrCanvas(w, canvas, knownDeg) {
    if (knownDeg !== undefined) return recog(w, canvas, knownDeg);
    const better = (a, b) => (b.score > a.score * 1.1 ? b : a);
    let best;
    if (Q.get('debug')) console.log('linesAreVertical', linesAreVertical(canvas));
    if (linesAreVertical(canvas)) {          // 옆으로 누운 쪽: 두 방향을 모두 읽어 더 잘 읽힌 쪽 선택
      // 방향 판별은 한 덩어리 방식이 안정적이라 그 방식으로 먼저 가늠한 뒤, 정해진 방향으로 본 판독
      const psm = w.__psm; await setPsm(w, '6');
      const r90 = await recog(w, canvas, 90), r270 = await recog(w, canvas, 270), probe = r270.score > r90.score ? r270 : r90;
      await setPsm(w, psm);
      best = psm === '6' ? probe : await recog(w, canvas, probe.deg);
      if (probe.len * probe.ratio > best.len * best.ratio * 1.3) best = probe;
      if (best.conf < 50 && best.ratio < 0.35) best = better(best, await recog(w, canvas, 0));
    } else {
      best = await recog(w, canvas, 0);
      if (best.len >= 10) {
        // 글자다운 글자가 적으면 위아래가 뒤집힌 스캔일 수 있으므로 돌려서 다시 시도
        if (best.conf < 50 || best.ratio < 0.35) best = better(best, await recog(w, canvas, 180));
        if (best.conf < 50) for (const deg of [90, 270]) { best = better(best, await recog(w, canvas, deg)); if (best.conf >= 75) break; }
      }
    }
    return best;
  }

  // ---------- 표 인식 ----------
  // 잡티 제거 → 표 선 찾아 지우기 → 선으로 둘러싸인 칸 찾기. canvas 를 그 자리에서 정리하고 칸 목록을 돌려줌
  function segment(canvas, dpi) {
    const W = canvas.width, H = canvas.height, N = W * H, sc = dpi / 200;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const im = ctx.getImageData(0, 0, W, H), d = im.data;
    // Otsu 2값화
    const hist = new Uint32Array(256);
    for (let p = 0; p < N; p++) hist[d[p * 4]]++;
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v]; if (!wB) continue; const wF = N - wB; if (!wF) break;
      sumB += v * hist[v]; const diff = sumB / wB - (sum - sumB) / wF, between = wB * wF * diff * diff;
      if (between > best) { best = between; thr = v; }
    }
    const bin = new Uint8Array(N); let ink = 0;
    for (let p = 0; p < N; p++) if (d[p * 4] <= thr) { bin[p] = 1; ink++; }
    if (ink > N * 0.5 || ink < 50) return null;       // 어두운 바탕이거나 빈 쪽
    const erase = p => { bin[p] = 0; const i = p * 4; d[i] = d[i + 1] = d[i + 2] = 255; };

    // 1) 잡티 제거: 가로·세로 모두 아주 작은 점 덩어리
    const maxDim = Math.max(2, Math.round(3 * sc)), cap = maxDim * maxDim + 1;
    const seen = new Uint8Array(N), stack = new Int32Array(N), keep = new Int32Array(cap), hs = [];
    for (let p0 = 0; p0 < N; p0++) {
      if (!bin[p0] || seen[p0]) continue;
      let sp = 0, cnt = 0, x0 = W, x1 = 0, y0 = H, y1 = 0; stack[sp++] = p0; seen[p0] = 1;
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p - x) / W;
        if (cnt < cap) keep[cnt] = p; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx; if (bin[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } } }
      }
      if (x1 - x0 < maxDim && y1 - y0 < maxDim && cnt < cap) for (let k = 0; k < cnt; k++) erase(keep[k]);
      else { const bh = y1 - y0 + 1; if (bh >= 6 * sc && bh <= 120 * sc && x1 - x0 <= 160 * sc) hs.push(bh); }
    }

    // 2) 표 선: 길게 이어진 가로·세로 줄 (기울어진 선도 잡도록 이웃 1픽셀까지 함께 봄)
    const line = new Uint8Array(N), minRun = Math.round(80 * sc); let linePx = 0;
    for (let y = 1; y < H - 1; y++) { const o = y * W; let run = 0;
      for (let x = 0; x <= W; x++) {
        if (x < W && (bin[o + x] | bin[o + x - W] | bin[o + x + W])) { run++; continue; }
        if (run >= minRun) { linePx += run; for (let k = x - run; k < x; k++) { line[o + k] |= 1; line[o + k - W] |= 1; line[o + k + W] |= 1; } }
        run = 0;
      } }
    for (let x = 1; x < W - 1; x++) { let run = 0;
      for (let y = 0; y <= H; y++) { const p = y * W + x;
        if (y < H && (bin[p] | bin[p - 1] | bin[p + 1])) { run++; continue; }
        if (run >= minRun) { linePx += run; for (let k = y - run; k < y; k++) { const q = k * W + x; line[q] |= 2; line[q - 1] |= 2; line[q + 1] |= 2; } }
        run = 0;
      } }
    const cells = [];
    const G = 4, gw = Math.ceil(W / G), gh = Math.ceil(H / G);
    const label = new Int32Array(gw * gh);
    if (linePx >= minRun * 8) {
      // 3) 격자(4픽셀 단위)에서 선을 벽으로 삼아 칸을 찾음. 끊어진 선은 이어 붙임
      const hm = new Uint8Array(gw * gh), vm = new Uint8Array(gw * gh);
      for (let p = 0; p < N; p++) { const l = line[p]; if (!l) continue;
        if (bin[p]) erase(p);
        const x = p % W, g = ((p - x) / W / G | 0) * gw + (x / G | 0);
        if (l & 1) hm[g] = 1; if (l & 2) vm[g] = 1; }
      const gap = Math.round(12 * sc), ext = 2;
      for (let y = 0; y < gh; y++) { let last = -1; const o = y * gw;
        for (let x = 0; x < gw; x++) if (hm[o + x] === 1) { if (last >= 0 && x - last - 1 <= gap) for (let k = last + 1; k < x; k++) hm[o + k] = 2; last = x; }
        for (let x = 0; x < gw; x++) if (hm[o + x] && hm[o + x] < 3) for (let k = Math.max(0, x - ext); k <= Math.min(gw - 1, x + ext); k++) if (!hm[o + k]) hm[o + k] = 3; }
      for (let x = 0; x < gw; x++) { let last = -1;
        for (let y = 0; y < gh; y++) if (vm[y * gw + x] === 1) { if (last >= 0 && y - last - 1 <= gap) for (let k = last + 1; k < y; k++) vm[k * gw + x] = 2; last = y; }
        for (let y = 0; y < gh; y++) { const v = vm[y * gw + x]; if (v && v < 3) for (let k = Math.max(0, y - ext); k <= Math.min(gh - 1, y + ext); k++) if (!vm[k * gw + x]) vm[k * gw + x] = 3; } }
      for (let g = 0; g < gw * gh; g++) if (hm[g] || vm[g]) label[g] = -1;
      const queue = new Int32Array(gw * gh); let id = 0;
      for (let g0 = 0; g0 < gw * gh; g0++) {
        if (label[g0]) continue;
        id++; let qh = 0, qt = 0, cnt = 0, x0 = gw, x1 = 0, y0 = gh, y1 = 0; queue[qt++] = g0; label[g0] = id;
        while (qh < qt) {
          const g = queue[qh++], x = g % gw, y = (g - x) / gw; cnt++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (x > 0 && !label[g - 1]) { label[g - 1] = id; queue[qt++] = g - 1; }
          if (x < gw - 1 && !label[g + 1]) { label[g + 1] = id; queue[qt++] = g + 1; }
          if (y > 0 && !label[g - gw]) { label[g - gw] = id; queue[qt++] = g - gw; }
          if (y < gh - 1 && !label[g + gw]) { label[g + gw] = id; queue[qt++] = g + gw; }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, area = bw * bh;
        if (area <= gw * gh * 0.5 && cnt / area >= 0.6 && bw * G >= 30 * sc && bh * G >= 20 * sc)
          cells.push({ id, x0: x0 * G, y0: y0 * G, x1: Math.min(W, (x1 + 1) * G), y1: Math.min(H, (y1 + 1) * G) });
      }
      // 칸 안에서 글자가 있는 범위
      const isCell = new Uint8Array(id + 1);
      for (const c of cells) {
        let ax0 = W, ax1 = -1, ay0 = H, ay1 = -1, n = 0;
        for (let y = c.y0; y < c.y1; y++) { const go = (y / G | 0) * gw, o = y * W;
          for (let x = c.x0; x < c.x1; x++) if (bin[o + x] && label[go + (x / G | 0)] === c.id) {
            n++; if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y; } }
        c.ink = n; c.ax0 = ax0; c.ax1 = ax1; c.ay0 = ay0; c.ay1 = ay1;
      }
      const useful = cells.filter(c => c.ink >= 12 * sc * sc);
      cells.length = 0;
      if (useful.length >= 4) {       // 글자가 든 칸이 넷 이상일 때만 표로 취급
        const tol = 28 * sc;
        useful.sort((a, b) => a.y0 - b.y0);
        let row = [], top = -1e9;
        const flush = () => { row.sort((a, b) => a.x0 - b.x0); for (const c of row) cells.push(c); row = []; };
        for (const c of useful) { if (c.y0 - top > tol) { flush(); top = c.y0; } row.push(c); }
        flush();
        for (const c of cells) isCell[c.id] = 1;
      }
      var cellMask = isCell;
    }
    ctx.putImageData(im, 0, 0);
    hs.sort((a, b) => a - b);
    const hchar = hs.length ? hs[Math.floor(hs.length * 0.7)] : 24 * sc;      // 대표 글자 높이
    return { cells, d, bin, label, isCell: cellMask, W, H, G, gw, gh, sc, line, hchar };
  }

  // 칸들을 세로로 이어 붙인 그림(들)과, 칸 밖 글자만 남긴 그림을 만듦
  function tableImages(seg) {
    const { cells, d, bin, label, isCell, W, H, G, gw, sc } = seg;
    const pad = Math.round(14 * sc), gapY = Math.round(34 * sc), maxH = Math.round(5200 * sc);
    const strips = []; let cur = null;
    const stripW = Math.max(...cells.map(c => c.ax1 - c.ax0 + 1)) + pad * 2;
    for (const c of cells) {
      const h = c.ay1 - c.ay0 + 1;
      if (!cur || cur.h + h + gapY > maxH) { cur = { items: [], h: pad }; strips.push(cur); }
      cur.items.push({ c, y: cur.h }); cur.h += h + gapY;
    }
    const canvases = strips.map(s => {
      const cv = document.createElement('canvas'); cv.width = stripW; cv.height = s.h;
      const cx = cv.getContext('2d'); const out = cx.createImageData(stripW, s.h), o = out.data; o.fill(255);
      for (const { c, y: ty } of s.items) for (let y = c.ay0; y <= c.ay1; y++) { const go = (y / G | 0) * gw;
        for (let x = c.ax0; x <= c.ax1; x++) { const l = label[go + (x / G | 0)];
          if (l !== c.id && l !== -1) continue;        // 기울어진 표에서 이웃 칸 글자가 끼어들지 않게 함
          const v = d[(y * W + x) * 4], i = ((ty + y - c.ay0) * stripW + pad + x - c.ax0) * 4; o[i] = o[i + 1] = o[i + 2] = v; } }
      cx.putImageData(out, 0, 0); return cv;
    });
    // 칸 밖(제목·본문·쪽 번호)
    let restInk = 0; const rest = document.createElement('canvas'); rest.width = W; rest.height = H;
    const rx = rest.getContext('2d'); const ro = rx.createImageData(W, H), r = ro.data;
    for (let y = 0; y < H; y++) { const go = (y / G | 0) * gw;
      for (let x = 0; x < W; x++) { const p = y * W + x, i = p * 4, l = label[go + (x / G | 0)];
        const inCell = l > 0 && isCell[l]; const v = inCell ? 255 : d[i];
        r[i] = r[i + 1] = r[i + 2] = v; r[i + 3] = 255; if (!inCell && bin[p]) restInk++; } }
    rx.putImageData(ro, 0, 0);
    return { strips: canvases, rest, restInk };
  }

  async function setPsm(w, v) { if (w.__psm !== v) { await w.setParameters({ tessedit_pageseg_mode: v }); w.__psm = v; } }
  // 표가 있는 쪽: 칸 밖은 일반 방식으로, 칸 안은 칸 단위로 읽음. 잘 안 읽히면 null (일반 방식으로 되돌아감)
  async function ocrTable(w, seg, psm) {
    const t = tableImages(seg); const parts = []; let conf = 0, n = 0;
    if (t.restInk > 80 * seg.sc * seg.sc) { await setPsm(w, psm); parts.push((await recog(w, t.rest, 0)).text); }
    await setPsm(w, CFG.psmc);
    let ratio = 0;
    for (const s of t.strips) { const r = await recog(w, s, 0); parts.push(r.text); conf += r.conf; ratio += r.ratio; n++; s.width = s.height = 0; }
    t.rest.width = t.rest.height = 0;
    if (!n || conf / n < 45 || ratio / n < 0.35) return null;
    return { text: parts.join('\n'), deg: 0, table: true, conf: conf / n };
  }
  // 한 쪽을 그려서 읽음
  async function ocrPage(w, page, dpi, psm, knownDeg) {
    const P0 = performance.now();
    const canvas = await renderToCanvas(page, dpi / 72, CFG.maxPx);
    const P1 = performance.now();
    if (CFG.prep) enhance(canvas);
    let res = null; const P2 = performance.now();
    const seg = CFG.table ? segment(canvas, dpi) : null;
    if (Q.get('debug')) console.log(`1차 render ${(P1 - P0) | 0}ms enhance ${(P2 - P1) | 0}ms segment ${(performance.now() - P2) | 0}ms`);
    if (seg && seg.cells.length && !knownDeg) res = await ocrTable(w, seg, psm);
    if (!res) { await setPsm(w, psm); res = await ocrCanvas(w, canvas, knownDeg); res.canvas = canvas; }
    else canvas.width = canvas.height = 0;
    return res;
  }

  // ---------- 신경망 인식 (PP-OCRv5 한국어) ----------
  const NN = { ok: !!$('a-ort') && CFG.engine !== 'tess', pool: [], res: null };
  const nnRes = () => NN.res || (NN.res = (async () => { const T = performance.now(); const R = {
        url: URL.createObjectURL(new Blob([await asset('a-ort', true), '\n;', await asset('a-recworker', true)], { type: 'text/javascript' })),
        wasm: await asset('a-ortwasm', true), model: await asset('a-recmodel', true),
        dict: new TextDecoder().decode(await asset('a-recdict', true))
      }; if (Q.get('debug')) console.log('NN 자원 ' + ((performance.now() - T) | 0) + 'ms'); return R; })());
  function nnWorker() {
    return (async () => {
      const R = await nnRes();
      const w = new Worker(R.url); let seq = 0; const pend = new Map();
      w.onmessage = e => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.type === 'error' ? p.no(new Error(e.data.message)) : p.ok(e.data); };
      w.onerror = e => { for (const p of pend.values()) p.no(new Error(e.message || '인식 작업자 오류')); pend.clear(); };
      const call = (m, tr) => new Promise((ok, no) => { m.id = ++seq; pend.set(m.id, { ok, no }); w.postMessage(m, tr || []); });
      const Ti = performance.now(); await call({ type: 'init', wasm: R.wasm, model: R.model, dict: R.dict });
      if (Q.get('debug')) console.log('NN init ' + ((performance.now() - Ti) | 0) + 'ms');
      return { rec: lines => call({ type: 'rec', lines }, lines.map(l => l.data.buffer)), terminate: () => w.terminate() };
    })();
  }

  // 신경망 작업자 묶음: 한 쪽의 글줄을 몇 줄씩 나눠 쉬는 작업자가 바로 가져가 읽음 → 마지막 쪽도 모든 코어가 함께 읽음
  function nnPool(live) {
    const idle = [], q = [], all = []; let size = 0, closed = false, failed = null;
    const pump = () => {
      while (idle.length && q.length) {
        const w = idle.pop(), j = q.shift();
        if (!live()) { j.no(new Error('중지됨')); idle.push(w); continue; }
        w.rec(j.lines).then(j.ok, j.no).finally(() => { if (!closed) { idle.push(w); pump(); } });
      }
    };
    return {
      get size() { return size; },
      add(wp) {
        size++;
        wp.then(w => { if (closed) return w.terminate(); all.push(w); idle.push(w); pump(); },
          e => { size--; if (!size && !all.length) { failed = e; q.splice(0).forEach(j => j.no(e)); } });
      },
      async rec(lines) {
        if (failed) throw failed;
        const parts = [];
        for (let i = 0; i < lines.length; i += CFG.chunk) parts.push(lines.slice(i, i + CFG.chunk));
        const rs = await Promise.all(parts.map(l => new Promise((ok, no) => { q.push({ lines: l, ok, no }); pump(); })));
        return { texts: rs.flatMap(r => r.texts), confs: rs.flatMap(r => r.confs) };
      },
      close() { closed = true; q.splice(0).forEach(j => j.no(new Error('중지됨'))); all.forEach(w => w.terminate()); }
    };
  }

  // 글줄 찾기: 글자를 가로로 번지게 해서 이어진 덩어리를 한 줄로 봄 (표 선은 넘지 않음). 줄마다 기울기도 구함
  function textLines(seg) {
    const { bin, line, W, H, hchar, label, isCell, G, gw } = seg;
    const hw = W >> 1, hh = H >> 1, n2 = hw * hh;
    const sm = new Uint8Array(n2), bar = new Uint8Array(n2);
    for (let y = 0; y < hh; y++) { const o = y * hw, p0 = 2 * y * W;
      for (let x = 0; x < hw; x++) { const p = p0 + 2 * x;
        if (bin[p] | bin[p + 1] | bin[p + W] | bin[p + W + 1]) sm[o + x] = 1;
        if (line[p] | line[p + 1] | line[p + W] | line[p + W + 1]) bar[o + x] = 1; } }
    const gapMax = Math.max(3, Math.round(hchar * CFG.gap / 2));
    for (let y = 0; y < hh; y++) { const o = y * hw; let last = -1;
      for (let x = 0; x < hw; x++) {
        if (bar[o + x]) { last = -1; continue; }
        if (sm[o + x] === 1) { if (last >= 0 && x - last > 1 && x - last - 1 <= gapMax) for (let k = last + 1; k < x; k++) sm[o + k] = 2; last = x; }
      } }
    // 덩어리 표시 + 통계
    const lab = new Int32Array(n2), stack = new Int32Array(n2), comps = [null];
    for (let p0 = 0; p0 < n2; p0++) {
      if (!sm[p0] || lab[p0]) continue;
      const id = comps.length; let sp = 0, n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, x0 = hw, x1 = 0, y0 = hh, y1 = 0;
      stack[sp++] = p0; lab[p0] = id;
      while (sp) {
        const p = stack[--sp], x = p % hw, y = (p - x) / hw;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= hh) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= hw) continue;
            const q = yy * hw + xx; if (sm[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; } } }
      }
      let b = 0; const wd = x1 - x0 + 1, ht = y1 - y0 + 1, den = n * sxx - sx * sx;
      if (wd > 4 * ht && wd > 30 && den > 0) b = Math.max(-0.08, Math.min(0.08, (n * sxy - sx * sy) / den));
      comps.push({ id, n, x0, x1, y0, y1, b, r0: 1e9, r1: -1e9 });
    }
    for (let p = 0; p < n2; p++) { const id = lab[p]; if (!id) continue; const c = comps[id], x = p % hw, r = (p - x) / hw - c.b * x; if (r < c.r0) c.r0 = r; if (r > c.r1) c.r1 = r; }
    const minT = hchar * 0.45 / 2, minL = hchar * 0.6 / 2;
    let cand = comps.filter(c => c && c.r1 - c.r0 + 1 >= minT && c.x1 - c.x0 + 1 >= minL);
    if (!cand.length) return [];
    const ts = cand.filter(c => c.x1 - c.x0 > 3 * (c.r1 - c.r0)).map(c => c.r1 - c.r0 + 1).sort((a, b) => a - b);
    const medT = ts.length ? ts[ts.length >> 1] : hchar / 2;
    // 위아래 줄이 붙어 버린 덩어리는 가로 농도 골짜기에서 나눔
    const tall = new Map();
    for (const c of cand) if (c.r1 - c.r0 + 1 > medT * 1.75) tall.set(c.id, new Int32Array(Math.ceil(c.r1 - c.r0 + 2)));
    if (tall.size) for (let p = 0; p < n2; p++) { const h = tall.get(lab[p]); if (!h || sm[p] !== 1) continue; const c = comps[lab[p]], x = p % hw; h[Math.round((p - x) / hw - c.b * x - c.r0)]++; }
    const out = [];
    for (const c of cand) {
      const h = tall.get(c.id); let parts = [[c.r0, c.r1]];
      if (h) {
        let mx = 0; for (const v of h) if (v > mx) mx = v;
        const cuts = []; let i = 0;
        while (i < h.length) { if (h[i] <= mx * 0.1) { let j = i; while (j < h.length && h[j] <= mx * 0.1) j++; if (i > 0 && j < h.length) cuts.push((i + j - 1) / 2); i = j; } else i++; }
        if (cuts.length) { parts = []; let a = 0; for (const k of cuts.concat([h.length - 1])) { if (k - a + 1 >= minT) parts.push([c.r0 + a, c.r0 + k]); a = k + 1; } }
      }
      for (const [r0, r1] of parts) {
        const x0 = c.x0 * 2, x1 = c.x1 * 2 + 1, t = (r1 - r0 + 1) * 2, cx = (x0 + x1) / 2, cy = r0 * 2 + c.b * cx + t / 2;
        const lb = label[Math.min(seg.gh - 1, Math.max(0, cy / G | 0)) * gw + Math.min(gw - 1, cx / G | 0)];
        out.push({ x0, x1, b: c.b, rTop: r0 * 2, t, cx, cy, cell: lb > 0 && isCell && isCell[lb] ? lb : 0 });
      }
    }
    return out;
  }

  // 읽는 순서: 표 칸이나 문단 단위로 묶고, 묶음 안에서는 위→아래, 왼→오른쪽
  function orderLines(lines, seg) {
    const par = lines.map((_, i) => i), find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const cellRoot = new Map();
    const idx = lines.map((_, i) => i).sort((a, b) => lines[a].cy - lines[b].cy);
    for (let ii = 0; ii < idx.length; ii++) { const i = idx[ii], A = lines[i];
      if (A.cell) { if (cellRoot.has(A.cell)) par[find(i)] = find(cellRoot.get(A.cell)); else cellRoot.set(A.cell, i); continue; }
      for (let jj = ii + 1; jj < idx.length; jj++) { const j = idx[jj], B = lines[j];
        const dy = B.cy - A.cy; if (dy > (A.t + B.t) * 1.5) break;
        if (B.cell) continue;
        const ov = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        if (ov >= 0.4 * Math.min(A.x1 - A.x0, B.x1 - B.x0) || (dy < Math.min(A.t, B.t) * 0.5 && -ov < 3 * Math.max(A.t, B.t))) par[find(j)] = find(i);
      } }
    const groups = new Map();
    lines.forEach((l, i) => { const r = find(i); let g = groups.get(r); if (!g) groups.set(r, g = { lines: [], x0: 1e9, y0: 1e9 }); g.lines.push(l); g.x0 = Math.min(g.x0, l.x0); g.y0 = Math.min(g.y0, l.cy - l.t / 2); });
    const gs = [...groups.values()], tol = 28 * seg.sc;
    gs.sort((a, b) => a.y0 - b.y0);
    const ordered = []; let row = [], top = -1e9;
    const flush = () => { row.sort((a, b) => a.x0 - b.x0); ordered.push(...row); row = []; };
    for (const g of gs) { if (g.y0 - top > tol) { flush(); top = g.y0; } row.push(g); }
    flush();
    for (const g of ordered) g.lines.sort((a, b) => Math.abs(a.cy - b.cy) < Math.min(a.t, b.t) * 0.5 ? a.x0 - b.x0 : a.cy - b.cy);
    return ordered;
  }

  // 한 줄을 기울기에 맞춰 펴서 높이 48 픽셀 입력으로 만듦
  const lineCv = document.createElement('canvas'); lineCv.width = 2400; lineCv.height = 48;
  const lineCx = lineCv.getContext('2d', { willReadFrequently: true });
  function lineTensor(src, ln, flip) {
    const th = Math.atan(ln.b), cos = Math.cos(th), sin = Math.sin(th);
    const pad = Math.round(ln.t * CFG.pad) + 2, hgt = ln.t + 2 * pad, len = (ln.x1 - ln.x0 + 1) / cos + 2 * pad;
    const s = 48 / hgt, wout = Math.max(16, Math.min(2400, Math.round(len * s * CFG.squeeze))), sx = wout / len;
    const ox = ln.x0, oy = ln.rTop + ln.b * ln.x0;
    const a = sx * cos, c = sx * sin, b = -s * sin, d = s * cos;
    lineCx.setTransform(1, 0, 0, 1, 0, 0); lineCx.fillStyle = '#fff'; lineCx.fillRect(0, 0, wout, 48);
    lineCx.imageSmoothingEnabled = true; lineCx.imageSmoothingQuality = 'high';
    lineCx.save(); lineCx.beginPath(); lineCx.rect(0, 0, wout, 48); lineCx.clip();
    lineCx.setTransform(a, b, c, d, pad * sx - (a * ox + c * oy), pad * s - (b * ox + d * oy));
    const m = pad + 6, bx = Math.max(0, Math.floor(ln.x0 - m)), bw = Math.min(src.width, Math.ceil(ln.x1 + m)) - bx;
    const yA = oy - m - Math.abs(ln.b) * (ln.x1 - ln.x0), by = Math.max(0, Math.floor(yA)), bh = Math.min(src.height, Math.ceil(oy + ln.t + m + Math.abs(ln.b) * (ln.x1 - ln.x0))) - by;
    if (bw > 0 && bh > 0) lineCx.drawImage(src, bx, by, bw, bh, bx, by, bw, bh);
    lineCx.restore();
    const px = lineCx.getImageData(0, 0, wout, 48).data, n = wout * 48, data = new Float32Array(3 * n);
    let g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = px[i * 4];
    for (let k = 0; k < CFG.thin; k++) {       // 굵게 뭉친 획을 조금 가늘게 (밝은 쪽으로 최대값 필터)
      const o = new Uint8Array(n);
      for (let y = 0; y < 48; y++) for (let x = 0; x < wout; x++) { const i = y * wout + x; let v = g[i];
        if (x > 0 && g[i - 1] > v) v = g[i - 1]; if (x < wout - 1 && g[i + 1] > v) v = g[i + 1];
        if (y > 0 && g[i - wout] > v) v = g[i - wout]; if (y < 47 && g[i + wout] > v) v = g[i + wout]; o[i] = v; }
      g = o; }
    for (let i = 0; i < n; i++) { const v = g[flip ? n - 1 - i : i] / 127.5 - 1; data[i] = data[n + i] = data[2 * n + i] = v; }
    if (Q.get('crops') && (window.__crops = window.__crops || []).length < +Q.get('crops')) { const c = document.createElement('canvas'); c.width = wout; c.height = 48; c.getContext('2d').drawImage(lineCv, 0, 0); window.__crops.push(c.toDataURL()); }
    return { w: wout, data };
  }

  // 그림 한 장을 읽음. sample 을 주면 긴 줄 몇 개만 읽어 방향 판별용 신뢰도만 구함
  async function nnRead(nw, canvas, dpi, sample, flip) {
    const T0 = performance.now();
    const seg = segment(canvas, dpi); if (!seg) return null;
    const T1 = performance.now();
    const lines = textLines(seg); if (!lines.length) return null;
    const T2 = performance.now();
    if (sample) {
      const pick = lines.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0)).slice(0, sample);
      const up = await nw.rec(pick.map(l => lineTensor(canvas, l, false))), dn = await nw.rec(pick.map(l => lineTensor(canvas, l, true)));
      const avg = r => r.confs.reduce((s, v, i) => s + v * r.texts[i].length, 0) / Math.max(1, r.texts.reduce((s, t) => s + t.length, 0));
      return { up: avg(up), down: avg(dn) };
    }
    const groups = orderLines(lines, seg), flat = [];
    for (const g of groups) for (const l of g.lines) flat.push(l);
    const tens = flat.map(l => lineTensor(canvas, l, false)); const T3 = performance.now();
    const r = await nw.rec(tens);
    if (Q.get('debug')) console.log(`segment ${(T1 - T0) | 0}ms, textLines ${(T2 - T1) | 0}ms, order+crops ${(T3 - T2) | 0}ms, rec ${(performance.now() - T3) | 0}ms, 줄 ${flat.length}`);
    let k = 0, cs = 0, cn = 0, text = ''; const boxes = [];
    for (const g of groups) { let first = true;
      for (let i = 0; i < g.lines.length; i++, k++) { const t = r.texts[k], cf = r.confs[k], l = g.lines[i];
        if (Q.get('crops')) (window.__recs = window.__recs || []).push(cf.toFixed(2) + ' ' + t);
        if (!t || cf < 0.3) continue;        // 잡티를 글자로 읽은 것은 버림
        if (text) text += first ? '\n\n' : '\n';
        first = false;
        // 글줄의 네 모서리 (기울기 반영)
        const yA = l.rTop + l.b * l.x0, yB = l.rTop + l.b * l.x1;
        boxes.push([text.length, text.length + t.length, l.x0, Math.min(yA, yB), l.x1, Math.max(yA, yB) + l.t]);
        text += t; cs += cf * t.length; cn += t.length; } }
    return { text, boxes, W: canvas.width, H: canvas.height, conf: cn ? cs / cn : 0, chars: cn, table: seg.cells.length > 0 };
  }

  // 한 쪽을 신경망으로 읽음. 누웠거나 뒤집힌 쪽은 돌려서 읽음. 실패하면 null
  async function nnPage(nw, page, dpi, knownDeg) {
    const P0 = performance.now();
    let canvas = await renderToCanvas(page, dpi / 72, CFG.maxPx);
    if (CFG.prep) enhance(canvas);
    const P1 = performance.now(); let flipCheck = false;
    const W0 = canvas.width, H0 = canvas.height; let rot = 0;
    const turn = deg => { const c = rotated(canvas, deg); canvas.width = canvas.height = 0; canvas = c; rot = (rot + deg) % 360; };
    let res;
    if (linesAreVertical(canvas)) {
      turn(90);
      const sm = await nnRead(nw, canvas, dpi, 12);
      if (sm && sm.down > sm.up) turn(180);
      res = await nnRead(nw, canvas, dpi);
    } else {
      res = await nnRead(nw, canvas, dpi);
      if (res && res.conf < 0.8 && res.chars >= 8) { flipCheck = true;       // 신뢰도가 낮으면 위아래가 뒤집혔는지 확인
        const sm = await nnRead(nw, canvas, dpi, 12);
        if (sm && sm.down > sm.up + 0.08) { turn(180); res = await nnRead(nw, canvas, dpi) || res; }
      }
    }
    canvas.width = canvas.height = 0;
    if (res && res.boxes) {
      const back = (x, y) => { const Wr = res.W, Hr = res.H;      // 돌린 그림의 점 → 원래 쪽의 점
        return rot === 90 ? [y, Wr - x] : rot === 180 ? [Wr - x, Hr - y] : rot === 270 ? [Hr - y, x] : [x, y]; };
      res.boxes = res.boxes.map(([s, e, x0, y0, x1, y1]) => {
        const a = back(x0, y0), b = back(x1, y1);
        return [s, e, +(Math.min(a[0], b[0]) / W0).toFixed(4), +(Math.min(a[1], b[1]) / H0).toFixed(4), +(Math.max(a[0], b[0]) / W0).toFixed(4), +(Math.max(a[1], b[1]) / H0).toFixed(4), rot];
      });
    }
    if (Q.get('debug')) console.log(`nnPage render+enhance ${(P1 - P0) | 0}ms, 나머지 ${(performance.now() - P1) | 0}ms, 뒤집힘 확인 ${flipCheck}, conf ${res && res.conf.toFixed(2)}`);
    return res && res.chars ? res : null;
  }

  // ---------- 분석 결과 저장 (같은 파일을 다시 열면 바로 검색) ----------
  // 이 브라우저 안(IndexedDB)에만 저장. 어디로도 보내지 않음
  const CACHE_VER = 'v8';
  const idb = () => new Promise((ok, no) => {
    const r = indexedDB.open('pdf-page-finder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'key' });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  async function fileKey(buf, opts) {
    let h = '';
    try { const d = await crypto.subtle.digest('SHA-256', buf); h = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { h = 'n' + curFile.name + '|' + curFile.size + '|' + curFile.lastModified; }
    return CACHE_VER + '|' + opts + '|' + h;
  }
  async function cacheGet(key) {
    try { const db = await idb(); return await new Promise(ok => { const r = db.transaction('docs').objectStore('docs').get(key); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); }); }
    catch (e) { return null; }
  }
  async function cachePut(rec) {
    try {
      const db = await idb();
      const all = await new Promise(ok => { const r = db.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => ok([]); });
      const tx = db.transaction('docs', 'readwrite'), st = tx.objectStore('docs');
      all.sort((a, b) => b.at - a.at).slice(29).forEach(o => st.delete(o.key));    // 최근 30개만 보관
      st.put(rec);
      await new Promise(ok => { tx.oncomplete = ok; tx.onerror = ok; });
    } catch (e) { console.warn('결과 저장 실패', e); }
  }
  async function cacheClear() {
    try { const db = await idb(); const tx = db.transaction('docs', 'readwrite'); tx.objectStore('docs').clear(); await new Promise(ok => { tx.oncomplete = ok; tx.onerror = ok; }); } catch (e) {}
  }

  // ---------- 분석 ----------
  const fmtLeft = sec => sec < 60 ? `약 ${Math.max(5, Math.round(sec / 5) * 5)}초 남음` : `약 ${Math.round(sec / 60)}분 남음`;
  async function analyze(file) {
    const my = ++runId; if (NN.cancel) NN.cancel();
    curFile = file; pages = []; total = 0; pdf = null; running = true;
    $('dropTitle').textContent = file.name;
    $('dropSub').textContent = '다른 파일을 분석하려면 다시 누르거나 끌어다 놓으세요';
    bar.classList.remove('hidden'); bar.value = 0; $('stop').classList.remove('hidden');
    setStatus('PDF를 여는 중…'); search();
    try {
      const data = await file.arrayBuffer();
      const optsKey = ($('force').checked ? 'F' : '-') + ($('fine').checked ? 'P' : '-');
      const key = Q.get('nocache') ? null : await fileKey(data.slice(0), optsKey);
      const doc = await pdfjsLib.getDocument({ data, CMapReaderFactory: EmbeddedCMaps, cMapPacked: true }).promise;
      if (my !== runId) return;
      pdf = doc; total = doc.numPages; bar.max = total;
      if (key) {
        const hit = await cacheGet(key);
        if (my !== runId) return;
        if (hit && hit.total === total) {
          pages = hit.pages.map(p => ({ n: p.n, src: p.src, layers: p.layers.map(L => Object.assign({ text: L.t, boxes: L.b || null }, normalize(L.t))) }));
          running = false; bar.value = total; $('stop').classList.add('hidden');
          const when = new Date(hit.at).toLocaleString();
          setStatus(`저장해 둔 분석 결과를 불러왔습니다 (전체 ${total}쪽, ${when} 분석) · 바로 검색할 수 있습니다`, 'ok');
          search(); return;
        }
      }
      const lang = 'kor', force = $('force').checked, fine = $('fine').checked;
      await resetPool(lang); analyzedLang = lang;
      let next = 1, done = 0, ocrCount = 0, ocrStart = 0, nnDone = 0, engineNote = '';
      const t0 = performance.now();
      // 1단계: 글자 정보가 있으면 그대로, 없으면 빠른 엔진(Tesseract)으로 전체를 훑음 → 바로 검색 가능
      // 2단계: 신경망 엔진(PP-OCRv5)으로 스캔 쪽을 다시 읽어 결과를 보강
      const ocrPages = [], confOf = {};
      const nWork = Math.min(CFG.workers, total);
      const nnOn = fine && NN.ok;
      const pool2 = nnOn ? nnPool(() => my === runId) : null;
      const ready2 = [];                 // 1차가 끝나 2차를 기다리는 쪽
      let left1 = nWork, inflight = 0, t1 = 0, k2 = 0, done2 = 0, t2 = 0, wake = null;
      const poke = () => { if (wake) { const f = wake; wake = null; f(); } };
      const slotNN = [];
      NN.cancel = poke;                  // 중지하면 기다리던 2차 작업도 바로 끝냄
      const toNN = slot => {            // 이 작업자 자리를 Tesseract → 신경망으로 바꿈
        if (!pool2 || slotNN[slot]) return; slotNN[slot] = true;
        if (pool[slot]) { pool[slot].then(w => w.terminate()).catch(() => {}); pool[slot] = null; }
        pool2.add(nnWorker()); poke();
      };
      const status2 = () => {
        let left = '';
        if (done2 >= 2) left = ' · ' + fmtLeft((performance.now() - t2) / 1000 / done2 * (ocrPages.length - done2));
        setStatus(`1차 판독 완료(${t1}초), 검색할 수 있습니다 · 정밀 판독 ${done2}/${ocrPages.length}쪽${left}`);
      };
      const loop1 = async slot => {
        while (my === runId) {
          const n = next++; if (n > total) break;
          const page = await doc.getPage(n);
          let text = '', text2 = '', src = 'text', tboxes = [];
          if (!force) {
            const tc = await page.getTextContent();
            const vp = page.getViewport({ scale: 1 });
            for (const it of tc.items) {
              if (it.str) {
                const tx = pdfjsLib.Util.transform(vp.transform, it.transform), fh = Math.hypot(tx[2], tx[3]) || 10;
                const x0 = tx[4], y1 = tx[5], x1 = x0 + (it.width || 0) * vp.scale, y0 = y1 - fh;
                tboxes.push([text.length, text.length + it.str.length, +(x0 / vp.width).toFixed(4), +(y0 / vp.height).toFixed(4), +(x1 / vp.width).toFixed(4), +(y1 / vp.height).toFixed(4), 0]);
              }
              text += it.str + (it.hasEOL ? '\n' : ' ');
            }
          }
          if (text.replace(/\s/g, '').length < 20) {
            src = 'ocr';
            if (!ocrCount && CFG.overlap) for (let i = nWork; i < CFG.workers; i++) toNN(i);   // 쪽 수보다 코어가 많으면 남는 코어에서 신경망 엔진을 미리 준비
            if (!ocrStart) { ocrStart = performance.now(); if (!ocrCount) setStatus('글자 인식 엔진 준비 중…'); }
            if (!pool[slot]) pool[slot] = makeWorker(lang);
            const w = await pool[slot];
            if (my !== runId) return;
            const r = await ocrPage(w, page, CFG.dpi1, CFG.psm);
            text = r.text;
            if (!r.table && text.replace(/\s/g, '').length < 250 && my === runId) { await setPsm(w, '6'); text2 = (await ocrCanvas(w, r.canvas, r.deg)).text; }
            if (r.canvas) r.canvas.width = r.canvas.height = 0;
            ocrCount++; ocrPages.push(n); confOf[n] = r.conf || 0;
            if (Q.get('debug')) console.log('p' + n + ' 1차 신뢰도 ' + (r.conf || 0).toFixed(1));
          }
          page.cleanup();
          if (my !== runId) return;
          const layers = [Object.assign({ text, boxes: src === 'text' ? tboxes : null }, normalize(text))];
          if (text2) layers.push(Object.assign({ text: text2 }, normalize(text2)));
          pages[n - 1] = { n, src, layers };
          if (src === 'ocr' && pool2 && confOf[n] < CFG.skip2) { ready2.push(n); poke(); }
          done++; if (!t1) bar.value = done;
          let left = '';
          if (ocrCount >= 2) left = ' · 1차 ' + fmtLeft((performance.now() - ocrStart) / 1000 / ocrCount * (total - done));
          if (!t1) setStatus(`1차 판독: ${total}쪽 중 ${done}쪽 완료${left}`);
          searchSoon();
        }
        if (my !== runId) return;
        if (CFG.overlap && ocrCount) toNN(slot);
        if (--left1 === 0) {            // 1차 판독 끝
          t1 = Math.max(1, Math.round((performance.now() - t0) / 1000));
          search();
          if (pool2 && ocrPages.length) {
            for (let i = 0; i < CFG.workers; i++) toNN(i);     // 쪽 수가 적어도 글줄을 나눠 모든 코어로 읽음
            for (const p of pool) if (p) p.then(w => w.terminate()).catch(() => {});
            pool = []; poolLang = '';
            if (CFG.skip2 < 100) ocrPages.splice(0, ocrPages.length, ...ocrPages.filter(n => confOf[n] < CFG.skip2));
            bar.max = ocrPages.length; bar.value = done2;
            if (done2) status2(); else setStatus(`1차 판독 완료(${t1}초), 검색할 수 있습니다 · 정밀 판독 준비 중…`);
          }
          poke();
        }
      };
      // 2차: 1차가 끝난 쪽을 신경망 엔진으로 다시 읽음 (신경망 작업자가 하나라도 생기면 시작)
      const loop2 = async () => {
        while (my === runId && NN.ok) {
          if (!(ready2.length > k2 && pool2.size && inflight < pool2.size + CFG.ahead)) {
            if (left1 === 0 && ready2.length <= k2) return;
            await new Promise(f => { const prev = wake; wake = () => { if (prev) prev(); f(); }; });
            continue;
          }
          const n = ready2[k2++]; inflight++;
          if (!t2) t2 = performance.now();
          let r = null;
          try {
            const page = await doc.getPage(n);
            r = await nnPage(pool2, page, CFG.dpi);
            page.cleanup();
          } catch (e) { if (my !== runId) return; console.error(e); if (!nnDone) { NN.ok = false; engineNote = ' · 신경망 엔진을 쓸 수 없어 1차 판독 결과만 사용'; } }
          inflight--; poke();
          if (my !== runId) return;
          if (r) { nnDone++; const p = pages[n - 1]; p.layers.unshift(Object.assign({ text: r.text, boxes: r.boxes }, normalize(r.text))); }
          done2++;
          if (t1) { bar.value = done2; status2(); }
          searchSoon();
        }
      };
      await Promise.all([...Array.from({ length: nWork }, (_, i) => loop1(i)), ...(pool2 ? Array.from({ length: nWork }, loop2) : [])]);
      if (pool2) pool2.close();
      if (my !== runId) return;
      running = false;
      $('stop').classList.add('hidden');
      const sec = Math.round((performance.now() - t0) / 1000);
      if (key && !engineNote) cachePut({ key, at: Date.now(), name: file.name, total, pages: pages.map(p => ({ n: p.n, src: p.src, layers: p.layers.map(L => ({ t: L.text, b: L.boxes })) })) });
      setTimeout(prewarm, 1500);        // 다음 파일을 위해 1차 엔진을 미리 준비
      setStatus(`분석 완료: 전체 ${total}쪽 (OCR ${ocrCount}쪽, 글자 정보 사용 ${total - ocrCount}쪽) · ${sec}초${engineNote}`, 'ok');
      search();
    } catch (e) {
      if (my !== runId) return;
      runId++; running = false; $('stop').classList.add('hidden');
      console.error(e);
      const msg = e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없습니다.'
        : '분석 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e);
      setStatus(msg, 'err');
    }
  }

  // ---------- 검색 ----------
  // 비슷한 글자 찾기: text 안에서 pat 과 편집거리 k 이하인 구간을 모두 찾음 (자모 단위)
  function fuzzyFind(text, pat, k) {
    const m = pat.length, n = text.length;
    let D = new Uint16Array(m + 1), S = new Int32Array(m + 1), D2 = new Uint16Array(m + 1), S2 = new Int32Array(m + 1);
    for (let i = 0; i <= m; i++) D[i] = i;
    const raw = [];
    for (let j = 1; j <= n; j++) {
      const c = text.charCodeAt(j - 1);
      D2[0] = 0; S2[0] = j;
      for (let i = 1; i <= m; i++) {
        let best = D[i - 1] + (pat.charCodeAt(i - 1) === c ? 0 : 1), st = S[i - 1];
        if (D[i] + 1 < best) { best = D[i] + 1; st = S[i]; }
        if (D2[i - 1] + 1 < best) { best = D2[i - 1] + 1; st = S2[i - 1]; }
        D2[i] = best; S2[i] = st;
      }
      if (D2[m] <= k) raw.push({ s: S2[m], e: j, d: D2[m] });
      let t = D; D = D2; D2 = t; t = S; S = S2; S2 = t;
    }
    const hits = [];
    for (const h of raw) {       // 겹치는 후보는 가장 가까운 것 하나만
      const last = hits[hits.length - 1];
      if (last && h.s < last.e) { if (h.d < last.d) hits[hits.length - 1] = h; }
      else hits.push(h);
    }
    return hits;
  }
  const tolerance = m => m < 6 ? 0 : m < 11 ? 1 : m < 17 ? 2 : 3;

  let searchTimer = null, lastSearch = 0;
  function searchSoon() {   // 분석 중에는 너무 자주 다시 찾지 않도록 간격을 둠
    if (searchTimer) return;
    const wait = Math.max(0, 1200 - (performance.now() - lastSearch));
    searchTimer = setTimeout(() => { searchTimer = null; search(); }, wait);
  }

  function search() {
    lastSearch = performance.now();
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }   // 지금 찾으므로 미뤄 둔 검색은 취소
    const raw = qEl.value.trim();
    const q = normalize(raw).out;
    hitsEl.innerHTML = ''; chipsEl.innerHTML = '';
    if (!curFile || !q) { summaryEl.textContent = ''; return; }
    const fuzzyOn = $('fuzzy').checked;
    const qj = normalize(raw, true).out, k = fuzzyOn ? tolerance(qj.length) : 0;
    const done = pages.filter(Boolean);
    const found = [];
    for (const p of done) {
      let hit = null;
      for (const L of p.layers) {
        const spans = []; let i = L.out.indexOf(q);
        while (i !== -1) { spans.push([L.map[i], L.map[i + q.length - 1] + 1]); i = L.out.indexOf(q, i + q.length); }
        if (spans.length) { hit = { p, L, spans, fuzzy: false }; break; }
      }
      if (!hit && k > 0) for (const L of p.layers) {
        if (!L.j) L.j = normalize(L.text, true);
        const hs = fuzzyFind(L.j.out, qj, k);
        if (hs.length) { hit = { p, L, fuzzy: true, spans: hs.map(h => [L.j.map[h.s], L.j.map[h.e - 1] + 1]) }; break; }
      }
      if (hit) found.push(hit);
    }
    const partial = !running ? '' : total && done.length === total ? ' (정밀 판독 중이라 결과가 더 나올 수 있습니다)' : ` (지금까지 분석한 ${done.length}/${total || '?'}쪽 기준)`;
    if (!found.length) {
      summaryEl.textContent = `"${raw}" 을(를) 찾지 못했습니다${partial}.` +
        (running ? '' : ' 스캔 상태가 흐리면 인식이 틀릴 수 있으니 더 짧은 단어로도 찾아보세요.');
      return;
    }
    const exact = found.filter(f => !f.fuzzy), fz = found.filter(f => f.fuzzy);
    const parts = [];
    if (exact.length) parts.push(`${exact.length}개 페이지에서 ${exact.reduce((s, f) => s + f.spans.length, 0)}건 발견`);
    if (fz.length) parts.push(`비슷한 표현 ${fz.length}개 페이지`);
    summaryEl.textContent = `"${raw}" — ${parts.join(', ')}${partial}`;
    for (const { p, L, spans, fuzzy } of found) {
      const chip = document.createElement('button');
      chip.className = 'chip' + (fuzzy ? ' fz' : ''); chip.textContent = p.n + '쪽' + (fuzzy ? ' ?' : '');
      chip.title = fuzzy ? '글자가 조금 다른 비슷한 표현' : '정확히 일치';
      chip.onclick = () => preview(p.n, raw);
      chipsEl.appendChild(chip);

      const div = document.createElement('div'); div.className = 'hit';
      const head = document.createElement('div'); head.className = 'hit-head';
      const b = document.createElement('button'); b.textContent = p.n + '쪽 보기'; b.onclick = () => preview(p.n, raw);
      const sm = document.createElement('small');
      sm.textContent = (fuzzy ? `비슷한 표현 ${spans.length}건 (인식 오류일 수 있음)` : `${spans.length}건`) + (p.src === 'ocr' ? ' · OCR 인식' : '');
      head.append(b, sm); div.appendChild(head);
      for (const [s, e] of spans.slice(0, 3)) {
        const a = Math.max(0, s - 40), z = Math.min(L.text.length, e + 40);
        const clean = t => esc(t.replace(/\s+/g, ' '));
        const snip = document.createElement('p'); snip.className = 'snip';
        snip.innerHTML = (a > 0 ? '… ' : '') + clean(L.text.slice(a, s)) + '<mark>' + clean(L.text.slice(s, e)) + '</mark>' + clean(L.text.slice(e, z)) + (z < L.text.length ? ' …' : '');
        div.appendChild(snip);
      }
      if (spans.length > 3) {
        const more = document.createElement('p'); more.className = 'snip'; more.textContent = `외 ${spans.length - 3}건`;
        div.appendChild(more);
      }
      hitsEl.appendChild(div);
    }
  }

  // 쪽 안에서 검색어 위치 찾기: 위치 정보가 있는 판독 결과에서 정확히 → 비슷하게 순서로 찾고, 글줄 상자 안에서 글자 비율로 범위를 좁힘
  function locate(p, raw) {
    const q = normalize(raw).out, qj = normalize(raw, true).out; if (!q) return [];
    const rects = (L, spans) => {
      const out = [];
      for (const [s, e] of spans) for (const [bs, be, x0, y0, x1, y1, rot] of L.boxes) {
        if (e <= bs || s >= be) continue;
        const len = Math.max(1, be - bs), f0 = Math.max(0, (s - bs) / len), f1 = Math.min(1, (e - bs) / len);
        const vert = rot === 90 || rot === 270, flip = rot === 180;
        if (!vert) { const w = x1 - x0, a = flip ? x1 - f1 * w : x0 + f0 * w, b = flip ? x1 - f0 * w : x0 + f1 * w; out.push([a, y0, b, y1]); }
        else { const h = y1 - y0, a = rot === 270 ? y0 + f0 * h : y1 - f1 * h, b = rot === 270 ? y0 + f1 * h : y1 - f0 * h; out.push([x0, a, x1, b]); }
      }
      return out;
    };
    const withBoxes = p.layers.filter(L => L.boxes && L.boxes.length);
    for (const L of withBoxes) {
      const spans = []; let i = L.out.indexOf(q);
      while (i !== -1) { spans.push([L.map[i], L.map[i + q.length - 1] + 1]); i = L.out.indexOf(q, i + q.length); }
      if (spans.length) return rects(L, spans);
    }
    const k = Math.max(1, tolerance(qj.length));
    for (const L of withBoxes) {
      if (!L.j) L.j = normalize(L.text, true);
      const hs = fuzzyFind(L.j.out, qj, k);
      if (hs.length) return rects(L, hs.map(h => [L.j.map[h.s], L.j.map[h.e - 1] + 1]));
    }
    return [];
  }

  async function preview(n, raw) {
    if (!pdf) return;
    $('pvTitle').textContent = `${n}쪽 / 전체 ${total}쪽`;
    $('pvText').textContent = pages[n - 1] ? pages[n - 1].layers.map(L => L.text).join('\n──────── 2차 판독 ────────\n') : '';
    const dlg = $('dlg'); if (!dlg.open) dlg.showModal();
    $('pvNote').textContent = '';
    const page = await pdf.getPage(n);
    const c = await renderToCanvas(page, 2.2, 2400);
    const pv = $('pv'); pv.width = c.width; pv.height = c.height;
    const ctx = pv.getContext('2d'); ctx.drawImage(c, 0, 0); c.width = c.height = 0;
    const rs = raw && pages[n - 1] ? locate(pages[n - 1], raw) : [];
    if (rs.length) {
      const W = pv.width, H = pv.height, pad = 4;
      ctx.save(); ctx.fillStyle = 'rgba(255, 214, 0, 0.35)'; ctx.strokeStyle = 'rgba(230, 120, 0, 0.95)'; ctx.lineWidth = 3;
      for (const [x0, y0, x1, y1] of rs) { const x = x0 * W - pad, y = y0 * H - pad, w = (x1 - x0) * W + 2 * pad, h = (y1 - y0) * H + 2 * pad; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); }
      ctx.restore();
      $('pvNote').textContent = `노란 상자: "${raw}" 위치 ${rs.length}곳 (글자 인식 결과 기준이라 조금 어긋날 수 있습니다)`;
      const top = Math.min(...rs.map(r => r[1]));
      requestAnimationFrame(() => { const y = pv.offsetTop + top * pv.clientHeight - dlg.clientHeight / 3; dlg.scrollTop = Math.max(0, y); });
    } else if (raw) $('pvNote').textContent = '이 쪽에서 정확한 위치는 표시하지 못했습니다. 쪽 전체에서 찾아보세요.';
  }

  window.__pages = () => pages.map(p => p ? p.layers.map(L => L.text).join('\n=== 2차 ===\n') : '');   // 점검용
  function pick(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setStatus('PDF 파일만 사용할 수 있습니다.', 'err'); return; }
    analyze(file);
  }

  // 파일을 고르기 전에 엔진을 미리 준비해 두어 분석 시작이 빨라지게 함
  function prewarm() {
    if (running || pool.some(Boolean) || !CFG.warm) return;
    poolLang = 'kor';
    pool = Array.from({ length: CFG.workers }, (_, i) => { const p = makeWorker('kor'); p.catch(() => { if (pool[i] === p) pool[i] = null; }); return p; });
    if (NN.ok) nnRes().catch(() => {});
  }

  drop.onclick = () => fileInput.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  fileInput.onchange = () => { pick(fileInput.files[0]); fileInput.value = ''; };
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  document.addEventListener('drop', e => pick(e.dataTransfer.files[0]));
  $('stop').onclick = () => {
    runId++; if (NN.cancel) NN.cancel(); running = false; $('stop').classList.add('hidden');
    setStatus(`중지됨: ${pages.filter(Boolean).length}/${total}쪽까지 분석했습니다.`); search();
  };
  $('force').onchange = $('fine').onchange = () => { if (curFile) analyze(curFile); };
  $('clearCache').onclick = async () => { await cacheClear(); $('clearCache').textContent = '저장된 결과를 지웠습니다'; };
  $('go').onclick = search;
  $('fuzzy').onchange = search;
  let typing = null;
  qEl.oninput = () => { clearTimeout(typing); typing = setTimeout(search, 150); };
  qEl.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(typing); search(); } };
  $('pvClose').onclick = () => $('dlg').close();
  if (early) { pick(early); early = null; }
  setTimeout(prewarm, 0);              // 화면 동작을 다 연결한 뒤에 준비 시작
})();
