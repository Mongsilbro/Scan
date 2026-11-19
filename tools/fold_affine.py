# 신경망 모델의 '배율·더하기(Mul·Add)' 층을 앞뒤 합성곱(Conv) 가중치에 미리 합쳐 계산을 줄임. 결과는 수학적으로 같음
# 사용: python3 tools/fold_affine.py 입력.onnx 출력.onnx [--pad]
#  1) Conv → Mul(상수 c) → Add(상수 d)            : Conv 가중치·치우침에 합침 (그 Conv 출력을 다른 곳에서 안 쓸 때)
#  2) X → Mul(상수 c) → Add(상수 d) → Conv(1x1, 덧대기 없음) : 다음 Conv 에 합침 (덧대기가 없으므로 정확히 같음)
import sys, numpy as np, onnx
from onnx import numpy_helper
m = onnx.load(sys.argv[1]); g = m.graph
init = {i.name: i for i in g.initializer}
consts = {n.output[0]: numpy_helper.to_array(n.attribute[0].t) for n in g.node if n.op_type == 'Constant' and n.attribute and n.attribute[0].name == 'value'}
def cval(name):
    if name in init: return numpy_helper.to_array(init[name])
    if name in consts: return consts[name]
    return None
def users(name): return [n for n in g.node if name in n.input]
graph_outs = {o.name for o in g.output}
def setinit(name, arr):
    arr = np.ascontiguousarray(arr.astype(np.float32))
    if name in init: init[name].CopyFrom(numpy_helper.from_array(arr, name))
    else: t = numpy_helper.from_array(arr, name); g.initializer.append(t); init[name] = t
def affine(n):   # n 이 Mul(상수 스칼라, x) 이고 바로 뒤가 Add(상수 스칼라) 하나뿐이면 (c, d, x, add노드)
    if n.op_type != 'Mul': return None
    a, b = n.input; ca, cb = cval(a), cval(b)
    if ca is not None and cb is None: c, x = ca, b
    elif cb is not None and ca is None: c, x = cb, a
    else: return None
    if c.size != 1: return None
    us = users(n.output[0])
    if len(us) != 1 or us[0].op_type != 'Add' or n.output[0] in graph_outs: return None
    ad = us[0]; o = [i for i in ad.input if i != n.output[0]]
    if len(o) != 1: return None
    d = cval(o[0])
    if d is None or d.size != 1: return None
    return float(c.reshape(-1)[0]), float(d.reshape(-1)[0]), x, ad
def conv_wb(cv):
    W = numpy_helper.to_array(init[cv.input[1]]).astype(np.float64)
    if len(cv.input) > 2 and cv.input[2]: B = numpy_helper.to_array(init[cv.input[2]]).astype(np.float64)
    else:
        B = np.zeros(W.shape[0]); bn = cv.output[0] + '_foldbias'; cv.input.append(bn) if len(cv.input) == 2 else None
        if len(cv.input) == 3 and not cv.input[2]: cv.input[2] = bn
        setinit(bn, B)
    return W, B
def rewire(old, new):
    for n in g.node:
        for i, v in enumerate(n.input):
            if v == old: n.input[i] = new
    for o in g.output:
        if o.name == old: o.name = new
shared = lambda name: sum(name in n.input for n in g.node) > 1
removed = 0; changed = True
while changed:
    changed = False
    for n in list(g.node):
        af = affine(n)
        if not af: continue
        c, d, x, ad = af
        prod = [p for p in g.node if x in p.output]
        # 1) 앞 Conv 에 합침
        if prod and prod[0].op_type == 'Conv' and len(users(x)) == 1 and x not in graph_outs and not shared(prod[0].input[1]):
            cv = prod[0]; W, B = conv_wb(cv)
            setinit(cv.input[1], W * c); setinit(cv.input[2], B * c + d)
            rewire(ad.output[0], x); g.node.remove(n); g.node.remove(ad); removed += 2; changed = True; break
        # 2) 뒤 1x1 Conv 에 합침
        us = users(ad.output[0])
        if len(us) == 1 and us[0].op_type == 'Conv' and us[0].input[0] == ad.output[0] and ad.output[0] not in graph_outs:
            cv = us[0]; at = {a.name: onnx.helper.get_attribute_value(a) for a in cv.attribute}
            if list(at.get('kernel_shape', [])) == [1, 1] and not any(at.get('pads', [0])) and at.get('group', 1) == 1 and not shared(cv.input[1]):
                W, B = conv_wb(cv)
                setinit(cv.input[2], B + d * W.sum(axis=(1, 2, 3))); setinit(cv.input[1], W * c)
                cv.input[0] = x; g.node.remove(n); g.node.remove(ad); removed += 2; changed = True; break
# 3) X → Mul(c) → Add(d) → Conv(덧대기 있음) : 덧대기 값을 -d/c 로 바꾼 Pad + 덧대기 없는 Conv 로 정확히 같게 바꿈 (계산 2번 → 복사 1번)
padded = 0
for n in (list(g.node) if '--pad' in sys.argv else []):
    af = affine(n)
    if not af: continue
    c, d, x, ad = af
    us = users(ad.output[0])
    if len(us) != 1 or us[0].op_type != 'Conv' or us[0].input[0] != ad.output[0] or c == 0 or shared(us[0].input[1]): continue
    cv = us[0]; at = {a.name: onnx.helper.get_attribute_value(a) for a in cv.attribute}
    pads = list(at.get('pads', [0, 0, 0, 0]))
    if at.get('auto_pad', b'NOTSET') not in (b'NOTSET', 'NOTSET') or not any(pads): continue
    W, B = conv_wb(cv)
    setinit(cv.input[2], B + d * W.sum(axis=(1, 2, 3))); setinit(cv.input[1], W * c)
    pn = cv.output[0] + '_pads'; vn = cv.output[0] + '_padv'; po = cv.output[0] + '_padded'
    g.initializer.append(numpy_helper.from_array(np.array([0, 0, pads[0], pads[1], 0, 0, pads[2], pads[3]], dtype=np.int64), pn))
    g.initializer.append(numpy_helper.from_array(np.array(-d / c, dtype=np.float32), vn))
    pad = onnx.helper.make_node('Pad', [x, pn, vn], [po], mode='constant', name=cv.name + '_pad')
    g.node.insert(list(g.node).index(n), pad)
    for a in cv.attribute:
        if a.name == 'pads': a.CopyFrom(onnx.helper.make_attribute('pads', [0, 0, 0, 0]))
    cv.input[0] = po; g.node.remove(n); g.node.remove(ad); padded += 1
for t in [t for t in g.initializer if t.name not in {i for n in g.node for i in n.input}]: g.initializer.remove(t)
print('지운 층', removed, 'Pad 로 바꾼 곳', padded)
onnx.checker.check_model(m)
onnx.save(m, sys.argv[2])
