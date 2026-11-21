(async () => {
  const $ = id => document.getElementById(id);
  const drop = $('drop'), fileInput = $('file'), bar = $('bar'), statusEl = $('status');
  const qEl = $('q'), hitsEl = $('hits'), chipsEl = $('chips'), summaryEl = $('summary');
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }
  let early = null;                     // 준비가 끝나기 전에 고른 파일은 기억했다가 준비되면 분석
  fileInput.onchange = () => { early = [...fileInput.files]; };
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
  // 동시 처리 수: 8코어까지는 코어 수만큼. 코어가 더 많고 메모리가 8GB 이상이면 화면 쪽 일·브라우저 몫으로 4개를 남기고 최대 16개
  let autoWorkers = Math.max(1, Math.min(8, cores));
  if (cores > 8 && (navigator.deviceMemory || 8) >= 8) autoWorkers = Math.min(16, Math.max(8, cores - 4));
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
    prepw: Q.get('prepw') !== '0',        // 전처리·표/글줄 찾기·글줄 자르기를 준비 작업자에게 맡김
    gpu: Q.get('gpu') || 'auto',          // 그래픽카드(WebGPU) 판독: auto(인텔 내장 그래픽은 안 씀) | 1(내장 그래픽도 사용) | 0(끄기) | force(느려도·소프트웨어 그래픽이어도 사용, 시험용)
    gpuBatch: +Q.get('gpuBatch') || 16,   // 그래픽카드 작업자가 한 번에 가져가는 최대 글줄 수
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
  // 여러 파일: 차례로 분석하고, 검색은 모든 파일에서. 파일마다 { file, name, pdf, pages, total, state: wait|run|done|stop|err, note }
  const docs = [], queue = []; let curDoc = null;

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
  const IP = makeImgProc(CFG, () => document.createElement('canvas'), { line: (g, wout, flip, lineCv) => {
    if (Q.get('dumpg') && !flip) (window.__g = window.__g || []).push({ w: wout, g: g.slice() });   // 시험용: 신경망에 넣은 글줄 그림 저장
    if (Q.get('crops') && (window.__crops = window.__crops || []).length < +Q.get('crops')) { const c = document.createElement('canvas'); c.width = wout; c.height = 48; c.getContext('2d').drawImage(lineCv, 0, 0); window.__crops.push(c.toDataURL()); }
  } });
  const { enhance, rotated, linesAreVertical, segment, tableImages } = IP;
  const OUT = { text: true, blocks: false, hocr: false, tsv: false };
  // 그림을 압축 없는 회색 PGM 으로 넘김: 캔버스를 넘기면 PNG 로 압축(화면 쪽)하고 작업자가 다시 푸느라 시간이 듦. 픽셀은 같음
  // 그림은 캔버스이거나, 준비 작업자가 보낸 회색 값 { width, height, gray, vertical }
  function toPGM(img) {
    const W = img.width, H = img.height, head = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
    if (img.gray) return new Blob([head, img.gray]);
    const d = img.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    return new Blob([head, out]);
  }
  const asCanvas = img => img.gray ? (img.cv || (img.cv = IP.canvasOf(img))) : img;
  const free = img => { if (img.gray) { if (img.cv) img.cv.width = img.cv.height = 0; img.gray = img.cv = null; } else img.width = img.height = 0; };
  async function recog(w, img, deg) {
    const c = deg ? rotated(asCanvas(img), deg) : img;
    const r = (await w.recognize(toPGM(c), { rotateAuto: CFG.rot }, OUT)).data;
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
    const vertical = canvas.vertical !== undefined ? canvas.vertical : linesAreVertical(asCanvas(canvas));
    if (Q.get('debug')) console.log('linesAreVertical', vertical);
    if (vertical) {          // 옆으로 누운 쪽: 두 방향을 모두 읽어 더 잘 읽힌 쪽 선택
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

  async function setPsm(w, v) { if (w.__psm !== v) { await w.setParameters({ tessedit_pageseg_mode: v }); w.__psm = v; } }
  // 표가 있는 쪽: 칸 밖은 일반 방식으로, 칸 안은 칸 단위로 읽음. 잘 안 읽히면 null (일반 방식으로 되돌아감)
  async function ocrTable(w, t, psm) {
    const parts = []; let conf = 0, n = 0;
    if (t.restInk > 80 * t.sc * t.sc) { await setPsm(w, psm); parts.push((await recog(w, t.rest, 0)).text); }
    await setPsm(w, CFG.psmc);
    let ratio = 0;
    for (const s of t.strips) { const r = await recog(w, s, 0); parts.push(r.text); conf += r.conf; ratio += r.ratio; n++; free(s); }
    free(t.rest);
    if (!n || conf / n < 45 || ratio / n < 0.35) return null;
    return { text: parts.join('\n'), deg: 0, table: true, conf: conf / n };
  }
  // 한 쪽을 그려서 읽음. 그린 뒤 전처리·표 찾기는 준비 작업자가 하고(있으면) 화면 쪽은 그리기만 함
  async function ocrPage(w, page, dpi, psm, knownDeg) {
    if (PREP.on) try { return await ocrPageWith(true, w, page, dpi, psm, knownDeg); } catch (e) { prepFail(e); }
    return ocrPageWith(false, w, page, dpi, psm, knownDeg);
  }
  async function ocrPageWith(remote, w, page, dpi, psm, knownDeg) {
    const P0 = performance.now();
    const canvas = await renderToCanvas(page, dpi / 72, CFG.maxPx);
    const P1 = performance.now();
    let pr;     // { img: 정리한 쪽 그림, table: { rest, strips, restInk, sc } | null }
    if (remote) pr = await PREP.call('p1', canvas, { dpi, prep: CFG.prep, table: CFG.table, useTable: !knownDeg });
    else {
      if (CFG.prep) enhance(canvas);
      const seg = CFG.table ? segment(canvas, dpi) : null;
      pr = { img: canvas, table: seg && seg.cells.length && !knownDeg ? Object.assign(tableImages(seg), { sc: seg.sc }) : null };
    }
    if (Q.get('debug')) console.log(`1차 render ${(P1 - P0) | 0}ms 전처리·표 찾기${remote ? '(작업자)' : ''} ${(performance.now() - P1) | 0}ms`);
    let res = pr.table ? await ocrTable(w, pr.table, psm) : null;
    if (!res) { await setPsm(w, psm); res = await ocrCanvas(w, pr.img, knownDeg); res.canvas = pr.img; }
    else free(pr.img);
    return res;
  }

  // ---------- 준비 작업자: 그린 쪽의 전처리·표/글줄 찾기·글줄 자르기를 화면 쪽 대신 함 ----------
  // 코어가 많은 컴퓨터에서 화면 쪽(메인 스레드)이 막혀 작업자들이 기다리는 것을 막음
  const PREP = { on: CFG.prepw && typeof OffscreenCanvas !== 'undefined' && !Q.get('dumpg') && !Q.get('crops'), ws: [], seq: 0, src: null };
  function prepFail(e) { console.warn('준비 작업자를 쓸 수 없어 화면 쪽에서 처리:', e); PREP.on = false; PREP.ws.forEach(x => x.w.terminate()); PREP.ws = []; }
  PREP.get = async () => {    // 할 일이 가장 적은 작업자 (처음 부를 때 만듦)
    if (!PREP.ws.length) {
      if (!PREP.src) PREP.src = new TextDecoder().decode(await asset('a-prepworker', true));
      if (PREP.ws.length) return PREP.ws.reduce((a, b) => b.load < a.load ? b : a);
      const url = URL.createObjectURL(new Blob(['const makeImgProc = ' + makeImgProc.toString() + ';\n', PREP.src], { type: 'text/javascript' }));
      for (let i = 0; i < Math.max(1, Math.round(CFG.workers / 6)); i++) {
        const w = new Worker(url), x = { w, load: 0, pend: new Map() };
        w.onmessage = e => { const p = x.pend.get(e.data.id); if (!p) return; x.pend.delete(e.data.id); x.load--; e.data.error ? p.no(new Error(e.data.error)) : p.ok(e.data); };
        w.onerror = e => { for (const p of x.pend.values()) p.no(new Error(e.message || '준비 작업자 오류')); x.pend.clear(); };
        w.postMessage({ type: 'init', cfg: CFG });
        PREP.ws.push(x);
      }
    }
    return PREP.ws.reduce((a, b) => b.load < a.load ? b : a);
  };
  PREP.send = (x, m, tr) => new Promise((ok, no) => { m.id = ++PREP.seq; x.load++; x.pend.set(m.id, { ok, no }); x.w.postMessage(m, tr || []); });
  // 그린 캔버스의 픽셀을 작업자로 넘기고(캔버스는 비움) 결과를 받음
  PREP.call = async (type, canvas, extra) => {
    const x = await PREP.get();
    const W = canvas.width, H = canvas.height, buf = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data.buffer;
    canvas.width = canvas.height = 0;
    const r = await PREP.send(x, Object.assign({ type, W, H, buf }, extra), [buf]);
    r.x = x; return r;
  };

  // ---------- 신경망 인식 (PP-OCRv5 한국어) ----------
  // 메인 스레드가 바빴던 시간(50ms 넘게 막힌 일의 합). 코어가 많은 컴퓨터에서 병목인지 보려고 잼
  let mainBusy = 0;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) mainBusy += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  const NN = { ok: !!$('a-ort') && CFG.engine !== 'tess', pool: [], res: null };
  const GPU = { state: CFG.gpu === '0' ? 'off' : 'idle', why: CFG.gpu === '0' ? '주소에 ?gpu=0 을 붙여 꺼 둠' : '', w: null, p: null, name: '', speed: 0 };
  const gpuEl = document.createElement('div'); gpuEl.id = 'gpuNote';
  gpuEl.style.cssText = 'font-size:.85rem;color:var(--muted);margin-top:4px';
  statusEl.insertAdjacentElement('afterend', gpuEl);
  const nnRes = () => NN.res || (NN.res = (async () => { const T = performance.now(); const R = {
        url: URL.createObjectURL(new Blob([await asset('a-ort', true), '\n;', await asset('a-recworker', true)], { type: 'text/javascript' })),
        mjs: new TextDecoder().decode(await asset('a-ortmjs', true)),
        wasm: await asset('a-ortwasm', true), model: await asset('a-recmodel', true), weights: await asset('a-recw', true),
        dict: new TextDecoder().decode(await asset('a-recdict', true))
      }; if (Q.get('debug')) console.log('NN 자원 ' + ((performance.now() - T) | 0) + 'ms'); return R; })());
  // ep: 'wasm'(CPU) | 'webgpu'(그래픽카드)
  function nnWorker(ep = 'wasm') {
    return (async () => {
      const R = await nnRes(), gpu = ep === 'webgpu';
      if (gpu) {        // 그래픽카드가 보일 때만 그래픽카드용 엔진을 풀어 씀
        const a = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
        const ai = (a && a.info) || {};
        // 인텔 내장 그래픽은 CPU와 전력·메모리를 나눠 써서 분석 중엔 오히려 느려짐(사용자 컴퓨터에서 확인). 인텔 독립형(Arc, …hpg)은 사용
        if (a && CFG.gpu === 'auto' && /intel/i.test(ai.vendor || '') && !/hpg/i.test(ai.architecture || ''))
          throw new Error(`내장 그래픽(${ai.architecture || 'intel'})은 CPU와 전력을 나눠 써서 오히려 느려짐 — 켜려면 주소 끝에 ?gpu=1`);
        if (!a) throw new Error(navigator.gpu ? '브라우저가 그래픽카드를 내주지 않음 — 주소창에 chrome://gpu (엣지는 edge://gpu) 를 열어 WebGPU 항목 확인' : '이 브라우저는 WebGPU를 지원하지 않음');
        if (!NN.gres) NN.gres = (async () => ({
          url: URL.createObjectURL(new Blob([await asset('a-ortgpu', true), '\n;', await asset('a-recworker', true)], { type: 'text/javascript' })),
          mjs: new TextDecoder().decode(await asset('a-ortgpumjs', true)), wasm: await asset('a-ortgpuwasm', true), model: await asset('a-recgpu', true) }))();
      }
      const G = gpu ? await NN.gres : R, model = G.model;
      const w = new Worker(G.url); let seq = 0; const pend = new Map();
      w.onmessage = e => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.type === 'error' ? p.no(new Error(e.data.message)) : p.ok(e.data); };
      w.onerror = e => { for (const p of pend.values()) p.no(new Error(e.message || '인식 작업자 오류')); pend.clear(); };
      const call = (m, tr) => new Promise((ok, no) => { m.id = ++seq; pend.set(m.id, { ok, no }); w.postMessage(m, tr || []); });
      const Ti = performance.now();
      let ready;
      try { ready = await call({ type: 'init', ep, force: CFG.gpu === 'force', mjs: G.mjs, wasm: G.wasm, model, weights: R.weights, dict: R.dict }); }
      catch (e) { w.terminate(); throw e; }
      if (Q.get('debug')) console.log(ep + ' init ' + ((performance.now() - Ti) | 0) + 'ms' + (gpu ? `, 글줄 너비 1픽셀당 ${ready.msPerCol.toFixed(4)}ms` : ''));
      // 그래픽카드 작업자는 실패하면 같은 글줄을 CPU가 다시 읽어야 하므로 자료를 넘기지 않고 복사해서 보냄
      return { gpu, msPerCol: ready.msPerCol, name: ready.gpuName || '', rec: lines => call({ type: 'rec', lines }, gpu ? [] : lines.map(l => l.data.buffer)), terminate: () => w.terminate() };
    })();
  }

  // 신경망 작업자 묶음: 한 쪽의 글줄을 몇 줄씩 나눠 쉬는 작업자가 바로 가져가 읽음 → 마지막 쪽도 모든 코어가 함께 읽음
  // 그래픽카드 작업자가 있으면 여러 묶음을 한 번에 가져감. 실패하거나 CPU보다 느리면 빼고 CPU로 계속
  function nnPool(live) {
    const idle = [], q = [], all = []; let size = 0, closed = false, failed = null;
    const st = { cpuMs: 0, cpuN: 0, cpuCols: 0, gpuMs: 0, gpuN: 0, gpuCols: 0, gpuRuns: 0, gpuWhy: '' };
    // CPU 작업자 하나의 글줄 너비 1픽셀당 시간 (아직 잰 것이 없으면 4코어 시험 컴퓨터에서 잰 값)
    const cpuPerCol = () => st.cpuCols >= 4000 ? st.cpuMs / st.cpuCols : 0.26;
    const retire = (w, why) => { const i = all.indexOf(w); if (i >= 0) all.splice(i, 1); size--; w.terminate(); st.gpuWhy = why; console.warn('그래픽카드 판독 중단:', why);
      if (w === GPU.w) { GPU.w = null; GPU.state = 'off'; GPU.why = why; gpuShow(); } };
    const pump = () => {
      while (idle.length && q.length) {
        const w = idle.pop(), jobs = [q.shift()];
        if (!live()) { jobs[0].no(new Error('중지됨')); idle.push(w); continue; }
        if (w.gpu) { let n = jobs[0].lines.length; while (q.length && n + q[0].lines.length <= CFG.gpuBatch) { n += q[0].lines.length; jobs.push(q.shift()); } }
        const lines = jobs.flatMap(j => j.lines), t0 = performance.now(), cols = lines.reduce((a, l) => a + l.w, 0);
        w.rec(lines).then(r => {
          const ms = performance.now() - t0;
          if (w.gpu) { st.gpuMs += ms; st.gpuN += lines.length; st.gpuCols += cols; st.gpuRuns++; } else { st.cpuMs += ms; st.cpuN += lines.length; st.cpuCols += cols; }
          let k = 0; for (const j of jobs) { const n = j.lines.length; j.ok({ texts: r.texts.slice(k, k + n), confs: r.confs.slice(k, k + n) }); k += n; }
          if (closed) return;
          // 그래픽카드가 CPU 작업자 하나보다 느리면 빼냄 (처음 몇 번은 모양별 준비 시간이 섞여 있어 기다림)
          if (w.gpu && CFG.gpu !== 'force' && st.gpuRuns >= 4 && st.gpuMs / st.gpuCols > cpuPerCol()) return retire(w, 'CPU보다 느림');
          idle.push(w); pump();
        }, e => {
          if (w.gpu) { q.unshift(...jobs); if (!closed) { retire(w, String(e && e.message || e)); pump(); } return; }
          jobs.forEach(j => j.no(e)); if (!closed) { idle.push(w); pump(); }
        });
      }
    };
    return {
      st,
      get size() { return size; },
      add(wp, optional) {
        size++;
        wp.then(w => { if (closed) { if (!w.keep) w.terminate(); return; } all.push(w); idle.push(w); pump(); },
          e => { size--; if (optional) { st.gpuWhy = String(e && e.message || e); if (Q.get('debug')) console.log('그래픽카드 사용 안 함:', st.gpuWhy); }
            else if (!size && !all.length) { failed = e; q.splice(0).forEach(j => j.no(e)); } });   // 그래픽카드 실패는 CPU 작업자에 영향 없음
      },
      async rec(lines) {
        if (failed) throw failed;
        const parts = [];
        for (let i = 0; i < lines.length; i += CFG.chunk) parts.push(lines.slice(i, i + CFG.chunk));
        const rs = await Promise.all(parts.map(l => new Promise((ok, no) => { q.push({ lines: l, ok, no }); pump(); })));
        return { texts: rs.flatMap(r => r.texts), confs: rs.flatMap(r => r.confs) };
      },
      close() { closed = true; q.splice(0).forEach(j => j.no(new Error('중지됨'))); all.forEach(w => { if (!w.keep) w.terminate(); }); }   // 그래픽카드 작업자는 다음 파일에도 씀
    };
  }

  // 쪽 하나(돌린 상태 그대로)를 읽음. sample 을 주면 긴 줄 몇 개만 읽어 방향 판별용 신뢰도만 구함
  async function nnRead(nw, h, sample) {
    const T0 = performance.now();
    const pr = await h.read(sample); if (!pr) return null;
    const T1 = performance.now();
    if (sample) {
      const up = await nw.rec(pr.up), dn = await nw.rec(pr.dn);
      const avg = r => r.confs.reduce((s, v, i) => s + v * r.texts[i].length, 0) / Math.max(1, r.texts.reduce((s, t) => s + t.length, 0));
      return { up: avg(up), down: avg(dn) };
    }
    const r = await nw.rec(pr.tensors);
    if (Q.get('debug')) console.log(`글줄 찾기·자르기 ${(T1 - T0) | 0}ms, rec ${(performance.now() - T1) | 0}ms, 줄 ${r.texts.length}`);
    let k = 0, cs = 0, cn = 0, text = ''; const boxes = [];
    for (const g of pr.groups) { let first = true;
      for (let i = 0; i < g.length; i++, k++) { const t = r.texts[k], cf = r.confs[k], l = g[i];
        if (Q.get('crops')) (window.__recs = window.__recs || []).push(cf.toFixed(2) + ' ' + t);
        if (!t || cf < 0.3) continue;        // 잡티를 글자로 읽은 것은 버림
        if (text) text += first ? '\n\n' : '\n';
        first = false;
        // 글줄의 네 모서리 (기울기 반영)
        const yA = l.rTop + l.b * l.x0, yB = l.rTop + l.b * l.x1;
        boxes.push([text.length, text.length + t.length, l.x0, Math.min(yA, yB), l.x1, Math.max(yA, yB) + l.t]);
        text += t; cs += cf * t.length; cn += t.length; } }
    return { text, boxes, W: pr.W, H: pr.H, conf: cn ? cs / cn : 0, chars: cn, table: pr.table };
  }
  // 쪽 그림 다루개: 돌리기·글줄 읽기를 화면 쪽에서 하거나, 준비 작업자에게 맡김(그 쪽 그림은 작업자가 갖고 있음)
  async function pageHandle(canvas, dpi, remote) {
    if (remote) {
      const pid = ++PREP.seq, r = await PREP.call('open2', canvas, { pid, dpi, prep: CFG.prep }), x = r.x;
      return { vertical: r.vertical, W0: r.W0, H0: r.H0, turn: deg => PREP.send(x, { type: 'turn', pid, deg }),
        read: sample => PREP.send(x, { type: 'read', pid, sample }).then(m => m.res), close: () => PREP.send(x, { type: 'close', pid }).catch(() => {}) };
    }
    if (CFG.prep) enhance(canvas);
    let c = canvas;
    return { vertical: linesAreVertical(c), W0: c.width, H0: c.height,
      turn: async deg => { const n = rotated(c, deg); c.width = c.height = 0; c = n; },
      read: async sample => IP.readLines(c, dpi, sample), close: () => { c.width = c.height = 0; } };
  }

  // 한 쪽을 신경망으로 읽음. 누웠거나 뒤집힌 쪽은 돌려서 읽음. 실패하면 null
  async function nnPage(nw, page, dpi) {
    if (PREP.on) {
      let prepErr = null;
      try { return await nnPageWith(true, nw, page, dpi, e => { prepErr = e; }); }
      catch (e) { if (!prepErr) throw e; prepFail(prepErr); }     // 준비 작업자 문제일 때만 화면 쪽에서 다시
    }
    return nnPageWith(false, nw, page, dpi);
  }
  async function nnPageWith(remote, nw, page, dpi, onPrepErr) {
    const P0 = performance.now();
    const canvas = await renderToCanvas(page, dpi / 72, CFG.maxPx);
    const guard = p => remote ? p.catch(e => { onPrepErr(e); throw e; }) : p;
    const h = await guard(pageHandle(canvas, dpi, remote));
    const P1 = performance.now(); let flipCheck = false;
    const W0 = h.W0, H0 = h.H0; let rot = 0;
    const turn = async deg => { await guard(h.turn(deg)); rot = (rot + deg) % 360; };
    const hr = { read: sample => guard(h.read(sample)) };
    let res;
    try {
      if (h.vertical) {
        await turn(90);
        const sm = await nnRead(nw, hr, 12);
        if (sm && sm.down > sm.up) await turn(180);
        res = await nnRead(nw, hr);
      } else {
        res = await nnRead(nw, hr);
        if (res && res.conf < 0.8 && res.chars >= 8) { flipCheck = true;       // 신뢰도가 낮으면 위아래가 뒤집혔는지 확인
          const sm = await nnRead(nw, hr, 12);
          if (sm && sm.down > sm.up + 0.08) { await turn(180); res = await nnRead(nw, hr) || res; }
        }
      }
    } finally { h.close(); }
    if (res && res.boxes) {
      const back = (x, y) => { const Wr = res.W, Hr = res.H;      // 돌린 그림의 점 → 원래 쪽의 점
        return rot === 90 ? [y, Wr - x] : rot === 180 ? [Wr - x, Hr - y] : rot === 270 ? [Hr - y, x] : [x, y]; };
      res.boxes = res.boxes.map(([s, e, x0, y0, x1, y1]) => {
        const a = back(x0, y0), b = back(x1, y1);
        return [s, e, +(Math.min(a[0], b[0]) / W0).toFixed(4), +(Math.min(a[1], b[1]) / H0).toFixed(4), +(Math.max(a[0], b[0]) / W0).toFixed(4), +(Math.max(a[1], b[1]) / H0).toFixed(4), rot];
      });
    }
    if (Q.get('debug')) console.log(`nnPage 그리기${remote ? '·넘기기' : '·전처리'} ${(P1 - P0) | 0}ms, 나머지 ${(performance.now() - P1) | 0}ms, 뒤집힘 확인 ${flipCheck}, conf ${res && res.conf.toFixed(2)}`);
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
    curDoc = docs.find(d => d.file === file);
    if (!curDoc) { curDoc = { file, name: file.name }; docs.push(curDoc); }
    Object.assign(curDoc, { pages, total: 0, pdf: null, state: 'run', note: '', p2: '' });
    const me = curDoc; renderDocs();
    bar.classList.remove('hidden'); bar.value = 0; $('stop').classList.remove('hidden');
    setStatus('PDF를 여는 중…'); search();
    try {
      const data = await file.arrayBuffer();
      const optsKey = ($('force').checked ? 'F' : '-') + ($('fine').checked ? 'P' : '-');
      const key = Q.get('nocache') ? null : await fileKey(data.slice(0), optsKey);
      const doc = await pdfjsLib.getDocument({ data, CMapReaderFactory: EmbeddedCMaps, cMapPacked: true }).promise;
      if (my !== runId) return;
      pdf = doc; total = doc.numPages; bar.max = total; me.pdf = doc; me.total = total;
      if (key) {
        const hit = await cacheGet(key);
        if (my !== runId) return;
        if (hit && hit.total === total) {
          pages = hit.pages.map(p => ({ n: p.n, src: p.src, layers: p.layers.map(L => Object.assign({ text: L.t, boxes: L.b || null }, normalize(L.t))) }));
          running = false; bar.value = total; $('stop').classList.add('hidden');
          me.pages = pages; me.state = 'done'; me.note = '저장된 결과';
          const when = new Date(hit.at).toLocaleString();
          setStatus(`${docPrefix(me)}저장해 둔 분석 결과를 불러왔습니다 (전체 ${total}쪽, ${when} 분석) · 바로 검색할 수 있습니다`, 'ok');
          search(); runNext(); return;
        }
      }
      const lang = 'kor', force = $('force').checked, fine = $('fine').checked;
      await resetPool(lang); analyzedLang = lang;
      let next = 1, done = 0, ocrCount = 0, ocrStart = 0, nnDone = 0, engineNote = '';
      const t0 = performance.now(), busy0 = mainBusy;
      // 1단계: 글자 정보가 있으면 그대로, 없으면 빠른 엔진(Tesseract)으로 전체를 훑음 → 바로 검색 가능
      // 2단계: 신경망 엔진(PP-OCRv5)으로 스캔 쪽을 다시 읽어 결과를 보강
      const ocrPages = [], confOf = {};
      const nWork = Math.min(CFG.workers, total);
      const nnOn = fine && NN.ok;
      const pool2 = nnOn ? nnPool(() => my === runId) : null;
      // 그래픽카드는 CPU 작업자에 더해 하나. 준비돼 있으면 1차 판독 중에도 끝난 쪽부터 바로 읽음
      if (pool2 && GPU.state !== 'off') pool2.add(gpuStart().then(w => w || Promise.reject(new Error(GPU.why))), true);
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
        me.p2 = `${done2}/${ocrPages.length}`;
        setStatus(`${docPrefix(me)}1차 판독 완료(${t1}초), 검색할 수 있습니다 · 정밀 판독 ${done2}/${ocrPages.length}쪽${left}`);
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
          if (!t1) setStatus(`${docPrefix(me)}1차 판독: ${total}쪽 중 ${done}쪽 완료${left}`);
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
      if (key && !engineNote) await cachePut({ key, at: Date.now(), name: file.name, total, pages: pages.map(p => ({ n: p.n, src: p.src, layers: p.layers.map(L => ({ t: L.text, b: L.boxes })) })) });
      if (my !== runId) return;
      setTimeout(prewarm, 1500);        // 다음 파일을 위해 1차 엔진을 미리 준비
      let gpuNote = '';
      if (pool2 && pool2.st.gpuN) gpuNote = ` · 그래픽카드가 글줄 ${Math.round(pool2.st.gpuN / (pool2.st.gpuN + pool2.st.cpuN) * 100)}% 판독`;
      else if (pool2 && ocrCount) gpuNote = ` · 그래픽카드 안 씀(${GPU.state === 'loading' ? '준비가 끝나기 전에 분석이 끝남' : GPU.why || pool2.st.gpuWhy || '쓸 일이 없었음'})`;
      me.state = 'done'; me.note = sec + '초';
      setStatus(`${docPrefix(me)}분석 완료: 전체 ${total}쪽 (OCR ${ocrCount}쪽, 글자 정보 사용 ${total - ocrCount}쪽) · ${sec}초${engineNote}${gpuNote} · 화면 쪽 작업 ${Math.round((mainBusy - busy0) / 1000)}초`, 'ok');
      search(); runNext();
    } catch (e) {
      if (my !== runId) return;
      runId++; running = false; $('stop').classList.add('hidden');
      console.error(e);
      const msg = e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없습니다.'
        : '분석 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e);
      me.state = 'err'; me.note = msg;
      setStatus(docPrefix(me) + msg, 'err'); runNext();
    }
  }
  const docPrefix = d => docs.length > 1 ? `[${d.name}] ` : '';
  function runNext() {        // 대기 중인 다음 파일 분석
    renderDocs();
    if (!running && queue.length) setTimeout(() => { if (!running && queue.length) analyze(queue.shift()); }, 0);
  }

  // ---------- 파일 목록 ----------
  const listEl = document.createElement('div'); listEl.id = 'docs'; $('drop').insertAdjacentElement('afterend', listEl);
  const baseTitle = document.title;
  function renderDocs() {
    // 브라우저 탭 제목에 진행 상황 (다른 탭에서 일하다가도 보이게)
    const waiting = queue.length, pct = bar.max ? Math.round(bar.value / bar.max * 100) : 0;
    document.title = running ? `(${pct}%${waiting ? `, 남은 파일 ${waiting}개` : ''}) ${baseTitle}` : docs.some(d => d.state === 'done') ? `✓ 분석 완료 · ${baseTitle}` : baseTitle;
    listEl.innerHTML = '';
    if (!docs.length) return;
    $('dropTitle').textContent = docs.length === 1 ? docs[0].name : `파일 ${docs.length}개`;
    $('dropSub').textContent = '파일을 더 넣으려면 다시 누르거나 끌어다 놓으세요 (여러 개 한꺼번에 가능)';
    const label = { wait: '대기', run: '분석 중', done: '완료', stop: '중지됨', err: '오류' };
    for (const d of docs) {
      const row = document.createElement('div'); row.className = 'doc';
      const nm = document.createElement('span'); nm.className = 'doc-name'; nm.textContent = d.name;
      const st = document.createElement('small');
      const n = (d.pages || []).filter(Boolean).length;
      const prog = d.p2 ? `정밀 판독 ${d.p2}쪽` : `1차 판독 ${n}/${d.total}쪽`;
      st.textContent = (d.state === 'run' && d.total ? prog : label[d.state] + (d.total ? ` · ${d.total}쪽` : '')) + (d.note && d.state !== 'err' ? ` · ${d.note}` : '');
      if (d.state === 'err') st.className = 'err';
      row.append(nm, st);
      if (d.pdf) { const pg = document.createElement('button'); pg.textContent = '쪽 저장'; pg.title = '고른 쪽만 새 PDF로 저장'; pg.onclick = () => openSave(d); row.append(pg); }
      if (n) { const sv = document.createElement('button'); sv.textContent = '글자 저장'; sv.title = '인식된 글자를 텍스트 파일로 저장'; sv.onclick = () => saveText(d); row.append(sv); }
      const rm = document.createElement('button'); rm.textContent = '×'; rm.title = '목록에서 빼기'; rm.setAttribute('aria-label', d.name + ' 목록에서 빼기');
      rm.onclick = () => removeDoc(d); row.append(rm);
      listEl.appendChild(row);
    }
  }
  function removeDoc(d) {
    const qi = queue.indexOf(d.file); if (qi >= 0) queue.splice(qi, 1);
    if (d === curDoc && running) { stopRun(); }
    docs.splice(docs.indexOf(d), 1);
    if (d.pdf && d.pdf !== pdf) d.pdf.destroy().catch(() => {});
    if (!docs.length) { $('dropTitle').textContent = '여기를 눌러 PDF를 선택하거나, 파일을 끌어다 놓으세요'; $('dropSub').textContent = '스캔본 · 일반 PDF 모두 가능 · 여러 파일 한꺼번에 가능'; curFile = null; setStatus(''); bar.classList.add('hidden'); }
    renderDocs(); search(); runNext();
  }
  // 인식된 글자를 쪽 표시와 함께 텍스트 파일로 (신경망 결과가 있으면 그것, 없으면 1차 결과)
  function saveText(d) {
    const body = d.pages.filter(Boolean).map(p => `===== ${p.n}쪽 =====\n${p.layers[0].text.trim()}`).join('\n\n');
    download(new Blob(['\ufeff' + body], { type: 'text/plain;charset=utf-8' }), d.name.replace(/\.pdf$/i, '') + ' - 인식된 글자.txt');
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- 고른 쪽을 새 PDF로 저장 ----------
  // 쪽 적기: "2, 5-7, 10~12" — 쉼표로 나눈 묶음 하나가 '구역'. 구역마다 따로 저장하면 ZIP 하나로 묶어 내려받음
  let libsP = null;
  const pdfLibs = () => libsP || (libsP = (async () => { await loadScript('a-pdflib'); await loadScript('a-fflate'); })());
  function parseRanges(str, total) {
    const groups = [], bad = [];
    for (const part of str.split(/[,，;\n]+/).map(x => x.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)\s*(?:[-~–]\s*(\d+))?\s*쪽?$/);
      if (!m) { bad.push(part); continue; }
      let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
      if (a < 1 || b > total) { bad.push(part); continue; }
      const g = []; for (let n = a; n <= b; n++) g.push(n); groups.push(g);
    }
    return { groups, bad };
  }
  // 쪽 번호들 → "2, 5-7"
  function compress(ns) {
    ns = [...new Set(ns)].sort((a, b) => a - b); const out = [];
    for (let i = 0; i < ns.length; i++) { let j = i; while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++; out.push(i === j ? '' + ns[i] : ns[i] + '-' + ns[j]); i = j; }
    return out.join(', ');
  }
  const hitPages = d => nav.filter(x => x.d === d).map(x => x.n);
  function openSave(d, pagesText) {
    const ds = docs.filter(x => x.pdf);
    if (!ds.length) return;
    if (!d || !d.pdf) d = ds.find(x => hitPages(x).length) || ds[0];
    const sel = $('svFile'); sel.innerHTML = '';
    ds.forEach((x, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${x.name} (${x.total}쪽)`; if (x === d) o.selected = true; sel.appendChild(o); });
    const fill = x => { $('svPages').value = compress(hitPages(x)); svCheck(); };
    sel.onchange = () => fill(ds[+sel.value]);
    $('svPages').value = pagesText !== undefined ? pagesText : compress(hitPages(d));
    $('saveDlg').__ds = ds; svCheck(); $('saveDlg').showModal(); $('svPages').focus();
  }
  function svCheck() {
    const dlg = $('saveDlg'), d = dlg.__ds[+$('svFile').value], { groups, bad } = parseRanges($('svPages').value, d.total);
    const n = new Set(groups.flat()).size, split = $('svSplit').checked;
    $('svNote').textContent = bad.length ? `알아볼 수 없는 부분: ${bad.join(', ')} (1~${d.total}쪽 사이로 적어 주세요)`
      : !n ? '저장할 쪽을 적어 주세요. 예: 2, 5-7, 12'
      : `${n}쪽` + (split && groups.length > 1 ? ` · 구역 ${groups.length}개를 따로 PDF로 만들어 ZIP 하나로 저장` : ' · PDF 한 개로 저장');
    $('svNote').className = bad.length ? 'err' : '';
    $('svGo').disabled = !!bad.length || !n;
  }
  async function savePages() {
    const dlg = $('saveDlg'), d = dlg.__ds[+$('svFile').value], { groups } = parseRanges($('svPages').value, d.total), split = $('svSplit').checked;
    const go = $('svGo'); go.disabled = true; go.textContent = '만드는 중…';
    try {
      await pdfLibs();
      const src = await PDFLib.PDFDocument.load(await d.file.arrayBuffer(), { ignoreEncryption: true });
      const make = async ns => { const out = await PDFLib.PDFDocument.create(); for (const pg of await out.copyPages(src, ns.map(n => n - 1))) out.addPage(pg); return out.save(); };
      const base = d.name.replace(/\.pdf$/i, '');
      if (split && groups.length > 1) {
        const files = {};
        for (const g of groups) files[`${base} ${compress(g)}쪽.pdf`] = await make(g);
        download(new Blob([fflate.zipSync(files, { level: 0 })], { type: 'application/zip' }), `${base} 구역 ${groups.length}개.zip`);
      } else {
        const all = groups.flat(), ns = split ? all : [...new Set(all)];
        download(new Blob([await make(ns)], { type: 'application/pdf' }), `${base} ${compress(ns)}쪽.pdf`);
      }
      go.textContent = '저장했습니다'; setTimeout(() => { go.textContent = '저장'; svCheck(); }, 1500);
    } catch (e) {
      console.error(e); go.textContent = '저장'; go.disabled = false;
      $('svNote').textContent = '저장하지 못했습니다: ' + (/encrypt/i.test(e && e.message) ? '암호가 걸린 PDF입니다' : (e && e.message || e)); $('svNote').className = 'err';
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

  // 한 파일에서 한 낱말을 찾음 → [{ p, L, spans, fuzzy }]
  function findIn(doc, raw, k) {
    const q = normalize(raw).out, qj = normalize(raw, true).out, found = [];
    if (!q) return found;
    if (k === undefined) k = $('fuzzy').checked ? tolerance(qj.length) : 0;
    for (const p of doc.pages.filter(Boolean)) {
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
    return found;
  }
  // 검색: 쉼표(,)로 나누면 여러 낱말을 따로 찾고, 모두 들어 있는 쪽도 보여줌. 파일이 여럿이면 파일별로
  let nav = [], navI = -1, lastCopy = '';
  function search() {
    lastSearch = performance.now();
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }   // 지금 찾으므로 미뤄 둔 검색은 취소
    renderDocs();
    const raw = qEl.value.trim(), terms = raw.split(/(?<!\d)[,，]|[,，](?!\d)/).map(t => t.trim()).filter(t => normalize(t).out);
    hitsEl.innerHTML = ''; chipsEl.innerHTML = ''; nav = []; lastCopy = ''; $('copyRes').classList.add('hidden'); $('saveRes').classList.add('hidden');
    const ds = docs.filter(d => d.pages && d.pages.some(Boolean));
    if (!ds.length || !terms.length) { summaryEl.textContent = ''; return; }
    const multiDoc = ds.length > 1, done = ds.reduce((s, d) => s + d.pages.filter(Boolean).length, 0), all = ds.reduce((s, d) => s + d.total, 0);
    const partial = !running && !queue.length ? '' : done >= all && !queue.length ? ' (정밀 판독 중이라 결과가 더 나올 수 있습니다)' : ` (지금까지 분석한 ${done}쪽 기준)`;
    const res = terms.map(t => ({ t, per: ds.map(d => ({ d, found: findIn(d, t) })) }));
    const copy = [];
    // 여러 낱말: 모두 들어 있는 쪽
    if (terms.length > 1) {
      const both = ds.map(d => ({ d, ns: d.pages.filter(Boolean).map(p => p.n).filter(n => res.every(r => r.per.find(x => x.d === d).found.some(f => f.p.n === n))) })).filter(x => x.ns.length);
      const box = document.createElement('div'); box.className = 'term';
      const h = document.createElement('div'); h.className = 'term-head';
      h.textContent = both.length ? `모두 들어 있는 쪽 (${terms.join(' + ')})` : `"${terms.join('", "')}" 이(가) 모두 들어 있는 쪽은 없습니다`;
      box.appendChild(h);
      for (const { d, ns } of both) {
        const line = document.createElement('div'); line.className = 'chips';
        if (multiDoc) { const fn = document.createElement('span'); fn.className = 'chip-file'; fn.textContent = d.name; line.appendChild(fn); }
        for (const n of ns) line.appendChild(chipFor(d, n, terms[0], false));
        box.appendChild(line); copy.push(`[모두] ${multiDoc ? d.name + ': ' : ''}${ns.join(', ')}쪽`);
      }
      hitsEl.appendChild(box);
    }
    let totPages = 0, totHits = 0, totFz = 0;
    for (const { t, per } of res) {
      const box = terms.length > 1 ? document.createElement('div') : null;
      if (box) { box.className = 'term'; hitsEl.appendChild(box); }
      const chipsTo = box || chipsEl, hitsTo = box || hitsEl;
      let np = 0, nh = 0, nf = 0;
      for (const { found } of per) { np += found.filter(f => !f.fuzzy).length; nh += found.filter(f => !f.fuzzy).reduce((s, f) => s + f.spans.length, 0); nf += found.filter(f => f.fuzzy).length; }
      totPages += np; totHits += nh; totFz += nf;
      const parts = [];
      if (np) parts.push(`${np}개 쪽에서 ${nh}건`);
      if (nf) parts.push(`비슷한 표현 ${nf}개 쪽`);
      if (box) { const h = document.createElement('div'); h.className = 'term-head'; h.textContent = `"${t}" — ${parts.join(', ') || '없음'}`; box.appendChild(h); }
      for (const { d, found } of per) {
        if (!found.length) continue;
        const line = document.createElement('div'); line.className = 'chips';
        if (multiDoc) { const fn = document.createElement('span'); fn.className = 'chip-file'; fn.textContent = d.name; line.appendChild(fn); }
        for (const f of found) { line.appendChild(chipFor(d, f.p.n, t, f.fuzzy)); }
        if (box || multiDoc) chipsTo.appendChild(line); else for (const c of [...line.children]) chipsEl.appendChild(c);
        copy.push(`${terms.length > 1 ? `[${t}] ` : ''}${multiDoc ? d.name + ': ' : ''}${found.map(f => f.p.n + (f.fuzzy ? '?' : '')).join(', ')}쪽`);
        for (const f of found) hitsTo.appendChild(hitBlock(d, f, t, multiDoc));
      }
    }
    const where = multiDoc ? `파일 ${ds.length}개 · ` : '';
    if (!totPages && !totFz) {
      summaryEl.textContent = `${where}"${terms.join('", "')}" 을(를) 찾지 못했습니다${partial}.` + (running ? '' : ' 스캔 상태가 흐리면 인식이 틀릴 수 있으니 더 짧은 단어로도 찾아보세요.');
      return;
    }
    if (terms.length > 1) summaryEl.textContent = `${where}낱말 ${terms.length}개를 따로 찾았습니다${partial}`;
    else {
      const parts = [];
      if (totPages) parts.push(`${totPages}개 페이지에서 ${totHits}건 발견`);
      if (totFz) parts.push(`비슷한 표현 ${totFz}개 페이지`);
      summaryEl.textContent = `${where}"${terms[0]}" — ${parts.join(', ')}${partial}`;
    }
    lastCopy = copy.join('\n'); $('copyRes').classList.remove('hidden'); $('saveRes').classList.remove('hidden');
  }
  function chipFor(d, n, t, fuzzy) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (fuzzy ? ' fz' : ''); chip.textContent = n + '쪽' + (fuzzy ? ' ?' : '');
    chip.title = (fuzzy ? '글자가 조금 다른 비슷한 표현' : '정확히 일치') + (docs.length > 1 ? ' · ' + d.name : '');
    const idx = nav.length; nav.push({ d, n, t });
    chip.onclick = () => preview(d, n, t, idx);
    return chip;
  }
  function hitBlock(d, { p, L, spans, fuzzy }, t, multiDoc) {
    const div = document.createElement('div'); div.className = 'hit';
    const head = document.createElement('div'); head.className = 'hit-head';
    const b = document.createElement('button'); b.textContent = (multiDoc ? d.name.replace(/\.pdf$/i, '') + ' · ' : '') + p.n + '쪽 보기';
    const idx = nav.findIndex(x => x.d === d && x.n === p.n && x.t === t); b.onclick = () => preview(d, p.n, t, idx);
    const sm = document.createElement('small');
    sm.textContent = (fuzzy ? `비슷한 표현 ${spans.length}건 (인식 오류일 수 있음)` : `${spans.length}건`) + (p.src === 'ocr' ? ' · OCR 인식' : '');
    head.append(b, sm); div.appendChild(head);
    for (const [s, e] of spans.slice(0, 3)) {
      const a = Math.max(0, s - 40), z = Math.min(L.text.length, e + 40);
      const clean = x => esc(x.replace(/\s+/g, ' '));
      const snip = document.createElement('p'); snip.className = 'snip';
      snip.innerHTML = (a > 0 ? '… ' : '') + clean(L.text.slice(a, s)) + '<mark>' + clean(L.text.slice(s, e)) + '</mark>' + clean(L.text.slice(e, z)) + (z < L.text.length ? ' …' : '');
      div.appendChild(snip);
    }
    if (spans.length > 3) { const more = document.createElement('p'); more.className = 'snip'; more.textContent = `외 ${spans.length - 3}건`; div.appendChild(more); }
    return div;
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

  let pvSeq = 0, pvCur = null;
  async function preview(d, n, raw, idx) {
    if (!d.pdf) return;
    const my = ++pvSeq, pages = d.pages; navI = idx === undefined ? -1 : idx; pvCur = { d, n };
    $('pvTitle').textContent = (docs.length > 1 ? d.name + ' · ' : '') + `${n}쪽 / 전체 ${d.total}쪽`;
    $('pvPrev').disabled = navI <= 0; $('pvNext').disabled = navI < 0 || navI >= nav.length - 1;
    $('pvPos').textContent = navI >= 0 ? `결과 ${navI + 1}/${nav.length}` : '';
    $('pvText').textContent = pages[n - 1] ? pages[n - 1].layers.map(L => L.text).join('\n──────── 2차 판독 ────────\n') : '';
    const dlg = $('dlg'); if (!dlg.open) dlg.showModal();
    $('pvNote').textContent = '';
    const page = await d.pdf.getPage(n);
    const c = await renderToCanvas(page, 2.2, 2400);
    if (my !== pvSeq) { c.width = c.height = 0; return; }      // 그사이 다른 결과로 넘김
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
  function pick(files) {
    files = [...(files || [])].filter(Boolean);
    const ok = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!ok.length) { if (files.length) setStatus('PDF 파일만 사용할 수 있습니다.', 'err'); return; }
    for (const f of ok) {
      if (docs.some(d => d.name === f.name && d.file.size === f.size && d.state !== 'err')) continue;   // 이미 목록에 있는 파일
      docs.push({ file: f, name: f.name, pages: [], total: 0, state: 'wait', note: '' }); queue.push(f);
    }
    renderDocs(); runNext();
  }

  // ---------- 그래픽카드 ----------
  // 페이지를 열면 바로 준비하고 속도를 재어 둠. 한 번 준비되면 다음 파일에도 계속 씀
  function gpuShow() {
    gpuEl.textContent = `이 컴퓨터: 코어 ${cores}개, 동시 작업 ${CFG.workers}개 · 그래픽카드: ` + ({ idle: '확인 전', loading: '준비 중… (처음 한 번 수십 초 걸릴 수 있음)',
      ready: `사용함 — ${GPU.name || '이름 모름'}, 글줄 읽기가 CPU 한 코어보다 약 ${GPU.speed}배 빠름`, off: `안 씀 — ${GPU.why}` })[GPU.state];
  }
  function gpuStart() {
    if (GPU.p) return GPU.p;
    if (GPU.state === 'off' || !NN.ok) return Promise.resolve(null);
    GPU.state = 'loading'; gpuShow(); let late = false;
    const wp = nnWorker('webgpu');
    const timeout = new Promise((_, no) => setTimeout(() => { late = true; no(new Error('준비 시간 초과(2분)')); }, 120000));
    wp.then(w => { if (late) w.terminate(); }, () => {});
    GPU.p = Promise.race([wp, timeout]).then(w => {
      const x = 0.26 / w.msPerCol;      // 0.26: 4코어 시험 컴퓨터에서 CPU 한 코어의 글줄 너비 1픽셀당 시간(ms)
      if (CFG.gpu !== 'force' && x < 1.25) { w.terminate(); throw new Error(`CPU 한 코어보다 빠르지 않음(${x.toFixed(1)}배${w.name ? ', ' + w.name : ''})`); }
      w.keep = true; GPU.w = w; GPU.name = w.name; GPU.speed = x >= 10 ? Math.round(x) : x.toFixed(1); GPU.state = 'ready'; gpuShow(); return w;
    }).catch(e => { GPU.state = 'off'; GPU.why = String(e && e.message || e); gpuShow(); return null; });
    return GPU.p;
  }

  // 파일을 고르기 전에 엔진을 미리 준비해 두어 분석 시작이 빨라지게 함
  function prewarm() {
    if (running || pool.some(Boolean) || !CFG.warm) return;
    poolLang = 'kor';
    pool = Array.from({ length: CFG.workers }, (_, i) => { const p = makeWorker('kor'); p.catch(() => { if (pool[i] === p) pool[i] = null; }); return p; });
    if (NN.ok) nnRes().catch(() => {});
    if (NN.ok && CFG.warm && $('fine').checked) gpuStart();
  }

  drop.onclick = () => fileInput.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  fileInput.onchange = () => { pick(fileInput.files); fileInput.value = ''; };
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  document.addEventListener('drop', e => pick(e.dataTransfer.files));
  function stopRun() {
    runId++; if (NN.cancel) NN.cancel(); running = false; $('stop').classList.add('hidden');
    if (curDoc) { curDoc.state = 'stop'; curDoc.note = `${pages.filter(Boolean).length}/${total}쪽까지`; }
  }
  $('stop').onclick = () => {      // 지금 파일과 대기 중인 파일 모두 멈춤
    stopRun();
    for (const f of queue.splice(0)) { const d = docs.find(x => x.file === f); if (d) { d.state = 'stop'; d.note = '시작 전'; } }
    setStatus(`중지됨: ${pages.filter(Boolean).length}/${total}쪽까지 분석했습니다.`); renderDocs(); search();
  };
  $('force').onchange = $('fine').onchange = () => {    // 설정이 바뀌면 목록의 파일을 모두 다시 분석
    if (!docs.length) return;
    if (running) stopRun();
    queue.splice(0); for (const d of docs) { d.state = 'wait'; d.note = ''; queue.push(d.file); }
    renderDocs(); runNext();
  };
  $('clearCache').onclick = async () => { await cacheClear(); $('clearCache').textContent = '저장된 결과를 지웠습니다'; };
  $('go').onclick = search;
  $('fuzzy').onchange = search;
  let typing = null;
  qEl.oninput = () => { clearTimeout(typing); typing = setTimeout(search, 150); };
  qEl.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(typing); search(); } };
  $('pvClose').onclick = () => $('dlg').close();
  const go = k => { const x = nav[navI + k]; if (x) preview(x.d, x.n, x.t, navI + k); };
  $('pvPrev').onclick = () => go(-1); $('pvNext').onclick = () => go(1);
  $('pvSave').onclick = () => { if (pvCur) { $('dlg').close(); openSave(pvCur.d, String(pvCur.n)); } };
  $('saveRes').onclick = () => openSave(null);
  $('svPages').oninput = svCheck; $('svFile').onchange = svCheck; $('svSplit').onchange = $('svOne').onchange = svCheck;
  $('svGo').onclick = savePages; $('svClose').onclick = () => $('saveDlg').close();
  $('svPages').onkeydown = e => { if (e.key === 'Enter' && !$('svGo').disabled) savePages(); };
  $('dlg').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } });
  $('copyRes').onclick = async () => {
    try { await navigator.clipboard.writeText(lastCopy); }
    catch (e) { const t = document.createElement('textarea'); t.value = lastCopy; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    $('copyRes').textContent = '복사했습니다'; setTimeout(() => { $('copyRes').textContent = '결과 복사'; }, 1500);
  };
  if (early) { pick(early); early = null; }
  gpuShow();
  setTimeout(prewarm, 0);              // 화면 동작을 다 연결한 뒤에 준비 시작
})();
