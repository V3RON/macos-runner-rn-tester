import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBenchUrl,
  chooseSimulatorDevice,
  parseBenchUrl,
  parseRuntimeVersion,
} from './lib.mjs';

test('parseRuntimeVersion handles iOS runtime identifiers', () => {
  assert.deepEqual(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-18-4'), [
    18,
    4,
  ]);
});

test('chooseSimulatorDevice prefers the newest available iPhone runtime', () => {
  const device = chooseSimulatorDevice(
    {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
        { isAvailable: true, name: 'iPhone 15', state: 'Shutdown', udid: 'old' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { isAvailable: true, name: 'iPhone 16', state: 'Shutdown', udid: 'new' },
      ],
    },
    '',
  );

  assert.equal(device?.udid, 'new');
});

test('buildBenchUrl encodes the iteration payload', () => {
  const url = buildBenchUrl({
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
    scheme: 'metrobench',
  });

  assert.equal(
    url,
    'metrobench://bench?callbackPort=4010&iteration=7&launchToken=token-123&launchedAt=2026-03-27T12%3A00%3A00.000Z',
  );
});

test('buildBenchUrl round-trips through parseBenchUrl for launch delivery', () => {
  const url = buildBenchUrl({
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
    scheme: 'metrobench',
  });

  assert.deepEqual(parseBenchUrl(url), {
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
    url,
  });
});

test('parseBenchUrl rejects missing required launch parameters', () => {
  assert.equal(parseBenchUrl('metrobench://bench?callbackPort=4010'), null);
});
