#!/usr/bin/env node
/*
  usbdetective.js - file-explorer style USB detective TUI for Linux

  Design reset:
    - No incident history dump.
    - Polls current USB state and renders a two-pane explorer.
    - Left pane lists USB bus devices plus matching /dev nodes.
    - Right pane shows details for the selected device.
    - New devices are highlighted briefly.
    - Keyboard and basic mouse click selection.

  Keys:
    up/down or j/k  select device
    pageup/pagedown scroll device list
    r               refresh now
    d               toggle raw details
    m               toggle kernel clues
    q or Ctrl-C     quit

  Env:
    USB_DETECTIVE_POLL_MS=1500
    USB_DETECTIVE_COLOR=0
*/

const { execFile } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const POLL_MS = Math.max(500, Number(process.env.USB_DETECTIVE_POLL_MS || 1500));
const USE_COLOR = process.env.USB_DETECTIVE_COLOR !== '0' && process.stdout.isTTY;
const NEW_MS = 6000;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', rev: '\x1b[7m',
  black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgWhite: '\x1b[47m', bgCyan: '\x1b[46m'
};
const cc = (name, s) => USE_COLOR ? `${C[name] || ''}${s}${C.reset}` : s;
const bold = s => cc('bold', s);
const cyan = s => cc('cyan', s);
const green = s => cc('green', s);
const yellow = s => cc('yellow', s);
const selected = s => USE_COLOR ? `${C.black}${C.bgWhite}${s}${C.reset}` : `> ${s}`;

let state = {
  devices: [],
  selectedIndex: 0,
  leftScroll: 0,
  rightScroll: 0,
  showRaw: false,
  showKernel: true,
  lastScan: '',
  status: 'Starting...',
  previousKeys: new Set(),
  newUntil: new Map(),
};

let rendering = false;
let lastFrame = '';
let pollBusy = false;
let pollTimer = null;

