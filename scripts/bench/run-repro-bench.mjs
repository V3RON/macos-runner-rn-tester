import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_BENCH_ARTIFACTS_DIR,
  DEFAULT_BUNDLE_TIMEOUT_SECONDS,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_ITERATIONS,
  DEFAULT_METRO_PORT,
  DEFAULT_READY_TIMEOUT_SECONDS,
  buildBenchLaunchArguments,
  chooseSimulatorDevice,
  parsePositiveInt,
  serializeError,
  serializeLaunchArgumentsForSimctl,
  sleep,
} from './lib.mjs';

const execFileAsync = promisify(execFile);
const localHost = 'localhost';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsDir = path.resolve(
  process.env.BENCH_ARTIFACTS_DIR ?? path.join(rootDir, DEFAULT_BENCH_ARTIFACTS_DIR),
);
const timelineLogPath = path.join(artifactsDir, 'timeline.jsonl');
const callbackLogPath = path.join(artifactsDir, 'callback-server.jsonl');
const metroLogPath = path.join(artifactsDir, 'metro.log');
const metroReporterLogPath = path.join(artifactsDir, 'metro-reporter.jsonl');
const simulatorLogPath = path.join(artifactsDir, 'simulator.log');
const summaryPath = path.join(artifactsDir, 'bench-summary.json');
const videoPath = path.join(artifactsDir, 'simulator-current-run.mp4');
const recordingLogPath = path.join(artifactsDir, 'recording.log');
const bundleTimeoutMs =
  parsePositiveInt(
    process.env.BENCH_BUNDLE_TIMEOUT_SECONDS,
    DEFAULT_BUNDLE_TIMEOUT_SECONDS,
  ) * 1000;
const callbackPort = parsePositiveInt(
  process.env.BENCH_CALLBACK_PORT,
  DEFAULT_CALLBACK_PORT,
);
const iterations = parsePositiveInt(process.env.BENCH_ITERATIONS, DEFAULT_ITERATIONS);
const metroPort = parsePositiveInt(process.env.BENCH_METRO_PORT, DEFAULT_METRO_PORT);
const readyTimeoutMs =
  parsePositiveInt(
    process.env.BENCH_READY_TIMEOUT_SECONDS,
    DEFAULT_READY_TIMEOUT_SECONDS,
  ) * 1000;

function appendLine(filePath, line) {
  return fs.appendFile(filePath, `${line}\n`);
}

async function appendJsonLine(filePath, payload) {
  await appendLine(filePath, JSON.stringify(payload));
}

async function ensureArtifactsDir() {
  await fs.mkdir(artifactsDir, { recursive: true });
}

async function readExpoConfig() {
  const appJson = JSON.parse(
    await fs.readFile(path.join(rootDir, 'app.json'), 'utf8'),
  );
  return appJson.expo ?? {};
}

async function logTimeline(event, payload = {}) {
  await appendJsonLine(timelineLogPath, {
    event,
    payload,
    timestamp: new Date().toISOString(),
  });
}

