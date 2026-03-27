# Expo iOS Metro Repro Bench

This repository contains a tiny Expo app plus a CI bench that repeatedly launches the same debug iOS simulator build against Metro without rebuilding the app or rebooting the simulator.

Each bench iteration launches the simulator app with `simctl launch` and passes the bench payload as native launch arguments. The Expo app reads those values with `expo-native-launch-arguments`, so the bench no longer depends on a custom URL or the simulator’s system “Open” confirmation dialog.

## What it captures

- Metro stdout and stderr
- Structured Metro reporter events in JSONL
- App-ready callback requests from the React app
- Simulator log stream output
- A rolling simulator recording for the current iteration
- A machine-readable summary JSON with per-iteration outcomes

## Local usage

1. Install dependencies with `npm install`.
2. Generate native iOS files with `npx expo prebuild --platform ios --clean`.
3. Build the simulator app with Xcode or `xcodebuild`.
4. Run the bench with:

```bash
BENCH_APP_PATH=/absolute/path/to/YourApp.app npm run bench:run
```

Optional environment variables:

- `BENCH_ITERATIONS`
- `BENCH_BUNDLE_TIMEOUT_SECONDS`
- `BENCH_READY_TIMEOUT_SECONDS`
- `BENCH_CALLBACK_PORT`
- `BENCH_DEVICE_NAME`
- `BENCH_BUNDLE_IDENTIFIER`

Artifacts are written to `.bench-artifacts/`.

## GitHub Actions

The workflow lives at `.github/workflows/ios-metro-repro-bench.yml` and is exposed as a manual `workflow_dispatch` job on `macos-latest`.
