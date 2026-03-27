import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const iosDir = path.join(rootDir, 'ios');

async function findProjectContainer() {
  const entries = await fs.readdir(iosDir);
  const workspace = entries.find(
    (entry) => entry.endsWith('.xcworkspace') && !entry.startsWith('Pods'),
  );

  if (workspace) {
    return {
      key: 'workspace',
      path: path.join(iosDir, workspace),
    };
  }

  const project = entries.find(
    (entry) => entry.endsWith('.xcodeproj') && !entry.startsWith('Pods'),
  );

  if (project) {
    return {
      key: 'project',
      path: path.join(iosDir, project),
    };
  }

  throw new Error('Could not find an iOS workspace or project in ios/.');
}

async function main() {
  const target = await findProjectContainer();
  const { stdout } = await execFileAsync('xcodebuild', [
    '-list',
    '-json',
    `-${target.key}`,
    target.path,
  ]);
  const parsed = JSON.parse(stdout);
  const schemes =
    parsed.workspace?.schemes ?? parsed.project?.schemes ?? parsed.schemes ?? [];
  const scheme =
    schemes.find((candidate) => !candidate.startsWith('Pods-')) ?? schemes[0];

  if (!scheme) {
    throw new Error(`Could not determine an Xcode scheme from ${target.path}.`);
  }

  const payload = {
    [target.key]: target.path,
    scheme,
  };

  const githubOutputFlagIndex = process.argv.indexOf('--github-output');
  if (githubOutputFlagIndex >= 0) {
    const githubOutputPath = process.argv[githubOutputFlagIndex + 1];
    if (!githubOutputPath) {
      throw new Error('--github-output requires a file path argument.');
    }

    const lines = Object.entries(payload).map(([key, value]) => `${key}=${value}`);
    await fs.appendFile(githubOutputPath, `${lines.join('\n')}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