function consoleState(message, payload = undefined) {
  const timestamp = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[bench] ${timestamp} ${message}`);
    return;
  }

  console.log(`[bench] ${timestamp} ${message} ${JSON.stringify(payload)}`);
}

async function runCommand(command, args, options = {}) {
  const { allowFailure = false, cwd = rootDir } = options;

  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      code: 0,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (allowFailure) {
      return {
        code: error.code ?? 1,
        stderr: error.stderr ?? '',
        stdout: error.stdout ?? '',
      };
    }
    throw error;
  }
}

class CallbackServer {
  constructor(port) {
    this.port = port;
    this.expectedIteration = null;
    this.expectedLaunchToken = null;
    this.events = [];
    this.server = null;
  }

  expect({ iteration, launchToken }) {
    this.expectedIteration = iteration;
    this.expectedLaunchToken = launchToken;
  }

  async start() {
    this.server = http.createServer(async (request, response) => {
      if (!request.url) {
        response.writeHead(400).end();
        return;
      }

      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === 'POST' && request.url === '/app-ready') {
        const body = await new Promise((resolve, reject) => {
          let raw = '';
          request.setEncoding('utf8');
          request.on('data', (chunk) => {
            raw += chunk;
          });
          request.on('end', () => resolve(raw));
          request.on('error', reject);
        });

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          response.writeHead(400).end();
          return;
        }

        const entry = {
          ...payload,
          receivedAt: new Date().toISOString(),
        };

        this.events.push(entry);
        await appendJsonLine(callbackLogPath, entry);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, localHost, resolve);
    });

    await logTimeline('callback_server_started', { port: this.port });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async waitForReady({ iteration, launchToken }, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const event = this.events.find(
        (candidate) =>
          candidate.iteration === iteration &&
          candidate.launchToken === launchToken,
      );

      if (event) {
        return event;
      }

      await sleep(250);
    }

    return null;
  }
}

function parseMetroStdoutEvent(line) {
  const normalizedLine = line.trim();

  if (!normalizedLine) {
    return null;
  }

  if (
    /^(iOS|Android|Web) Bundled \d+ms /.test(normalizedLine) ||
    /^Bundled \d+ms /.test(normalizedLine)
  ) {
    return {
      line: normalizedLine,
      type: 'bundle_build_done',
    };
  }

  if (
    /^(iOS|Android|Web) .+\(\s*\d+\/\d+\)$/.test(normalizedLine) ||
    /^(iOS|Android|Web) .*[░▓]/.test(normalizedLine)
  ) {
    return {
      line: normalizedLine,
      type: 'bundle_build_started',
    };
  }

  return null;
}

class MetroStdoutMonitor {
  constructor(eventLogPath) {
    this.eventLogPath = eventLogPath;
    this.events = [];
  }

  noteLine(line, streamName) {
    const event = parseMetroStdoutEvent(line);
    if (!event) {
      return;
    }

    const record = {
      ...event,
      streamName,
      timestamp: new Date().toISOString(),
    };

    this.events.push(record);
    void appendJsonLine(this.eventLogPath, record);
  }

  async waitFor(predicate, timeoutMs) {
    const startIndex = this.events.length;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const event of this.events.slice(startIndex)) {
        if (predicate(event)) {
          return event;
        }
      }

      await sleep(250);
    }

    return null;
  }
}

function pipeChildOutput(child, outputPath, prefix, options = {}) {
  const { mirrorToConsole = false, onLine } = options;
  const pending = {
    stderr: '',
    stdout: '',
  };

  const emitLine = async (line, streamName) => {
    await appendLine(outputPath, `[${new Date().toISOString()}] ${prefix} ${line}`);
    if (mirrorToConsole && line) {
      console.log(`[${prefix}] ${line}`);
    }
    onLine?.(line, streamName);
  };

  const flushChunk = async (chunk, streamName) => {
    pending[streamName] += chunk.toString('utf8').replaceAll('\r', '\n');
    const lines = pending[streamName].split('\n');
    pending[streamName] = lines.pop() ?? '';

    for (const line of lines) {
      if (!line) {
        continue;
      }
      await emitLine(line, streamName);
    }
  };

  child.stdout?.on('data', (chunk) => {
    void flushChunk(chunk, 'stdout');
  });
  child.stderr?.on('data', (chunk) => {
    void flushChunk(chunk, 'stderr');
  });

  child.once('exit', () => {
    for (const [streamName, line] of Object.entries(pending)) {
      if (!line) {
        continue;
      }
      void emitLine(line, streamName);
      pending[streamName] = '';
    }
  });
}

function startMetro() {
  const stdoutMonitor = new MetroStdoutMonitor(metroReporterLogPath);
  consoleState('Starting Metro process', {
    command: ['npx', 'expo', 'start', '--dev-client', '--localhost', '--port', String(metroPort)],
    cwd: rootDir,
    port: metroPort,
  });

  const metro = spawn(
    'npx',
    ['expo', 'start', '--dev-client', '--localhost', '--port', String(metroPort)],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        CI: '1',
        METRO_REPORTER_LOG_PATH: metroReporterLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  consoleState('Metro process spawned', { pid: metro.pid ?? null });
  pipeChildOutput(metro, metroLogPath, 'metro', {
    mirrorToConsole: true,
    onLine(line, streamName) {
      stdoutMonitor.noteLine(line, streamName);
    },
  });
  return {
    metro,
    stdoutMonitor,
  };
}

async function stopChild(child, signal = 'SIGINT') {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill(signal);
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 5000);
  });
}

async function waitForMetroReady(metro) {
  const deadline = Date.now() + bundleTimeoutMs;
  let lastStatus = 'waiting for first /status response';
  let nextProgressReportAt = Date.now();

  while (Date.now() < deadline) {
    if (metro.exitCode !== null) {
      consoleState('Metro exited before becoming ready', {
        exitCode: metro.exitCode,
        lastStatus,
      });
      throw new Error(`Metro exited early with code ${metro.exitCode}.`);
    }

    try {
      const response = await fetch(`http://${localHost}:${metroPort}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = await response.text();
      lastStatus = `HTTP ${response.status}: ${body.trim()}`;
      if (response.ok && body.includes('packager-status:running')) {
        consoleState('Metro /status is healthy', {
          elapsedMs: bundleTimeoutMs - (deadline - Date.now()),
          status: lastStatus,
        });
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= nextProgressReportAt) {
      consoleState('Waiting for Metro readiness', {
        elapsedMs: bundleTimeoutMs - (deadline - Date.now()),
        pid: metro.pid ?? null,
        status: lastStatus,
      });
      nextProgressReportAt = Date.now() + 5000;
    }

    await sleep(500);
  }

  consoleState('Metro did not become ready before timeout', {
    lastStatus,
    timeoutMs: bundleTimeoutMs,
  });
  throw new Error('Metro did not become ready before the timeout.');
}

