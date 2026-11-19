// 글자 인식 작업자: onnxruntime-web(wasm) + PP-OCRv5 한국어 인식 모델. 모든 자원은 메시지로 전달받아 네트워크를 쓰지 않음
let session = null, chars = null;
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const wasmBuf = m.wasm, realFetch = self.fetch;
      self.fetch = (u, ...rest) => /\.wasm($|\?)/.test(String(u && u.url || u))
        ? Promise.resolve(new Response(wasmBuf, { headers: { 'content-type': 'application/wasm' } })) : realFetch(u, ...rest);
      ort.env.wasm.wasmPaths = 'https://embedded.invalid/'; ort.env.wasm.numThreads = 1; ort.env.wasm.simd = true; ort.env.wasm.proxy = false;
      session = await ort.InferenceSession.create(m.model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      chars = [''].concat(m.dict.split('\n').filter((s, i, a) => !(i === a.length - 1 && s === '')), [' ']);
      self.postMessage({ type: 'ready', id: m.id });
    } else if (m.type === 'rec') {
      const texts = [], confs = [];
      for (const ln of m.lines) {
        const t = new ort.Tensor('float32', ln.data, [1, 3, 48, ln.w]);
        const r = await session.run({ [session.inputNames[0]]: t });
        const o = r[session.outputNames[0]], T = o.dims[1], C = o.dims[2], d = o.data;
        let s = '', prev = 0, ps = 0, pn = 0;
        for (let i = 0; i < T; i++) {
          let b = 0, bv = -1; const off = i * C;
          for (let c = 0; c < C; c++) { const v = d[off + c]; if (v > bv) { bv = v; b = c; } }
          if (b !== prev && b !== 0) { s += chars[b] || ''; ps += bv; pn++; }
          prev = b;
        }
        texts.push(s); confs.push(pn ? ps / pn : 0);
      }
      self.postMessage({ type: 'rec', id: m.id, texts, confs });
    }
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
};
