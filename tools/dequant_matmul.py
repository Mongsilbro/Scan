# 그래픽카드(WebGPU)용 모델: 8비트 행렬곱(DynamicQuantizeLinear → MatMulInteger → Cast → Mul)을
# 같은 가중치를 실수로 되돌린 보통 MatMul 로 바꿈. (WebGPU 실행기는 8비트 행렬곱을 지원하지 않음)
# 사용: python3 tools/dequant_matmul.py models/rec_small_int8.onnx 출력.onnx
import sys, numpy as np, onnx
from onnx import numpy_helper, helper
m = onnx.load(sys.argv[1]); g = m.graph
init = {i.name: i for i in g.initializer}; arr = lambda n: numpy_helper.to_array(init[n])
users = lambda x: [n for n in g.node if x in n.input]
prod = {o: n for n in g.node for o in n.output}
done = 0
for mmi in [n for n in g.node if n.op_type == 'MatMulInteger']:
    aq, wq, azp, wzp = mmi.input
    dql = prod[aq]; a = dql.input[0]
    cast = users(mmi.output[0])[0]; mul = users(cast.output[0])[0]
    sc = prod[[i for i in mul.input if i != cast.output[0]][0]]          # a_scale * w_scale
    wscale = [i for i in sc.input if i in init][0]
    W = (arr(wq).astype(np.float32) - arr(wzp).astype(np.float32)) * arr(wscale).astype(np.float32)
    wn = wq.replace('_quantized', '') + '_fp32'
    g.initializer.append(numpy_helper.from_array(np.ascontiguousarray(W), wn))
    new = helper.make_node('MatMul', [a, wn], [mul.output[0]], name=mmi.name + '_fp32')
    idx = list(g.node).index(mmi); g.node.insert(idx, new)
    for n in (mmi, cast, mul, sc): g.node.remove(n)
    done += 1
# 쓰지 않게 된 양자화 노드·가중치 정리
changed = True
while changed:
    changed = False; used = {i for n in g.node for i in n.input} | {o.name for o in g.output}
    for n in list(g.node):
        if not any(o in used for o in n.output): g.node.remove(n); changed = True
used = {i for n in g.node for i in n.input}
for t in [t for t in g.initializer if t.name not in used]: g.initializer.remove(t)
onnx.checker.check_model(m); onnx.save(m, sys.argv[2]); print('실수 행렬곱으로 바꾼 곳', done)
