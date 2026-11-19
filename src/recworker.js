// 글자 인식 작업자: onnxruntime-web + PP-OCRv5 한국어 인식 모델. 모든 자원은 메시지로 전달받아 네트워크를 쓰지 않음
// ep = 'wasm'(CPU) 또는 'webgpu'(그래픽카드)
let session = null, chars = null, gpu = false;
async function hasRealGpu(force) {
  if (!self.navigator || !navigator.gpu) return '이 브라우저는 WebGPU를 지원하지 않음';
  const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!a) return '그래픽카드를 찾지 못함';
  if (!force && (a.isFallbackAdapter || (a.info && a.info.isFallbackAdapter))) return '소프트웨어 그래픽(실제 그래픽카드 아님)';
  return '';
}
// 출력 하나(T × C)에서 앞쪽 T0칸만 풀어 글자로
function decode(d, off, T0, C) {
  let s = '', prev = 0, ps = 0, pn = 0;
  for (let i = 0; i < T0; i++) {
    let b = 0, bv = -1; const o = off + i * C;
    for (let c = 0; c < C; c++) { const v = d[o + c]; if (v > bv) { bv = v; b = c; } }
    if (b !== prev && b !== 0) { s += chars[b] || ''; ps += bv; pn++; }
    prev = b;
  }
  return [s, pn ? ps / pn : 0];
}
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      gpu = m.ep === 'webgpu';
      if (gpu) { const why = await hasRealGpu(m.force); if (why) throw new Error(why); }
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([m.mjs], { type: 'text/javascript' })) };
      ort.env.wasm.wasmBinary = m.wasm;
      ort.env.logLevel = 'error';
      session = await ort.InferenceSession.create(m.model, { executionProviders: [m.ep], graphOptimizationLevel: 'all',
        externalData: [{ path: 'rec_w.bin', data: m.weights }], logSeverityLevel: 3 });
      chars = [''].concat(m.dict.split('\n').filter((s, i, a) => !(i === a.length - 1 && s === '')), [' ']);
      let msPerCol = 0;
      if (gpu) {        // 준비 운전 뒤 속도 재기: 너비 512 한 줄을 세 번 읽는 시간
        const x = () => new ort.Tensor('float32', new Float32Array(3 * 48 * 512).fill(1), [1, 3, 48, 512]);
        await session.run({ [session.inputNames[0]]: x() }); const t = performance.now();
        for (let k = 0; k < 3; k++) await session.run({ [session.inputNames[0]]: x() });
        msPerCol = (performance.now() - t) / (3 * 512);
      }
      self.postMessage({ type: 'ready', id: m.id, msPerCol });
    } else if (m.type === 'rec') {
      // 한 줄씩 원래 너비 그대로 읽음 (오른쪽을 채워 여러 줄을 묶으면 모델이 줄 전체를 보므로 결과가 조금 달라짐)
      const texts = [], confs = [], inName = session.inputNames[0], outName = session.outputNames[0];
      for (const ln of m.lines) {
        const r = await session.run({ [inName]: new ort.Tensor('float32', ln.data, [1, 3, 48, ln.w]) });
        const o = r[outName], [t, c] = decode(o.data, 0, o.dims[1], o.dims[2]); texts.push(t); confs.push(c);
      }
      self.postMessage({ type: 'rec', id: m.id, texts, confs });
    }
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
};