function run(cmd, args = [], opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      timeout: opts.timeout || 5000,
      maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
      shell: false,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: err ? String(err.message || err) : '',
      });
    });
  });
}
function sh(command, opts = {}) { return run('bash', ['-lc', command], opts); }
function shellQuote(s) { return `'${String(s).replace(/'/g, `'"'"'`)}'`; }

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
function visibleLen(s) { return stripAnsi(s).length; }
function padAnsi(s, width) {
  const len = visibleLen(s);
  if (len >= width) return truncAnsi(s, width);
  return s + ' '.repeat(width - len);
}
function truncAnsi(s, width) {
  const plain = stripAnsi(s);
  if (plain.length <= width) return s;
  if (width <= 1) return plain.slice(0, width);
  return plain.slice(0, width - 1) + '…';
}
function cleanUsbString(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseLsusbLine(line) {
  const m = line.match(/^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/);
  if (!m) return null;
  return {
    bus: m[1], devnum: m[2], vid: m[3].toLowerCase(), pid: m[4].toLowerCase(), desc: (m[5] || '').trim(),
    busNode: `/dev/bus/usb/${m[1]}/${m[2]}`,
  };
}

async function getUsbBusDevices() {
  const r = await run('lsusb');
  return (r.stdout || '').split('\n').map(parseLsusbLine).filter(Boolean);
}

async function getUdevProps(devPath) {
  if (!devPath || !fs.existsSync(devPath)) return {};
  const r = await run('udevadm', ['info', '--query=property', '--name', devPath], { timeout: 4000, maxBuffer: 1024 * 1024 });
  const props = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}

async function getDevCandidates() {
  const cmd = `
    for p in /dev/ttyUSB* /dev/ttyACM* /dev/video* /dev/hidraw* /dev/input/event* /dev/sd* /dev/nvme* /dev/bus/usb/*/*; do
      [ -e "$p" ] && printf '%s\n' "$p"
    done | sort -u
  `;
  const r = await sh(cmd, { timeout: 4000 });
  return (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}

async function getSymlinks() {
  const cmd = `
    for d in /dev/serial/by-id /dev/serial/by-path /dev/v4l/by-id /dev/v4l/by-path /dev/disk/by-id /dev/disk/by-label /dev/disk/by-uuid; do
      [ -d "$d" ] || continue
      find "$d" -maxdepth 1 -type l -printf '%p -> %l\n' 2>/dev/null
    done
  `;
  const r = await sh(cmd, { timeout: 4000, maxBuffer: 1024 * 1024 });
  const rows = [];
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf(' -> ');
    if (i < 0) continue;
    const link = line.slice(0, i);
    try { rows.push({ link, real: fs.realpathSync(link), text: line }); } catch {}
  }
  return rows;
}

async function getLsusbTree() {
  const r = await run('lsusb', ['-t'], { timeout: 4000 });
  return r.stdout || '';
}

async function getDmesgRecent() {
  const r = await sh('dmesg --time-format=iso 2>/dev/null | tail -120', { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  return (r.stdout || '').split('\n').filter(Boolean);
}

function devKind(devPath, props = {}) {
  const b = path.basename(devPath);
  if (/^ttyUSB\d+$/.test(b)) return 'serial';
  if (/^ttyACM\d+$/.test(b)) return 'cdc-acm';
  if (/^video\d+$/.test(b)) return 'video';
  if (/^hidraw\d+$/.test(b)) return 'hidraw';
  if (/^event\d+$/.test(b)) return 'input';
  if (/^sd[a-z]\d*$/.test(b) || /^nvme/.test(b)) return 'storage';
  if (devPath.startsWith('/dev/bus/usb/')) return 'usb-bus';
  return props.SUBSYSTEM || 'dev';
}

function interfaceLabel(props = {}) {
  const n = props.ID_USB_INTERFACE_NUM;
  if (n === '00') return 'A/if00';
  if (n === '01') return 'B/if01';
  if (n === '02') return 'C/if02';
  if (n === '03') return 'D/if03';
  const m = String(props.DEVPATH || '').match(/:(\d+)\.(\d+)(?:\/|$)/);
  if (m) return `if${m[2]}`;
  return '';
}

function matchesUsbDevice(usb, props, devPath) {
  const vid = String(props.ID_VENDOR_ID || '').toLowerCase();
  const pid = String(props.ID_MODEL_ID || '').toLowerCase();
  if (vid === usb.vid && pid === usb.pid) {
    // Prefer exact bus node for /dev/bus; for tty/video udev generally has matching VID:PID.
    return true;
  }
  if (devPath === usb.busNode) return true;
  return false;
}

async function buildModel() {
  const [usbList, devPaths, syms, tree, dmesg] = await Promise.all([
    getUsbBusDevices(), getDevCandidates(), getSymlinks(), getLsusbTree(), getDmesgRecent()
  ]);

  const devObjs = [];
  for (const p of devPaths) {
    const props = await getUdevProps(p);
    const links = syms.filter(s => s.real === p).map(s => s.link);
    devObjs.push({ path: p, props, links, kind: devKind(p, props), iface: interfaceLabel(props) });
  }

  const devices = usbList.map(usb => {
    const matches = devObjs.filter(d => matchesUsbDevice(usb, d.props, d.path));
    const busDev = devObjs.find(d => d.path === usb.busNode) || { path: usb.busNode, props: {}, links: [], kind: 'usb-bus', iface: '' };
    if (!matches.find(d => d.path === usb.busNode) && fs.existsSync(usb.busNode)) matches.unshift(busDev);
    const bestProps = matches.find(d => d.props.ID_MODEL || d.props.ID_VENDOR || d.props.ID_MODEL_FROM_DATABASE) || busDev;
    const props = bestProps.props || {};
    const vendor = cleanUsbString(props.ID_VENDOR_FROM_DATABASE || props.ID_VENDOR || usb.desc.split(/\s{2,}/)[0] || '');
    const model = cleanUsbString(props.ID_MODEL_FROM_DATABASE || props.ID_MODEL || usb.desc || 'USB device');
    const name = cleanUsbString(usb.desc || `${vendor} ${model}` || `${usb.vid}:${usb.pid}`);
    return {
      key: `${usb.bus}:${usb.devnum}:${usb.vid}:${usb.pid}`,
      usb, name, vendor, model, props,
      devs: matches.sort((a, b) => a.path.localeCompare(b.path)),
      tree, dmesg,
    };
  });

  return devices;
}

function majorDevNames(devs) {
  const useful = devs
    .map(d => path.basename(d.path))
    .filter(b => /^(ttyUSB|ttyACM|video|hidraw|event|sd|nvme)/.test(b));
  return [...new Set(useful)].join(', ');
}

function listLine(dev, width, idx, selectedIdx) {
  const isNew = state.newUntil.get(dev.key) && Date.now() < state.newUntil.get(dev.key);
  const devNames = majorDevNames(dev.devs);
  let first = `${idx === selectedIdx ? '▶' : ' '} ${dev.usb.bus}:${dev.usb.devnum} ${dev.usb.vid}:${dev.usb.pid}`;
  if (devNames) first += `  /dev: ${devNames}`;
  if (isNew) first += '  NEW';
  let second = `   ${dev.name}`;
  if (isNew) { first = green(bold(first)); second = green(bold(second)); }
  if (idx === selectedIdx) first = selected(padAnsi(first, width));
  return [padAnsi(first, width), padAnsi(second, width)];
}

function detailLines(dev, width) {
  if (!dev) return ['No USB devices found.'];
  const lines = [];
  const add = s => lines.push(truncAnsi(s, width));
  const kv = (k, v) => { if (v) add(`${bold(k.padEnd(13))} ${v}`); };
  const props = dev.props || {};

  add(bold(dev.name));
  add(`${cyan('USB')} Bus ${dev.usb.bus} Device ${dev.usb.devnum}  ID ${dev.usb.vid}:${dev.usb.pid}`);
  add('');
  add(bold('Summary'));
  kv('Vendor', cleanUsbString(props.ID_VENDOR_FROM_DATABASE || props.ID_VENDOR || dev.vendor));
  kv('Model', cleanUsbString(props.ID_MODEL_FROM_DATABASE || props.ID_MODEL || dev.model));
  kv('Serial', props.ID_SERIAL_SHORT || props.ID_SERIAL);
  kv('Driver', props.ID_USB_DRIVER || props.DRIVER || 'usb');
  kv('Subsystem', props.SUBSYSTEM || 'usb');
  kv('USB path', props.ID_PATH);
  kv('Bus node', dev.usb.busNode);

  add('');
  add(bold(`Matching /dev nodes (${dev.devs.length})`));
  if (!dev.devs.length) add('No matching /dev nodes. This may be a hub, receiver, keyboard, or raw USB-only device.');
  for (const d of dev.devs) {
    const iface = d.iface ? ` (${d.iface})` : '';
    add(`${green('●')} ${bold(d.path)}${iface}`);
    add(`   type     ${d.kind}`);
    if (d.props.ID_USB_DRIVER || d.props.DRIVER) add(`   driver   ${d.props.ID_USB_DRIVER || d.props.DRIVER}`);
    if (d.props.ID_SERIAL_SHORT || d.props.ID_SERIAL) add(`   serial   ${d.props.ID_SERIAL_SHORT || d.props.ID_SERIAL}`);
    if (d.links.length) add(`   symlink  ${d.links[0]}`);
  }

  add('');
  add(bold('Practical handles'));
  const serial = dev.devs.filter(d => /^\/dev\/tty(USB|ACM)\d+$/.test(d.path));
  const video = dev.devs.filter(d => /^\/dev\/video\d+$/.test(d.path));
  const storage = dev.devs.filter(d => /^\/dev\/(sd[a-z]|nvme)/.test(d.path));
  if (serial.length) {
    for (const d of serial) add(`serial   ${d.links.find(l => l.includes('/by-id/')) || d.path}`);
  }
  if (video.length) {
    for (const d of video) add(`camera   ${d.links.find(l => l.includes('/by-id/')) || d.path}`);
  }
  if (storage.length) {
    for (const d of storage) add(`storage  ${d.path}`);
  }
  if (!serial.length && !video.length && !storage.length) add('No serial/video/storage handles. Use bus node or inspect HID/input nodes if present.');

  if (state.showKernel) {
    add('');
    add(bold('Kernel clues'));
    const terms = [dev.usb.vid, dev.usb.pid, dev.usb.devnum.replace(/^0+/, ''), props.ID_SERIAL_SHORT, props.ID_MODEL, props.ID_VENDOR]
      .filter(Boolean).map(s => String(s).replace(/_/g, ' '));
    const clue = dev.dmesg.filter(l => terms.some(t => t && l.toLowerCase().includes(t.toLowerCase())) ||
      (props.ID_PATH && l.includes(props.ID_PATH.split('-usb-').pop()?.split(':')[0] || '---'))).slice(-16);
    if (clue.length) clue.forEach(add); else add('No recent matching kernel clues.');
  }

  if (state.showRaw) {
    add('');
    add(bold('Raw udev properties'));
    Object.keys(props).sort().forEach(k => add(`${k}=${props[k]}`));
    add('');
    add(bold('lsusb -t'));
    dev.tree.split('\n').forEach(add);
  }
  return lines;
}

function layout() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 35;
  const leftW = Math.max(36, Math.min(58, Math.floor(cols * 0.34)));
  const rightW = Math.max(20, cols - leftW - 4);
  const bodyH = Math.max(8, rows - 4);
  return { cols, rows, leftW, rightW, bodyH };
}

function borderTop(w, title) {
  const t = ` ${title} `;
  return cyan('┌') + cyan('─'.repeat(Math.max(0, w - 2))).slice(0, Math.max(0, w - 2)) + cyan('┐');
}
function titleLine(w, title) {
  return cyan('│') + padAnsi(bold(title), w - 2) + cyan('│');
}
function midLine(left, right) { return left + ' ' + right; }
function framedContentLine(w, s) { return cyan('│') + padAnsi(s, w - 2) + cyan('│'); }
function borderBottom(w) { return cyan('└') + cyan('─'.repeat(Math.max(0, w - 2))) + cyan('┘'); }

function render(force = false) {
  if (rendering) return;
  rendering = true;
  try {
    const { cols, leftW, rightW, bodyH } = layout();
    const devs = state.devices;
    if (state.selectedIndex >= devs.length) state.selectedIndex = Math.max(0, devs.length - 1);
    if (state.selectedIndex < 0) state.selectedIndex = 0;

    const visibleDeviceRows = Math.max(1, Math.floor((bodyH - 2) / 2));
    if (state.selectedIndex < state.leftScroll) state.leftScroll = state.selectedIndex;
    if (state.selectedIndex >= state.leftScroll + visibleDeviceRows) state.leftScroll = state.selectedIndex - visibleDeviceRows + 1;

    const leftLines = [];
    for (let i = state.leftScroll; i < Math.min(devs.length, state.leftScroll + visibleDeviceRows); i++) {
      leftLines.push(...listLine(devs[i], leftW - 2, i, state.selectedIndex));
    }
    while (leftLines.length < bodyH - 2) leftLines.push('');

    const rightAll = detailLines(devs[state.selectedIndex], rightW - 2);
    if (state.rightScroll > Math.max(0, rightAll.length - (bodyH - 2))) state.rightScroll = Math.max(0, rightAll.length - (bodyH - 2));
    const rightLines = rightAll.slice(state.rightScroll, state.rightScroll + bodyH - 2);
    while (rightLines.length < bodyH - 2) rightLines.push('');

    const frame = [];
    frame.push(midLine(borderTop(leftW, ''), borderTop(rightW, '')));
    frame.push(midLine(titleLine(leftW, 'USB Devices'), titleLine(rightW, devs[state.selectedIndex]?.name || 'Details')));
    for (let i = 0; i < bodyH - 2; i++) frame.push(midLine(framedContentLine(leftW, leftLines[i]), framedContentLine(rightW, rightLines[i])));
    frame.push(midLine(borderBottom(leftW), borderBottom(rightW)));
    const status = `Refreshed (${state.status}); last scan ${state.lastScan}; devices ${devs.length}; ↑/↓/j/k select, mouse click, r refresh, d raw, m kernel, q quit`;
    frame.push(cyan('┌') + cyan('─'.repeat(cols - 2)) + cyan('┐'));
    frame.push(cyan('│') + padAnsi(status, cols - 2) + cyan('│'));
    frame.push(cyan('└') + cyan('─'.repeat(cols - 2)) + cyan('┘'));

    const out = frame.join('\n');
    if (force || out !== lastFrame) {
      process.stdout.write('\x1b[?25l\x1b[H' + out + '\x1b[J');
      lastFrame = out;
    }
  } finally {
    rendering = false;
  }
}

async function refresh(reason = 'poll') {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const oldSelectedKey = state.devices[state.selectedIndex]?.key;
    const oldKeys = new Set(state.devices.map(d => d.key));
    const devices = await buildModel();
    const now = Date.now();
    for (const d of devices) {
      if (state.previousKeys.size && !state.previousKeys.has(d.key)) state.newUntil.set(d.key, now + NEW_MS);
    }
    state.previousKeys = new Set(devices.map(d => d.key));
    state.devices = devices;
    const keepIdx = devices.findIndex(d => d.key === oldSelectedKey);
    state.selectedIndex = keepIdx >= 0 ? keepIdx : Math.min(state.selectedIndex, Math.max(0, devices.length - 1));
    state.lastScan = new Date().toLocaleTimeString();
    state.status = reason;
    render(true);
  } catch (e) {
    state.status = `error: ${e.message || e}`;
    render(true);
  } finally {
    pollBusy = false;
  }
}

function moveSelection(delta) {
  state.selectedIndex = Math.max(0, Math.min(state.devices.length - 1, state.selectedIndex + delta));
  state.rightScroll = 0;
  render(true);
}
function cleanup() {
  if (pollTimer) clearInterval(pollTimer);
  process.stdout.write('\x1b[?1000l\x1b[?25h\x1b[0m\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

function handleMouse(buf) {
  // Basic X10 mouse: ESC [ M Cb Cx Cy
  const s = buf.toString('binary');
  const idx = s.indexOf('\x1b[M');
  if (idx < 0 || s.length < idx + 6) return false;
  const x = s.charCodeAt(idx + 4) - 32;
  const y = s.charCodeAt(idx + 5) - 32;
  const { leftW, bodyH } = layout();
  if (x >= 1 && x <= leftW && y >= 3 && y < bodyH + 1) {
    const row = y - 3;
    const devRow = Math.floor(row / 2);
    const newIdx = state.leftScroll + devRow;
    if (newIdx >= 0 && newIdx < state.devices.length) {
      state.selectedIndex = newIdx;
      state.rightScroll = 0;
      render(true);
    }
    return true;
  }
  return false;
}

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('usbdetective TUI needs a real terminal.');
    process.exit(1);
  }
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  process.stdin.on('data', buf => { handleMouse(buf); });
  process.stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'c') cleanup();
    if (!key) return;
    if (key.name === 'q') cleanup();
    else if (key.name === 'up' || str === 'k') moveSelection(-1);
    else if (key.name === 'down' || str === 'j') moveSelection(1);
    else if (key.name === 'pageup') moveSelection(-10);
    else if (key.name === 'pagedown') moveSelection(10);
    else if (key.name === 'r') refresh('manual');
    else if (key.name === 'd') { state.showRaw = !state.showRaw; state.rightScroll = 0; render(true); }
    else if (key.name === 'm') { state.showKernel = !state.showKernel; state.rightScroll = 0; render(true); }
  });

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.stdout.on('resize', () => render(true));

  await refresh('initial');
  pollTimer = setInterval(() => refresh('poll'), POLL_MS);
}

main().catch(err => {
  process.stdout.write('\x1b[?1000l\x1b[?25h\x1b[0m\n');
  console.error(err);
  process.exit(1);
});
