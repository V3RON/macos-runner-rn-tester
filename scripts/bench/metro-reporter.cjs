const fs = require('node:fs');
const path = require('node:path');

function sanitizeError(error) {
  if (!error) {
    return undefined;
  }

  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

function createMetroReporter({ delegate, logPath }) {
  const resolvedLogPath = logPath
    ? path.resolve(logPath)
    : path.resolve(process.cwd(), '.bench-artifacts/metro-reporter.jsonl');

  fs.mkdirSync(path.dirname(resolvedLogPath), { recursive: true });

  return {
    update(event) {
      const record = {
        ...event,
        error: sanitizeError(event.error),
        timestamp: new Date().toISOString(),
      };

      fs.appendFileSync(resolvedLogPath, `${JSON.stringify(record)}\n`);

      if (
        event.type === 'bundle_build_started' ||
        event.type === 'bundle_build_done' ||
        event.type === 'bundle_build_failed' ||
        event.type === 'server_listening' ||
        event.type === 'initialize_failed'
      ) {
        process.stdout.write(`[metro] ${event.type}\n`);
      }

      delegate?.update?.(event);
    },
  };
}

module.exports = {
  createMetroReporter,
};
