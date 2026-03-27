export const DEFAULT_BENCH_ARTIFACTS_DIR = '.bench-artifacts';
export const DEFAULT_BUNDLE_TIMEOUT_SECONDS = 60;
export const DEFAULT_CALLBACK_PORT = 4010;
export const DEFAULT_ITERATIONS = 10;
export const DEFAULT_METRO_PORT = 8081;
export const DEFAULT_READY_TIMEOUT_SECONDS = 30;

function compareRuntimeVersions(left, right) {
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

export function buildBenchLaunchArguments({
  callbackPort,
  iteration,
  launchToken,
  launchedAt,
}) {
  return {
    callbackPort: String(callbackPort),
    iteration: String(iteration),
    launchToken,
    launchedAt,
  };
}

export function parseBenchLaunchArguments(launchArguments) {
  if (!launchArguments || typeof launchArguments !== 'object') {
    return null;
  }

  const {
    iteration: rawIteration,
    callbackPort: rawCallbackPort,
    launchToken,
    launchedAt,
  } = launchArguments;
  const iteration = rawIteration == null ? Number.NaN : Number(rawIteration);
  const callbackPort =
    rawCallbackPort == null ? Number.NaN : Number(rawCallbackPort);

  if (
    !Number.isInteger(iteration) ||
    iteration <= 0 ||
    !Number.isInteger(callbackPort) ||
    callbackPort <= 0 ||
    typeof launchToken !== 'string' ||
    launchToken.length === 0 ||
    typeof launchedAt !== 'string' ||
    launchedAt.length === 0
  ) {
    return null;
  }

  return {
    callbackPort,
    iteration,
    launchToken,
    launchedAt,
  };
}

export function serializeLaunchArgumentsForSimctl(launchArguments) {
  return Object.entries(launchArguments).flatMap(([key, value]) => [
    `-${key}`,
    String(value),
  ]);
}

export function chooseSimulatorDevice(devicesByRuntime, requestedName) {
  const runtimes = Object.entries(devicesByRuntime)
    .map(([runtimeIdentifier, devices]) => ({
      devices,
      runtimeIdentifier,
      version: parseRuntimeVersion(runtimeIdentifier),
    }))
    .sort((left, right) => compareRuntimeVersions(left.version, right.version));

  const exactRequestedMatch = requestedName
    ? runtimes
        .flatMap(({ devices }) => devices)
        .find((device) => device.isAvailable && device.name === requestedName)
    : null;

  if (exactRequestedMatch) {
    return exactRequestedMatch;
  }

  const fuzzyRequestedMatch = requestedName
    ? runtimes
        .flatMap(({ devices }) => devices)
        .find(
          (device) =>
            device.isAvailable &&
            device.name.toLowerCase().includes(requestedName.toLowerCase()),
        )
    : null;

  if (fuzzyRequestedMatch) {
    return fuzzyRequestedMatch;
  }

  const bootedIPhone = runtimes
    .flatMap(({ devices }) => devices)
    .find(
      (device) =>
        device.isAvailable &&
        device.state === 'Booted' &&
        device.name.startsWith('iPhone'),
    );

  if (bootedIPhone) {
    return bootedIPhone;
  }

  for (const runtime of runtimes) {
    const iPhone = runtime.devices.find(
      (device) => device.isAvailable && device.name.startsWith('iPhone'),
    );
    if (iPhone) {
      return iPhone;
    }
  }

  return null;
}

export function parsePositiveInt(value, fallbackValue) {
  if (value == null || value === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

export function parseRuntimeVersion(runtimeIdentifier) {
  const rawVersion = runtimeIdentifier.split('.').pop() ?? '';
  return rawVersion
    .replace(/^iOS-/, '')
    .split('-')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

export function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    name: 'UnknownError',
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