async function pickSimulatorUdId(requestedDeviceName) {
  const result = await runCommand('xcrun', [
    'simctl',
    'list',
    'devices',
    'available',
    '--json',
  ]);
  const parsed = JSON.parse(result.stdout);
  const device = chooseSimulatorDevice(parsed.devices, requestedDeviceName ?? '');

  if (!device) {
    throw new Error('Could not find an available iPhone simulator.');
  }

  return device;
}

async function bootSimulator(udid) {
  await runCommand('xcrun', ['simctl', 'boot', udid], { allowFailure: true });
  await runCommand('xcrun', ['simctl', 'bootstatus', udid, '-b']);
}

function startSimulatorLogStream(udid) {
  const child = spawn(
    'xcrun',
    ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--level', 'debug'],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  pipeChildOutput(child, simulatorLogPath, 'simulator');
  return child;
}

function startRecording(udid) {
  const child = spawn(
    'xcrun',
    ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', videoPath],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  pipeChildOutput(child, recordingLogPath, 'recording');
  return child;
}

async function installApp(udid, bundleIdentifier, appPath) {
  await runCommand('xcrun', ['simctl', 'uninstall', udid, bundleIdentifier], {
    allowFailure: true,
  });
  await runCommand('xcrun', ['simctl', 'install', udid, appPath]);
}

async function terminateApp(udid, bundleIdentifier) {
  await runCommand('xcrun', ['simctl', 'terminate', udid, bundleIdentifier], {
    allowFailure: true,
  });
}

async function launchBenchApp(udid, bundleIdentifier, launchArguments) {
  return runCommand('xcrun', [
    'simctl',
    'launch',
    udid,
    bundleIdentifier,
    ...serializeLaunchArgumentsForSimctl(launchArguments),
  ]);
}

async function writeSummary(summary) {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  await ensureArtifactsDir();
  await fs.writeFile(metroLogPath, '');
  await fs.writeFile(metroReporterLogPath, '');
  await fs.writeFile(simulatorLogPath, '');
  await fs.writeFile(callbackLogPath, '');
  await fs.writeFile(timelineLogPath, '');
  await fs.writeFile(recordingLogPath, '');

  const expoConfig = await readExpoConfig();
  const bundleIdentifier =
    process.env.BENCH_BUNDLE_IDENTIFIER ?? expoConfig.ios?.bundleIdentifier;
  const appPath = process.env.BENCH_APP_PATH
    ? path.resolve(process.env.BENCH_APP_PATH)
    : null;

  if (!bundleIdentifier) {
    throw new Error('BENCH_BUNDLE_IDENTIFIER is not set and app.json has no ios.bundleIdentifier.');
  }

  if (!appPath) {
    throw new Error('BENCH_APP_PATH must point to the built iOS .app bundle.');
  }

  await fs.access(appPath);
  consoleState('Bench configuration loaded', {
    appPath,
    artifactsDir,
    bundleIdentifier,
    bundleTimeoutMs,
    callbackPort,
    iterations,
    metroPort,
    readyTimeoutMs,
  });
  await logTimeline('bench_started', {
    appPath,
    bundleIdentifier,
    bundleTimeoutMs,
    callbackPort,
    iterations,
    readyTimeoutMs,
  });

  const summary = {
    appPath,
    bundleIdentifier,
    callbackPort,
    device: null,
    iterations: [],
    status: 'running',
  };

  const callbackServer = new CallbackServer(callbackPort);
  let metroStdoutMonitor;
  let metro;
  let simulatorLogs;
  let recording;

  try {
    await callbackServer.start();
    consoleState('Callback server listening', { port: callbackPort });

    const metroResult = startMetro();
    metro = metroResult.metro;
    metroStdoutMonitor = metroResult.stdoutMonitor;
    await waitForMetroReady(metro);
    await logTimeline('metro_ready', { port: metroPort });

    const device = await pickSimulatorUdId(process.env.BENCH_DEVICE_NAME);
    summary.device = device;
    consoleState('Selected simulator device', device);
    await logTimeline('simulator_selected', device);
    await bootSimulator(device.udid);
    consoleState('Simulator booted', { name: device.name, udid: device.udid });

    simulatorLogs = startSimulatorLogStream(device.udid);
    consoleState('Started simulator log stream', { udid: device.udid });
    await installApp(device.udid, bundleIdentifier, appPath);
    consoleState('Installed app on simulator', { appPath, bundleIdentifier, udid: device.udid });
    await logTimeline('app_installed', { appPath, udid: device.udid });

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const launchToken = randomUUID();
      const launchedAt = new Date().toISOString();
      const benchLaunchArguments = buildBenchLaunchArguments({
        callbackPort,
        iteration,
        launchToken,
        launchedAt,
      });

      callbackServer.expect({ iteration, launchToken });
      await terminateApp(device.udid, bundleIdentifier);
      await fs.rm(videoPath, { force: true });
      recording = startRecording(device.udid);
      consoleState('Starting iteration', {
        iteration,
        launchToken,
        videoPath,
      });
      await logTimeline('iteration_started', { iteration, launchToken });

      try {
        await launchBenchApp(device.udid, bundleIdentifier, benchLaunchArguments);
        consoleState('Requested app launch via simctl launch arguments', {
          iteration,
          launchArguments: benchLaunchArguments,
        });

        const bundleEvent = await metroStdoutMonitor.waitFor(
          (event) =>
            event.type === 'bundle_build_started' ||
            event.type === 'bundle_build_done',
          bundleTimeoutMs,
        );

        if (!bundleEvent) {
          consoleState('Timed out waiting for Metro bundling', {
            iteration,
            timeoutMs: bundleTimeoutMs,
          });
          throw Object.assign(new Error('No Metro bundling detected before timeout.'), {
            code: 'bundle_timeout',
          });
        }

        consoleState('Detected Metro bundling activity', {
          iteration,
          eventType: bundleEvent.type,
          timestamp: bundleEvent.timestamp ?? null,
        });

        const readyEvent = await callbackServer.waitForReady(
          { iteration, launchToken },
          readyTimeoutMs,
        );

        if (!readyEvent) {
          consoleState('Timed out waiting for app-ready callback', {
            iteration,
            timeoutMs: readyTimeoutMs,
          });
          throw Object.assign(new Error('App did not report readiness before timeout.'), {
            code: 'app_ready_timeout',
          });
        }

        consoleState('Received app-ready callback', {
          iteration,
          launchToken,
          receivedAt: readyEvent.receivedAt,
        });

        summary.iterations.push({
          appReadyEvent: readyEvent,
          bundleEvent,
          iteration,
          launchToken,
          launchedAt,
          status: 'passed',
        });
        await logTimeline('iteration_passed', { iteration, launchToken });
        consoleState('Iteration passed', { iteration, launchToken });
        await terminateApp(device.udid, bundleIdentifier);
        await stopChild(recording);
        recording = null;
      } catch (error) {
        const failureCode =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'launch_failed';

        summary.iterations.push({
          error: serializeError(error),
          failureCode,
          iteration,
          launchToken,
          launchedAt,
          status: 'failed',
        });
        summary.status = 'failed';
        summary.failureCode = failureCode;
        await logTimeline('iteration_failed', {
          failureCode,
          iteration,
          launchToken,
        });
        consoleState('Iteration failed', {
          failureCode,
          iteration,
          launchToken,
          message: error instanceof Error ? error.message : String(error),
        });
        await terminateApp(device.udid, bundleIdentifier);
        await stopChild(recording);
        recording = null;
        throw error;
      }
    }

    summary.status = 'passed';
    consoleState('Bench completed successfully');
  } catch (error) {
    if (summary.status !== 'failed') {
      summary.status =
        error instanceof Error && error.message.includes('Metro did not become ready')
          ? 'metro_not_ready'
          : 'failed';
      summary.error = serializeError(error);
    } else {
      summary.error = serializeError(error);
    }
    consoleState('Bench failed', {
      message: error instanceof Error ? error.message : String(error),
      status: summary.status,
    });
    throw error;
  } finally {
    await writeSummary(summary);
    await stopChild(recording);
    await stopChild(simulatorLogs);
    await stopChild(metro);
    await callbackServer.stop().catch(() => {});
    await logTimeline('bench_finished', { status: summary.status });
    consoleState('Bench cleanup finished', { status: summary.status });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
