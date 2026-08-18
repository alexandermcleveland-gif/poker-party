/* online.js — Host a Poker Party game over the INTERNET (friends anywhere).
   Run via "Start Online Game.bat" (or: node online.js).

   What it does:
   1. Starts the poker server on a local port with a random room code required to join.
   2. Starts a free Cloudflare quick tunnel (cloudflared) that gives the server a
      public https link — no router setup, no account, and your home IP stays hidden.
   3. Prints the link + room code to share.

   Needs the free `cloudflared` tool once:  winget install Cloudflare.cloudflared */
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const PORT = Number(process.env.POKER_ONLINE_PORT) || 8767; // separate from LAN mode's 8766

// Friendly room code, e.g. "FLUSH42"
const WORDS = ['ACES', 'KINGS', 'QUEENS', 'JACKS', 'CHIPS', 'BLUFF', 'RIVER', 'FLOP', 'POKER', 'DEALER', 'FLUSH', 'RAISE'];
const ROOM_CODE = WORDS[crypto.randomInt(WORDS.length)] + String(crypto.randomInt(10, 100));

console.log('');
console.log('  ♠ Poker Party — ONLINE mode');
console.log('  Starting the game server...');

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: Object.assign({}, process.env, {
    POKER_PORT: String(PORT),
    POKER_ROOM_CODE: ROOM_CODE,
    POKER_QUIET: '1',
  }),
  stdio: ['ignore', 'inherit', 'inherit'],
});

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  try { server.kill(); } catch (e) {}
  try { if (tunnel) tunnel.kill(); } catch (e) {}
  process.exit(code || 0);
}
server.on('exit', (code) => {
  if (!closing) {
    console.log('');
    console.log('  The game server stopped (see message above). Closing.');
    shutdown(code || 1);
  }
});

console.log('  Opening the internet tunnel (Cloudflare)...');

// Find cloudflared: PATH first, then the standard install locations.
const fs = require('node:fs');
function findCloudflared() {
  const fixed = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  for (const p of fixed) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return 'cloudflared'; // hope it's on PATH
}

let tunnel;
try {
  tunnel = spawn(findCloudflared(), ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  tunnelMissing();
}

function tunnelMissing() {
  console.log('');
  console.log('  ⚠  Could not start "cloudflared" — the free tunnel tool is not installed.');
  console.log('  Install it once by running this in a terminal:');
  console.log('');
  console.log('      winget install Cloudflare.cloudflared');
  console.log('');
  console.log('  ...then run Start Online Game again.');
  shutdown(1);
}

let announced = false;
let sawOutput = false;
function watch(stream) {
  let buf = '';
  stream.on('data', (d) => {
    sawOutput = true;
    buf += d.toString();
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !announced) {
      announced = true;
      const url = m[0];
      console.log('');
      console.log('  ═══════════════════════════════════════════════════');
      console.log('');
      console.log('   🌍 Your game is LIVE on the internet!');
      console.log('');
      console.log('   Send friends this link (works anywhere, any device):');
      console.log('');
      console.log('       ' + url);
      console.log('');
      console.log('   Room code (they\'ll need it to sit down):');
      console.log('');
      console.log('       ' + ROOM_CODE);
      console.log('');
      console.log('  ═══════════════════════════════════════════════════');
      console.log('');
      console.log('   You play at the same link — open it in your browser.');
      console.log('   (Or use http://localhost:' + PORT + ' on this computer.)');
      console.log('');
      console.log('   Keep this window open while playing.');
      console.log('   Close it (or press Ctrl+C) to end the game.');
      console.log('');
      // open the host's browser at the local address
      spawn('cmd', ['/c', 'start', '', 'http://localhost:' + PORT], { stdio: 'ignore', detached: true });
    }
    if (buf.length > 65536) buf = buf.slice(-8192);
  });
}

if (tunnel) {
  tunnel.on('error', tunnelMissing);
  watch(tunnel.stdout);
  watch(tunnel.stderr);
  tunnel.on('exit', (code) => {
    if (!closing) {
      console.log('');
      console.log('  ⚠  The internet tunnel closed' + (announced ? ' — friends can no longer connect.' : ' before it produced a link.'));
      if (!announced) console.log('  (Check your internet connection and try again.)');
      shutdown(1);
    }
  });
  setTimeout(() => {
    if (!announced && !closing) {
      console.log('  Still waiting for the tunnel link... (slow connection or Cloudflare hiccup)');
    }
  }, 15000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
