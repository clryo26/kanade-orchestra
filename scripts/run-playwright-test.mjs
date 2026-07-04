#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const childEnv = { ...process.env };

// Force localhost traffic to bypass corp proxies for E2E checks.
delete childEnv.HTTP_PROXY;
delete childEnv.HTTPS_PROXY;
delete childEnv.ALL_PROXY;
delete childEnv.http_proxy;
delete childEnv.https_proxy;
delete childEnv.all_proxy;
childEnv.NO_PROXY = '127.0.0.1,localhost';
childEnv.no_proxy = '127.0.0.1,localhost';

const command = `npx playwright test ${args.join(' ')}`.trim();
const child = spawn(command, [], {
  stdio: 'inherit',
  env: childEnv,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  console.error(`Failed to run Playwright: ${err.message}`);
  process.exit(1);
});
