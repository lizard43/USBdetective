#!/usr/bin/env node
/*
  usbdetective.js - USB topology TUI for Linux Mint

  No npm dependencies. Uses lsusb, udevadm, lsblk, dmesg, and optional v4l2-ctl.

  Keys:
    Up/Down or j/k     Select device
    PgUp/PgDn          Scroll details
    [ / ]              Previous/next detail tab
    1..6               Select detail tab
    r                  Refresh now
    q or Ctrl-C        Quit

  Mouse:
    Click left pane rows to select
    Wheel scrolls details

  Env:
    USB_DETECTIVE_POLL_MS=1000
    USB_DETECTIVE_COLOR=0
    USB_DETECTIVE_KEEP_REMOVED_MS=4500
    USB_DETECTIVE_HIGHLIGHT_MS=5000
*/

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLL_MS = Number(process.env.USB_DETECTIVE_POLL_MS || 1000);
const KEEP_REMOVED_MS = Number(process.env.USB_DETECTIVE_KEEP_REMOVED_MS || 4500);
const HIGHLIGHT_MS = Number(process.env.USB_DETECTIVE_HIGHLIGHT_MS || 5000);
const USE_COLOR = process.env.USB_DETECTIVE_COLOR !== '0' && process.stdout.isTTY;

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', rev:'\x1b[7m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', cyan:'\x1b[36m', white:'\x1b[37m',
  bgBlue:'\x1b[44m', bgRed:'\x1b[41m', bgGreen:'\x1b[42m', black:'\x1b[30m'
};
function color(code, s) { return USE_COLOR ? code + s + C.reset : s; }
function bold(s) { return color(C.bold, s); }
function green(s) { return color(C.green + C.bold, s); }
function red(s) { return color(C.red + C.bold, s); }
function yellow(s) { return color(C.yellow + C.bold, s); }
function cyan(s) { return color(C.cyan + C.bold, s); }
function selected(s) { return USE_COLOR ? C.bgBlue + C.white + C.bold + s + C.reset : '>' + s.slice(1); }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); }
function visLen(s) { return stripAnsi(s).length; }
function pad(s, width) { const n = visLen(s); return n >= width ? trunc(s, width) : s + ' '.repeat(width - n); }
function trunc(s, width) {
  const raw = stripAnsi(s);
  if (raw.length <= width) return s;
  return raw.slice(0, Math.max(0, width - 1)) + '…';
}
function rightPadRaw(s, width) { s = String(s || ''); return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length); }
function shellQuote(s) { return `'${String(s).replace(/'/g, `'"'"'`)}'`; }

function run(cmd, args = [], opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      timeout: opts.timeout || 4000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
      shell: false
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), error: err ? String(err.message || err) : '' });
    });
  });
}
async function sh(command, opts = {}) { return run('bash', ['-lc', command], opts); }

let state = {
  devices: [], rows: [], selectedKey: null, selectedIndex: 0, detailScroll: 0, tab: 0,
  previousKeys: new Set(), addedUntil: new Map(), removedUntil: new Map(), removedDevices: new Map(),
  lastKernel: [], status: 'Starting...', lastSignature: '', needsRender: true, polling: false,
  leftRowMap: new Map(), lastPollAt: null
};
const tabs = ['Summary', '/dev', 'Topology', 'Driver', 'Kernel', 'Raw USB'];

