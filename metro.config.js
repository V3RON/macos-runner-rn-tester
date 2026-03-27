const { getDefaultConfig } = require('expo/metro-config');
const { createMetroReporter } = require('./scripts/bench/metro-reporter.cjs');

const config = getDefaultConfig(__dirname);

config.reporter = createMetroReporter({
  delegate: config.reporter,
  logPath: process.env.METRO_REPORTER_LOG_PATH,
});

module.exports = config;
