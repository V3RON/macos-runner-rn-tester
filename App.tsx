import Constants from 'expo-constants';
import { LaunchArguments } from 'expo-native-launch-arguments';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

type LaunchConfig = {
  callbackPort: number;
  iteration: number;
  launchToken: string;
  launchedAt: string;
};

type CallbackState =
  | { status: 'waiting-for-launch' }
  | { status: 'sending'; attempts: number }
  | { status: 'sent'; attempts: number; sentAt: string }
  | { status: 'failed'; attempts: number; error: string };

const MAX_CALLBACK_ATTEMPTS = 5;

function parseLaunchConfig(
  launchArguments: Record<string, string | number | boolean> | null,
): LaunchConfig | null {
  if (!launchArguments) {
    return null;
  }

  const iteration =
    launchArguments.iteration == null
      ? Number.NaN
      : Number(launchArguments.iteration);
  const callbackPort =
    launchArguments.callbackPort == null
      ? Number.NaN
      : Number(launchArguments.callbackPort);
  const launchToken =
    typeof launchArguments.launchToken === 'string'
      ? launchArguments.launchToken
      : '';
  const launchedAt =
    typeof launchArguments.launchedAt === 'string'
      ? launchArguments.launchedAt
      : '';

  if (
    !Number.isInteger(iteration) ||
    iteration <= 0 ||
    !Number.isInteger(callbackPort) ||
    callbackPort <= 0 ||
    launchToken.length === 0 ||
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyBench(
  config: LaunchConfig,
  onAttempt: (attempt: number) => void,
) {
  const payload = {
    appName: Constants.expoConfig?.name ?? 'unknown',
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    iteration: config.iteration,
    launchToken: config.launchToken,
    launchedAt: config.launchedAt,
    platform: Platform.OS,
    timestamp: new Date().toISOString(),
  };

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt += 1) {
    onAttempt(attempt);

    try {
      const response = await fetch(
        `http://localhost:${config.callbackPort}/app-ready`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        return {
          attempts: attempt,
          sentAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < MAX_CALLBACK_ATTEMPTS) {
      await delay(attempt * 1000);
    }
  }

  throw new Error(lastError);
}

export default function App() {
  const [launchConfig] = useState<LaunchConfig | null>(() =>
    parseLaunchConfig(
      LaunchArguments.value<Record<string, string | number | boolean>>(),
    ),
  );
  const [callbackState, setCallbackState] = useState<CallbackState>({
    status: 'waiting-for-launch',
  });
  const sentLaunchTokens = useRef(new Set<string>());

  useEffect(() => {
    if (!launchConfig) {
      return;
    }

    if (sentLaunchTokens.current.has(launchConfig.launchToken)) {
      return;
    }

    sentLaunchTokens.current.add(launchConfig.launchToken);
    let cancelled = false;

    void notifyBench(launchConfig, (attempt) => {
      if (!cancelled) {
        setCallbackState({
          status: 'sending',
          attempts: attempt,
        });
      }
    })
      .then((result) => {
        if (!cancelled) {
          setCallbackState({
            status: 'sent',
            attempts: result.attempts,
            sentAt: result.sentAt,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCallbackState({
            status: 'failed',
            attempts: MAX_CALLBACK_ATTEMPTS,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [launchConfig]);

  const callbackStatus = useMemo(() => {
    switch (callbackState.status) {
      case 'waiting-for-launch':
        return 'Waiting for the bench runner to launch this iteration.';
      case 'sending':
        return `Sending callback (attempt ${callbackState.attempts}/${MAX_CALLBACK_ATTEMPTS})`;
      case 'sent':
        return `Callback sent after ${callbackState.attempts} attempt(s) at ${callbackState.sentAt}`;
      case 'failed':
        return `Callback failed after ${callbackState.attempts} attempts: ${callbackState.error}`;
      default:
        return 'Unknown callback state';
    }
  }, [callbackState]);

  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>Expo iOS Metro Repro Bench</Text>
      <Text style={styles.title}>Metro Launch Probe</Text>
      <Text style={styles.copy}>
        This app waits for a bench launch URL and then calls back to the host
        once React has mounted.
      </Text>
      <View style={styles.card}>
        <Text style={styles.label}>Iteration</Text>
        <Text style={styles.value}>
          {launchConfig ? String(launchConfig.iteration) : 'Not launched yet'}
        </Text>
        <Text style={styles.label}>Callback port</Text>
        <Text style={styles.value}>
          {launchConfig ? String(launchConfig.callbackPort) : 'Waiting'}
        </Text>
        <Text style={styles.label}>Launch token</Text>
        <Text numberOfLines={2} style={styles.muted}>
          {launchConfig?.launchToken ?? 'Waiting'}
        </Text>
        <Text style={styles.label}>Callback state</Text>
        <Text style={styles.value}>{callbackStatus}</Text>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f6fb',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  eyebrow: {
    color: '#3a5f8a',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  title: {
    color: '#132238',
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 12,
  },
  copy: {
    color: '#516176',
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#ffffff',
    borderColor: '#d9e2ec',
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    shadowColor: '#10233d',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
  },
  label: {
    color: '#5d6f83',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
    textTransform: 'uppercase',
  },
  value: {
    color: '#132238',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 4,
  },
  muted: {
    color: '#516176',
    fontSize: 14,
    marginTop: 4,
  },
});
