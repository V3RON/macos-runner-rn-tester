import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBenchLaunchArguments,
  chooseSimulatorDevice,
  parseBenchLaunchArguments,
  parseRuntimeVersion,
  serializeLaunchArgumentsForSimctl,
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

test('buildBenchLaunchArguments encodes the iteration payload', () => {
  const launchArguments = buildBenchLaunchArguments({
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
  });

  assert.deepEqual(launchArguments, {
    callbackPort: '4010',
    iteration: '7',
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
  });
});

test('buildBenchLaunchArguments round-trips through parseBenchLaunchArguments', () => {
  const launchArguments = buildBenchLaunchArguments({
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
  });

  assert.deepEqual(parseBenchLaunchArguments(launchArguments), {
    callbackPort: 4010,
    iteration: 7,
    launchToken: 'token-123',
    launchedAt: '2026-03-27T12:00:00.000Z',
  });
});

test('serializeLaunchArgumentsForSimctl formats arguments for simctl launch', () => {
  assert.deepEqual(
    serializeLaunchArgumentsForSimctl({
      callbackPort: '4010',
      iteration: '7',
      launchToken: 'token-123',
      launchedAt: '2026-03-27T12:00:00.000Z',
    }),
    [
      '-callbackPort',
      '4010',
      '-iteration',
      '7',
      '-launchToken',
      'token-123',
      '-launchedAt',
      '2026-03-27T12:00:00.000Z',
    ],
  );
});

test('parseBenchLaunchArguments rejects missing required launch parameters', () => {
  assert.equal(
    parseBenchLaunchArguments({
      callbackPort: 4010,
      launchToken: 'token-123',
      launchedAt: '2026-03-27T12:00:00.000Z',
    }),
    null,
  );
  assert.equal(
    parseBenchLaunchArguments({
      iteration: 7,
      launchToken: 'token-123',
      launchedAt: '2026-03-27T12:00:00.000Z',
    }),
    null,
  );
  assert.equal(
    parseBenchLaunchArguments({
      callbackPort: 4010,
      iteration: 7,
      launchedAt: '2026-03-27T12:00:00.000Z',
    }),
    null,
  );
  assert.equal(
    parseBenchLaunchArguments({
      callbackPort: 4010,
      iteration: 7,
      launchToken: 'token-123',
    }),
    null,
  );
});
