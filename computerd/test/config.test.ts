import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
const base = { COMPUTERD_TOKEN: 'test-token-123456789' };
test('Kubernetes chart options reach backend configuration', () => {
  const cfg = loadConfig({ ...base, COMPUTER_BACKEND: 'kubernetes', COMPUTER_STORAGE_CLASS: 'fast', COMPUTER_DISK_SIZE: '20Gi', COMPUTER_RUNTIME_CLASS_NAME: 'gvisor', COMPUTER_NODE_SELECTOR: '{"pool":"computers"}', COMPUTER_TOLERATIONS: '[{"key":"computers","operator":"Exists"}]', COMPUTER_IMAGE_PULL_SECRETS: '[{"name":"registry"}]' });
  assert.equal(cfg.backend, 'kubernetes');
  assert.deepEqual(cfg.kubernetes, { storageClass: 'fast', storageSize: '20Gi', runtimeClassName: 'gvisor', nodeSelector: { pool: 'computers' }, tolerations: [{ key: 'computers', operator: 'Exists' }], imagePullSecrets: [{ name: 'registry' }] });
  assert.equal(loadConfig(base).kubernetes?.storageSize, '10Gi');
});
test('invalid scheduling JSON fails at configuration boundary', () => {
  for (const options of [{ COMPUTER_NODE_SELECTOR: '{"pool":1}' }, { COMPUTER_TOLERATIONS: '{}' }, { COMPUTER_IMAGE_PULL_SECRETS: '[{}]' }]) assert.throws(() => loadConfig({ ...base, ...options }));
});
