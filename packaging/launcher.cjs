// Entry point of the portable Melora executable (a Node single executable
// application). The embedded script can only load built-in modules, so it
// imports the real app from the `app` folder that ships next to the binary.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const appDir = path.join(path.dirname(fs.realpathSync(process.execPath)), 'app');
const args = process.argv.slice(2);
// A double-click starts the interface and opens it; anything else is a CLI call.
const doubleClicked = args.length === 0;
if (doubleClicked) args.push('serve');
process.argv = [process.execPath, path.join(appDir, 'src', 'cli.js'), ...args];

if (doubleClicked && process.platform === 'win32') {
  // Keep the console open long enough to read why the server stopped.
  process.on('exit', (code) => {
    if (code === 0) return;
    try {
      process.stdout.write('\nMelora stopped. Press Enter to close this window.');
      fs.readSync(0, Buffer.alloc(1));
    } catch { /* no console attached */ }
  });
}

async function openWhenReady() {
  const { loadConfig } = await import(pathToFileURL(path.join(appDir, 'src', 'config.js')).href);
  const { host, port } = loadConfig().server;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const until = Date.now() + 30000;
  // Wait for the port to answer: the drive may still be waking up.
  while (Date.now() < until) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: new URL(url).hostname, port });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
    });
    if (open) {
      const [command, commandArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(command, commandArgs, { stdio: 'ignore', detached: true }).on('error', () => {
        console.log(`Open ${url} in your browser.`);
      }).unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

import(pathToFileURL(process.argv[1]).href).catch((err) => {
  console.error(`melora: could not start: ${err.message}`);
  process.exit(1);
});
if (doubleClicked) openWhenReady().catch(() => {});
