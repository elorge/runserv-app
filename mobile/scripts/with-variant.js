// Runs a command with APP_VARIANT set, on any OS:  node scripts/with-variant.js driver expo start
const { spawn } = require('child_process');
const [variant, cmd, ...args] = process.argv.slice(2);
if (!['customer', 'driver'].includes(variant) || !cmd) { console.error('Usage: node scripts/with-variant.js <customer|driver> <command> [args]'); process.exit(1); }
const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, APP_VARIANT: variant } });
p.on('exit', (c) => process.exit(c ?? 0));
