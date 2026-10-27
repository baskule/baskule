#!/usr/bin/env python3
"""Extract the pinned T3 WS contract; no dependencies, network or running server."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
src = root / 'app/packages/contracts/src'
rpc = (src / 'rpc.ts').read_text()
orch = (src / 'orchestrationV2.ts').read_text()
names = {}
for obj, source in [('WS_METHODS', rpc), ('ORCHESTRATION_V2_WS_METHODS', orch)]:
    block = re.search(r'export const ' + obj + r' = \{(.*?)\} as const', source, re.S).group(1)
    names.update({obj + '.' + k: v for k, v in re.findall(r'(\w+): "([^"]+)"', block)})
rows = []
pattern = r'const (Ws\w+Rpc) = Rpc.make\(\s*((?:WS_METHODS|ORCHESTRATION_V2_WS_METHODS)\.\w+),\s*\{(.*?)\n\s*\},?\s*\);'
for match in re.finditer(pattern, rpc, re.S):
    symbol, key, body = match.groups()
    rows.append({'method': names[key], 'symbol': symbol,
                 'line': rpc[:match.start()].count('\n') + 1,
                 'stream': 'stream: true' in body,
                 'payload': re.search(r'payload: ([^,\n]+)', body).group(1)})
group = rpc.split('export const WsRpcGroup = RpcGroup.make(')[1].split(').middleware')[0]
registered = re.findall(r'\b(Ws\w+Rpc)\b', group)
assert len(rows) == len(registered) == len({x['method'] for x in rows})
assert set(registered) == {x['symbol'] for x in rows}
block = orch.split('export const OrchestrationV2Command = Schema.Union([')[1].split('export type OrchestrationV2Command')[0]
commands = re.findall(r'^    type: Schema.Literal\("([^"]+)"', block, re.M)
print(json.dumps({'methods': rows, 'commands': commands,
                  'unregisteredConstants': sorted(set(names.values()) - {x['method'] for x in rows})}, indent=2))
