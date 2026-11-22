// 그림 처리 함수들: 화면 쪽(메인 스레드)과 준비 작업자(prepworker.js)가 똑같이 씀
// mk(): 빈 캔버스 (화면 쪽은 <canvas>, 작업자는 OffscreenCanvas). hooks.line: 시험용 글줄 저장
function makeImgProc(CFG, mk, hooks = {}) {
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
    const c = mk(); const q = deg % 180 !== 0;
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
    const c = mk(); c.width = w; c.height = h;
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
      const cv = mk(); cv.width = stripW; cv.height = s.h;
      const cx = cv.getContext('2d'); const out = cx.createImageData(stripW, s.h), o = out.data; o.fill(255);
      for (const { c, y: ty } of s.items) for (let y = c.ay0; y <= c.ay1; y++) { const go = (y / G | 0) * gw;
        for (let x = c.ax0; x <= c.ax1; x++) { const l = label[go + (x / G | 0)];
          if (l !== c.id && l !== -1) continue;        // 기울어진 표에서 이웃 칸 글자가 끼어들지 않게 함
          const v = d[(y * W + x) * 4], i = ((ty + y - c.ay0) * stripW + pad + x - c.ax0) * 4; o[i] = o[i + 1] = o[i + 2] = v; } }
      cx.putImageData(out, 0, 0); return cv;
    });
    // 칸 밖(제목·본문·쪽 번호)
    let restInk = 0; const rest = mk(); rest.width = W; rest.height = H;
    const rx = rest.getContext('2d'); const ro = rx.createImageData(W, H), r = ro.data;
    for (let y = 0; y < H; y++) { const go = (y / G | 0) * gw;
      for (let x = 0; x < W; x++) { const p = y * W + x, i = p * 4, l = label[go + (x / G | 0)];
        const inCell = l > 0 && isCell[l]; const v = inCell ? 255 : d[i];
        r[i] = r[i + 1] = r[i + 2] = v; r[i + 3] = 255; if (!inCell && bin[p]) restInk++; } }
    rx.putImageData(ro, 0, 0);
    // 칸 그림 안의 위치 → 쪽 위치로 되돌릴 때 씀: 칸마다 칸 그림에서의 세로 시작(ty)·높이(h), 쪽에서의 왼쪽 위(ax0 - pad, ay0)
    const places = strips.map(s => s.items.map(({ c, y }) => ({ ty: y, h: c.ay1 - c.ay0 + 1, dx: c.ax0 - pad, dy: c.ay0 })));
    return { strips: canvases, rest, restInk, places };
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
  const lineCv = mk(); lineCv.width = 2400; lineCv.height = 48;
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
    if (hooks.line) hooks.line(g, wout, flip, lineCv);   // 시험용 저장(화면 쪽에서만)
    return { w: wout, data };
  }


  // 쪽 그림 하나에서 글줄을 찾아 신경망 입력으로 만듦 (sample: 방향 판별용으로 긴 줄 몇 개만, 바로·뒤집은 것 둘 다)
  function readLines(canvas, dpi, sample) {
    const seg = segment(canvas, dpi); if (!seg) return null;
    const lines = textLines(seg); if (!lines.length) return null;
    if (sample) {
      const pick = lines.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0)).slice(0, sample);
      return { up: pick.map(l => lineTensor(canvas, l, false)), dn: pick.map(l => lineTensor(canvas, l, true)) };
    }
    const groups = orderLines(lines, seg), tensors = [];
    for (const g of groups) for (const l of g.lines) tensors.push(lineTensor(canvas, l, false));
    return { W: canvas.width, H: canvas.height, table: seg.cells.length > 0,
      groups: groups.map(g => g.lines.map(l => ({ x0: l.x0, x1: l.x1, b: l.b, rTop: l.rTop, t: l.t }))), tensors };
  }
  // 캔버스 ↔ 회색 값(한 칸 1바이트)
  function grayOf(canvas) {
    const W = canvas.width, H = canvas.height, d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
    return { width: W, height: H, gray: g };
  }
  function canvasOf(img) {
    const c = mk(); c.width = img.width; c.height = img.height; const cx = c.getContext('2d', { willReadFrequently: true });
    const im = cx.createImageData(img.width, img.height), d = im.data, g = img.gray;
    for (let i = 0; i < g.length; i++) { const o = i * 4; d[o] = d[o + 1] = d[o + 2] = g[i]; d[o + 3] = 255; }
    cx.putImageData(im, 0, 0); return c;
  }

  return { enhance, rotated, linesAreVertical, segment, tableImages, textLines, orderLines, lineTensor, readLines, grayOf, canvasOf };
}
