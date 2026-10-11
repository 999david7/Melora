// Builds a portable Melora for the current platform: a Node single executable
// application next to an `app` folder holding the web app and its dependencies,
// so nothing (not even Node) needs to be installed on the target computer.
//
//   node packaging/build-portable.mjs
//
// Run it with an official Node build (Homebrew's lacks single executable
// support). The Node running this script is the one embedded in the binary,
// and native modules are installed for this platform, so build on each target.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
if (!platform) throw new Error(`Unsupported platform ${process.platform}`);
const name = `Melora-${platform}-${process.arch}`;
const dist = path.join(root, 'dist-portable');
const bundle = path.join(dist, 'Melora');
const app = path.join(bundle, 'app');
const executable = path.join(bundle, process.platform === 'win32' ? 'Melora.exe' : 'melora');
const windows = process.platform === 'win32';

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: windows, ...options });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const item of ['src', 'public', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  fs.cpSync(path.join(root, item), path.join(app, item), { recursive: true });
}
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });

const blob = path.join(dist, 'sea.blob');
const config = path.join(dist, 'sea.json');
fs.writeFileSync(config, JSON.stringify({
  main: path.join(root, 'packaging', 'launcher.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
}));
run(process.execPath, ['--experimental-sea-config', config], { shell: false });
fs.copyFileSync(process.execPath, executable);
fs.chmodSync(executable, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', executable]);
run('npx', ['--yes', 'postject@1.0.0-alpha.6', executable, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', executable]);
fs.rmSync(blob);
fs.rmSync(config);

const start = windows ? 'Double-click Melora.exe' : 'Run ./melora';
fs.writeFileSync(path.join(bundle, 'README.txt'), `Melora ${process.env.MELORA_VERSION || JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version}

${start}. It starts the library server and opens http://127.0.0.1:4610
in your browser. Keep the window open while you listen; close it to stop.

Command-line use works the same as the Node version, for example:

  ${windows ? 'Melora.exe' : './melora'} init <folder on your drive> --label "Archive SSD"
  ${windows ? 'Melora.exe' : './melora'} sync <music folder>
  ${windows ? 'Melora.exe' : './melora'} help

Keep the "app" folder next to the executable. Node.js is included; nothing
else needs to be installed. Your pairing is stored in ~/.melora/config.json
and the library itself lives on your drive, so replacing this folder with a
newer version keeps everything.

https://github.com/999david7/Melora
`.replace(/\n/g, windows ? '\r\n' : '\n'));

// Create and read a throwaway library, which loads every native module.
const smokeDir = path.join(dist, 'smoke');
const smokeEnv = { ...process.env, MELORA_HOME: path.join(smokeDir, 'home') };
fs.mkdirSync(path.join(smokeDir, 'library'), { recursive: true });
for (const args of [['init', path.join(smokeDir, 'library'), '--label', 'Smoke'], ['status']]) {
  const smoke = spawnSync(executable, args, { encoding: 'utf8', env: smokeEnv });
  console.log(smoke.stdout, smoke.stderr);
  if (smoke.error || smoke.status !== 0) throw new Error(`Smoke test "${args[0]}" failed: ${smoke.error ?? smoke.status}`);
  if (args[0] === 'status' && !/connected at/.test(smoke.stdout)) throw new Error('Smoke test could not read the library.');
}
fs.rmSync(smokeDir, { recursive: true, force: true });

const archive = windows ? `${name}.zip` : `${name}.tar.gz`;
// Windows' own bsdtar writes zips; Git's GNU tar earlier on PATH would not.
run(windows ? 'C:\\Windows\\System32\\tar.exe' : 'tar', windows ? ['-a', '-cf', archive, 'Melora'] : ['-czf', archive, 'Melora'], { cwd: dist });
console.log(`Built ${path.join(dist, archive)}`);