function parseLsusbLine(line) {
  const m = line.match(/^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/);
  if (!m) return null;
  const [, bus, dev, vid, pid, name] = m;
  return { bus, dev, vid: vid.toLowerCase(), pid: pid.toLowerCase(), name: (name || '').trim(), key: `${bus}:${dev}`, devNodes: [], links: [], props: {}, block: null, videoInfo: '', rawUsb: '', removed: false };
}
async function getLsusbDevices() {
  const r = await run('lsusb', [], { timeout: 3000 });
  return (r.stdout || '').split('\n').map(parseLsusbLine).filter(Boolean)
    .sort((a,b) => a.bus.localeCompare(b.bus) || Number(a.dev) - Number(b.dev));
}
async function getLsusbTree() {
  const r = await run('lsusb', ['-t'], { timeout: 3000, maxBuffer: 1024 * 1024 });
  return r.stdout || '';
}
async function getDmesgTail() {
  const r = await sh('dmesg --time-format=iso 2>/dev/null | tail -120', { timeout: 3000, maxBuffer: 1024 * 1024 });
  return (r.stdout || '').split('\n').filter(l => /usb|ttyUSB|ttyACM|cdc_acm|ch341|ch34|ftdi|cp210|pl2303|hid|input|video|uvc|storage|scsi|sd[a-z]|disconnect/i.test(l)).slice(-60);
}
async function getDevCandidates() {
  const cmd = `for p in /dev/ttyUSB* /dev/ttyACM* /dev/video* /dev/hidraw* /dev/sd* /dev/nvme* /dev/input/event*; do [ -e "$p" ] && echo "$p"; done | sort -V`;
  const r = await sh(cmd, { timeout: 3000, maxBuffer: 1024 * 1024 });
  return (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}
async function udevProps(devPath) {
  const r = await run('udevadm', ['info', '--query=property', '--name', devPath], { timeout: 3000, maxBuffer: 512 * 1024 });
  const props = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}
async function symlinkMatches(devPath) {
  const real = await fs.promises.realpath(devPath).catch(() => devPath);
  const dirs = ['/dev/serial/by-id','/dev/serial/by-path','/dev/disk/by-id','/dev/disk/by-label','/dev/disk/by-uuid','/dev/v4l/by-id','/dev/v4l/by-path'];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const name of names) {
      const link = path.join(dir, name);
      try {
        const target = await fs.promises.realpath(link);
        if (target === real) out.push(`${link} -> ${await fs.promises.readlink(link)}`);
      } catch {}
    }
  }
  return out.sort();
}
async function lsLong(devPath) {
  const r = await run('ls', ['-l', devPath], { timeout: 2000 });
  return r.stdout || '';
}
async function getLsblkJson() {
  const r = await run('lsblk', ['-J','-o','NAME,KNAME,PATH,TYPE,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN,RM,MOUNTPOINTS'], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}
function flattenBlock(tree, arr = []) {
  for (const d of tree.blockdevices || []) walkBlock(d, arr);
  return arr;
}
function walkBlock(d, arr) { arr.push(d); for (const c of d.children || []) walkBlock(c, arr); }
function busDevFromProps(props) {
  let bus = props.BUSNUM || props.ID_BUSNUM || '';
  let dev = props.DEVNUM || props.ID_DEVNUM || '';
  if (bus && dev) return `${String(bus).padStart(3,'0')}:${String(dev).padStart(3,'0')}`;
  return '';
}
function vidPidFromProps(props) {
  const vid = (props.ID_VENDOR_ID || '').toLowerCase();
  const pid = (props.ID_MODEL_ID || '').toLowerCase();
  return vid && pid ? `${vid}:${pid}` : '';
}
function classifyDevNode(devPath, props) {
  const base = path.basename(devPath);
  if (/^ttyUSB\d+$/.test(base)) return 'USB serial adapter';
  if (/^ttyACM\d+$/.test(base)) return 'CDC/ACM serial device';
  if (/^video\d+$/.test(base)) return 'Video/camera node';
  if (/^hidraw\d+$/.test(base)) return 'HID raw node';
  if (/^event\d+$/.test(base)) return 'Input event node';
  if (/^sd[a-z]\d*$/.test(base) || /^nvme\d+n\d+(p\d+)?$/.test(base)) return 'Storage/block node';
  if (props.ID_INPUT) return 'Input/HID node';
  return 'Device node';
}
function interfaceLabel(props) {
  const n = props.ID_USB_INTERFACE_NUM;
  if (n === '00') return 'Channel A / interface 0';
  if (n === '01') return 'Channel B / interface 1';
  if (n === '02') return 'Channel C / interface 2';
  if (n === '03') return 'Channel D / interface 3';
  const m = String(props.DEVPATH || '').match(/:(\d+)\.(\d+)(?:\/|$)/);
  return m ? `USB config ${m[1]} interface ${m[2]}` : '';
}
async function enrichDevice(dev, allNodes, blockMap) {
  const matches = [];
  for (const node of allNodes) {
    const props = await udevProps(node);
    const bd = busDevFromProps(props);
    const vp = vidPidFromProps(props);
    if (bd === dev.key || (!bd && vp === `${dev.vid}:${dev.pid}`) || (vp === `${dev.vid}:${dev.pid}` && path.basename(node).match(/^(ttyUSB|ttyACM|video|hidraw|event|sd|nvme)/))) {
      matches.push({ path: node, props, type: classifyDevNode(node, props), iface: interfaceLabel(props), links: await symlinkMatches(node), stat: await lsLong(node) });
    }
  }
  // Fallback: some tty nodes do not expose BUSNUM/DEVNUM, but do expose matching VID/PID.
  if (!matches.length) {
    for (const node of allNodes) {
      const props = await udevProps(node);
      if (vidPidFromProps(props) === `${dev.vid}:${dev.pid}`) {
        matches.push({ path: node, props, type: classifyDevNode(node, props), iface: interfaceLabel(props), links: await symlinkMatches(node), stat: await lsLong(node) });
      }
    }
  }
  dev.devNodes = matches;
  for (const m of matches) {
    const b = blockMap.get(m.path);
    if (b) m.block = b;
  }
  return dev;
}
async function collectSnapshot() {
  const [devices, tree, devNodes, lsblk, kernel] = await Promise.all([getLsusbDevices(), getLsusbTree(), getDevCandidates(), getLsblkJson(), getDmesgTail()]);
  const blockMap = new Map(flattenBlock(lsblk).filter(d => d.path).map(d => [d.path, d]));
  for (const d of devices) await enrichDevice(d, devNodes, blockMap);
  return { devices, tree, kernel, when: new Date() };
}
function updateHighlights(newDevices) {
  const now = Date.now();
  const newKeys = new Set(newDevices.map(d => d.key));
  for (const d of newDevices) {
    if (!state.previousKeys.has(d.key) && state.previousKeys.size) state.addedUntil.set(d.key, now + HIGHLIGHT_MS);
  }
  for (const oldKey of state.previousKeys) {
    if (!newKeys.has(oldKey)) {
      const old = state.devices.find(d => d.key === oldKey) || state.removedDevices.get(oldKey);
      if (old) {
        const copy = { ...old, removed: true, removedAt: now, devNodes: old.devNodes || [] };
        state.removedDevices.set(oldKey, copy);
        state.removedUntil.set(oldKey, now + KEEP_REMOVED_MS);
      }
    }
  }
  for (const [k, t] of [...state.addedUntil]) if (t <= now) state.addedUntil.delete(k);
  for (const [k, t] of [...state.removedUntil]) if (t <= now) { state.removedUntil.delete(k); state.removedDevices.delete(k); }
  state.previousKeys = newKeys;
}
function mergedDevices(devices) {
  const out = [...devices];
  for (const [k, d] of state.removedDevices) if (!devices.some(x => x.key === k)) out.push(d);
  return out.sort((a,b) => a.bus.localeCompare(b.bus) || Number(a.dev) - Number(b.dev));
}
function signature(snap) {
  return JSON.stringify({ d: snap.devices.map(d => [d.key, d.vid, d.pid, d.name, d.devNodes.map(n => n.path).sort()]), r: [...state.removedDevices.keys()].sort(), tab: state.tab, sel: state.selectedKey, scroll: state.detailScroll, size: termSize() });
}
async function poll(force = false) {
  if (state.polling) return;
  state.polling = true;
  try {
    const snap = await collectSnapshot();
    updateHighlights(snap.devices);
    state.devices = mergedDevices(snap.devices);
    state.tree = snap.tree;
    state.lastKernel = snap.kernel;
    state.lastPollAt = snap.when;
    if (!state.selectedKey || !state.devices.some(d => d.key === state.selectedKey)) {
      state.selectedKey = state.devices[0] ? state.devices[0].key : null;
      state.selectedIndex = 0;
      state.detailScroll = 0;
    } else {
      state.selectedIndex = Math.max(0, state.devices.findIndex(d => d.key === state.selectedKey));
    }
    state.status = `Updated ${snap.when.toLocaleTimeString()}  |  ${snap.devices.length} active USB devices`;
    const sig = signature(snap);
    if (force || sig !== state.lastSignature) { state.lastSignature = sig; render(); }
  } catch (e) {
    state.status = `Error: ${e.message || e}`;
    render();
  } finally { state.polling = false; }
}
function selectedDevice() { return state.devices.find(d => d.key === state.selectedKey) || state.devices[0] || null; }
function deviceLabel(d) {
  const devs = (d.devNodes || []).map(n => n.path.replace('/dev/', '')).sort();
  const name = d.name || '(unnamed USB device)';
  const devText = devs.length ? `  /dev: ${devs.join(', ')}` : '';
  return `${d.key} ${d.vid}:${d.pid} ${name}${devText}`;
}
function buildRows() {
  const rows = [];
  const buses = [...new Set(state.devices.map(d => d.bus))].sort();
  for (const bus of buses) {
    rows.push({ type:'bus', key:`bus:${bus}`, text:`USB Bus ${bus}`, selectable:false });
    const list = state.devices.filter(d => d.bus === bus).sort((a,b) => Number(a.dev) - Number(b.dev));
    list.forEach((d, i) => {
      const branch = i === list.length - 1 ? '└─' : '├─';
      rows.push({ type:'dev', key:d.key, device:d, text:`${branch} ${deviceLabel(d)}`, selectable:true });
      const nodes = (d.devNodes || []).map(n => n.path).sort();
      nodes.forEach((n, j) => rows.push({ type:'node', key:`${d.key}:${n}`, parentKey:d.key, text:`${i === list.length - 1 ? '   ' : '│  '} ${j === nodes.length - 1 ? '└' : '├'} /dev/${path.basename(n)}`, selectable:false }));
    });
  }
  return rows;
}
function detailLines(d) {
  if (!d) return ['No USB devices found.'];
  const lines = [];
  const activeNodes = d.devNodes || [];
  const header = `${d.key}  ${d.vid}:${d.pid}  ${d.name || '(unnamed)'}`;
  if (state.tab === 0) {
    lines.push(bold(header), '');
    lines.push(`Status: ${d.removed ? red('recently unplugged') : 'active'}`);
    lines.push(`Bus: ${d.bus}`);
    lines.push(`Device number: ${d.dev}`);
    lines.push(`Vendor/Product ID: ${d.vid}:${d.pid}`);
    lines.push(`Name: ${d.name || ''}`);
    lines.push('');
    lines.push(bold('Detected /dev handles'));
    if (activeNodes.length) for (const n of activeNodes) lines.push(`  ${n.path}  ${n.iface ? '(' + n.iface + ')' : ''}  ${n.type}`);
    else lines.push('  None found. Root hubs and some internal devices may not create user-facing /dev nodes.');
    lines.push('');
    lines.push(bold('Likely next step'));
    lines.push(...suggestions(d));
  } else if (state.tab === 1) {
    lines.push(bold('/dev nodes and stable names'), '');
    if (!activeNodes.length) lines.push('No matching /dev nodes discovered for this USB device.');
    for (const n of activeNodes) {
      lines.push(bold(n.path));
      lines.push(`  Type: ${n.type}`);
      if (n.iface) lines.push(`  Interface: ${n.iface}`);
      if (n.stat) lines.push(`  Node: ${n.stat}`);
      const best = n.links.find(l => l.startsWith('/dev/serial/by-id/')) || n.links.find(l => l.startsWith('/dev/v4l/by-id/')) || n.links.find(l => l.startsWith('/dev/disk/by-id/')) || n.links[0];
      if (best) lines.push(`  Best stable name: ${best.split(' -> ')[0]}`);
      if (n.links.length) { lines.push('  Symlinks:'); for (const l of n.links) lines.push(`    ${l}`); }
      if (n.block) lines.push(`  Block: ${n.block.type || ''} ${n.block.size || ''} ${n.block.fstype || ''} ${n.block.label || ''} ${(n.block.mountpoints || []).filter(Boolean).join(',')}`);
      lines.push('');
    }
  } else if (state.tab === 2) {
    lines.push(bold('USB topology from lsusb -t'), '');
    lines.push(...(state.tree || '').split('\n'));
  } else if (state.tab === 3) {
    lines.push(bold('Driver / udev properties'), '');
    if (!activeNodes.length) lines.push('No /dev-backed udev properties found for this device.');
    for (const n of activeNodes) {
      lines.push(bold(n.path));
      const keys = ['SUBSYSTEM','DEVTYPE','ID_BUS','ID_USB_DRIVER','DRIVER','ID_VENDOR','ID_VENDOR_FROM_DATABASE','ID_VENDOR_ID','ID_MODEL','ID_MODEL_FROM_DATABASE','ID_MODEL_ID','ID_SERIAL','ID_SERIAL_SHORT','ID_USB_INTERFACE_NUM','ID_PATH','DEVPATH','TAGS'];
      for (const k of keys) if (n.props[k]) lines.push(`  ${rightPadRaw(k, 24)} ${n.props[k]}`);
      lines.push('');
    }
  } else if (state.tab === 4) {
    lines.push(bold('Recent relevant kernel clues'), '');
    const relevant = state.lastKernel.filter(l => l.includes(`${Number(d.bus)}-`) || l.toLowerCase().includes((d.name || '').split(' ')[0]?.toLowerCase() || '___') || /usb|ttyUSB|ttyACM|disconnect|attached/i.test(l)).slice(-50);
    if (!relevant.length) lines.push('No recent matching kernel lines in dmesg tail.');
    else lines.push(...relevant);
  } else if (state.tab === 5) {
    lines.push(bold(`Raw USB descriptor excerpt: lsusb -v -s ${Number(d.bus)}:${Number(d.dev)}`), '');
    lines.push('Press r to refresh. This tab loads on demand in the next version; current useful raw command:');
    lines.push(`  lsusb -v -s ${Number(d.bus)}:${Number(d.dev)}`);
    lines.push('');
    lines.push('Basic identity:');
    lines.push(`  Bus ${d.bus} Device ${d.dev}: ID ${d.vid}:${d.pid} ${d.name}`);
  }
  return lines;
}
function suggestions(d) {
  const lines = [];
  const nodes = d.devNodes || [];
  if (nodes.some(n => /ttyUSB|ttyACM/.test(n.path))) {
    lines.push('  Serial device: prefer /dev/serial/by-id when available.');
    lines.push('  If permission denied, check groups: groups $USER; usually dialout/plugdev matters.');
    const serials = nodes.filter(n => /ttyUSB|ttyACM/.test(n.path));
    if (serials.length > 1) lines.push('  Multi-port serial: interface 00 usually Channel A, 01 usually Channel B.');
  } else if (nodes.some(n => /video\d+$/.test(n.path))) {
    lines.push('  Camera/capture device: install v4l-utils, then inspect formats with v4l2-ctl --list-formats-ext.');
  } else if (nodes.some(n => /sd[a-z]|nvme/.test(n.path))) {
    lines.push('  Storage device: inspect filesystem/mount with lsblk -f.');
  } else if (/root hub/i.test(d.name)) {
    lines.push('  Root hub: parent controller for devices on this USB bus. It normally has no useful /dev handle.');
  } else {
    lines.push('  Check Driver tab for udev details and Topology tab for hub/port placement.');
  }
  return lines;
}
function render() {
  const { cols, rows: termRows } = termSize();
  const leftW = Math.max(42, Math.min(72, Math.floor(cols * 0.45)));
  const rightW = Math.max(20, cols - leftW - 3);
  const height = Math.max(10, termRows - 4);
  const rows = buildRows();
  state.rows = rows;
  state.leftRowMap.clear();
  let out = '\x1b[?25l\x1b[H';
  out += pad(cyan('USB Detective'), cols) + '\n';
  out += pad(`Tree: ↑/↓ select  [/] tabs  PgUp/PgDn scroll  r refresh  q quit`, cols) + '\n';
  out += '─'.repeat(cols) + '\n';
  const d = selectedDevice();
  const details = detailLines(d);
  const tabLine = tabs.map((t,i) => i === state.tab ? `[${t}]` : ` ${t} `).join('  ');
  const detailHead = `${tabLine}`;
  const detailBody = [detailHead, '─'.repeat(rightW), ...details].slice(state.detailScroll, state.detailScroll + height);
  for (let i = 0; i < height; i++) {
    const leftRaw = rows[i] ? rowText(rows[i], i) : '';
    if (rows[i] && rows[i].selectable) state.leftRowMap.set(i + 4, rows[i].key);
    const left = pad(leftRaw, leftW);
    const sep = ' │ ';
    const right = pad(detailBody[i] || '', rightW);
    out += left + sep + right + '\n';
  }
  out += '─'.repeat(cols) + '\n';
  out += pad(state.status || '', cols) + '\x1b[J';
  process.stdout.write(out);
}
function rowText(row) {
  if (row.type === 'bus') return bold(row.text);
  if (row.type === 'node') return row.text;
  const isSel = row.key === state.selectedKey;
  const isNew = state.addedUntil.has(row.key);
  const isRemoved = row.device && row.device.removed;
  let txt = row.text;
  if (isRemoved) txt = red(txt);
  else if (isNew) txt = green(txt);
  if (isSel) txt = selected(txt);
  return txt;
}
function termSize() { return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }; }
function selectDelta(delta) {
  const selectable = state.rows.filter(r => r.selectable);
  if (!selectable.length) return;
  let idx = selectable.findIndex(r => r.key === state.selectedKey);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(selectable.length - 1, idx + delta));
  state.selectedKey = selectable[idx].key;
  state.selectedIndex = idx;
  state.detailScroll = 0;
  render();
}
function setTab(t) { state.tab = Math.max(0, Math.min(tabs.length - 1, t)); state.detailScroll = 0; render(); }
function scrollDetail(delta) { state.detailScroll = Math.max(0, state.detailScroll + delta); render(); }
function cleanup() {
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[0m\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
function handleInput(buf) {
  const s = buf.toString('utf8');
  if (s === '\u0003' || s === 'q') { cleanup(); process.exit(0); }
  if (s === 'r') { poll(true); return; }
  if (s === 'j' || s === '\x1b[B') { selectDelta(1); return; }
  if (s === 'k' || s === '\x1b[A') { selectDelta(-1); return; }
  if (s === '\x1b[6~') { scrollDetail(10); return; }
  if (s === '\x1b[5~') { scrollDetail(-10); return; }
  if (s === ']') { setTab(state.tab + 1); return; }
  if (s === '[') { setTab(state.tab - 1); return; }
  if (/^[1-6]$/.test(s)) { setTab(Number(s) - 1); return; }
  const mouse = s.match(/\x1b\[<([0-9]+);([0-9]+);([0-9]+)([mM])/);
  if (mouse) {
    const code = Number(mouse[1]), x = Number(mouse[2]), y = Number(mouse[3]), up = mouse[4] === 'm';
    if (!up && code === 64) return scrollDetail(-3);
    if (!up && code === 65) return scrollDetail(3);
    if (!up && x <= Math.max(42, Math.min(72, Math.floor((process.stdout.columns || 120) * 0.45)))) {
      const key = state.leftRowMap.get(y);
      if (key) { state.selectedKey = key; state.detailScroll = 0; render(); }
    }
  }
}
async function main() {
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleInput);
    process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J');
  }
  await poll(true);
  setInterval(() => poll(false), POLL_MS);
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [k,t] of [...state.addedUntil]) if (t <= now) { state.addedUntil.delete(k); changed = true; }
    for (const [k,t] of [...state.removedUntil]) if (t <= now) { state.removedUntil.delete(k); state.removedDevices.delete(k); changed = true; }
    if (changed) render();
  }, 500);
}
main().catch(e => { cleanup(); console.error(e); process.exit(1); });
