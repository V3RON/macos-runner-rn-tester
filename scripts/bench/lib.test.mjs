import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_REMOVAL_FINISHED_MESSAGE,
  APP_REMOVAL_STARTED_MESSAGE,
  buildBenchLaunchArguments,
  chooseSimulatorDevice,
  inspectExpectedReadyEvent,
  normalizeCommandLogOutput,
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

test('inspectExpectedReadyEvent returns the matching callback event when present', () => {
  const matchingEvent = {
    appName: 'MetroBench',
    iteration: 7,
    launchToken: 'token-123',
    platform: 'ios',
    receivedAt: '2026-03-27T12:00:05.000Z',
    timestamp: '2026-03-27T12:00:04.000Z',
  };
  const otherEvent = {
    iteration: 6,
    launchToken: 'token-456',
    receivedAt: '2026-03-27T12:00:03.000Z',
  };

  assert.deepEqual(
    inspectExpectedReadyEvent([otherEvent, matchingEvent], {
      iteration: 7,
      launchToken: 'token-123',
    }),
    {
      lastObservedEvent: {
        appName: 'MetroBench',
        iteration: 7,
        launchToken: 'token-123',
        platform: 'ios',
        receivedAt: '2026-03-27T12:00:05.000Z',
        timestamp: '2026-03-27T12:00:04.000Z',
      },
      matchedEvent: matchingEvent,
      observedEventCount: 2,
    },
  );
});

test('inspectExpectedReadyEvent reports the latest mismatched callback while still waiting', () => {
  assert.deepEqual(
    inspectExpectedReadyEvent(
      [
        {
          iteration: 1,
          launchToken: 'old-token',
          receivedAt: '2026-03-27T12:00:01.000Z',
        },
        {
          appName: 'MetroBench',
          iteration: 2,
          launchToken: 'other-token',
          platform: 'ios',
          receivedAt: '2026-03-27T12:00:02.000Z',
          timestamp: '2026-03-27T12:00:01.500Z',
        },
      ],
      {
        iteration: 3,
        launchToken: 'expected-token',
      },
    ),
    {
      lastObservedEvent: {
        appName: 'MetroBench',
        iteration: 2,
        launchToken: 'other-token',
        platform: 'ios',
        receivedAt: '2026-03-27T12:00:02.000Z',
        timestamp: '2026-03-27T12:00:01.500Z',
      },
      matchedEvent: null,
      observedEventCount: 2,
    },
  );
});

test('app removal log messages make the simctl uninstall step explicit', () => {
  assert.equal(
    APP_REMOVAL_STARTED_MESSAGE,
    'Running simctl uninstall for existing app before install',
  );
  assert.equal(
    APP_REMOVAL_FINISHED_MESSAGE,
    'Finished simctl uninstall for existing app',
  );
});

test('normalizeCommandLogOutput trims empty command output out of follow-up logs', () => {
  assert.equal(normalizeCommandLogOutput(''), undefined);
  assert.equal(normalizeCommandLogOutput('  \n  '), undefined);
  assert.equal(
    normalizeCommandLogOutput('\nNo such file or app installed.\n'),
    'No such file or app installed.',
  );
});
