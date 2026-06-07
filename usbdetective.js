#!/usr/bin/env node
/*
  usbdetective.js - USB topology TUI for Linux Mint

  No npm dependencies. Uses lsusb, udevadm, lsblk, dmesg, and optional v4l2-ctl.

  Keys:
    Up/Down or j/k     Select USB devices/hubs in the topology tree
    PgUp/PgDn          Scroll details
    Left/Right         Previous/next detail tab
    1..5               Select detail tab
    r                  Refresh now
    q or Ctrl-C        Quit

  Mouse:
    Disabled intentionally. Keyboard navigation is reliable and predictable.

  Left pane:
    Real USB topology from lsusb -t, enriched with lsusb names and /dev handles.

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
function dim(s) { return USE_COLOR ? '\x1b[2m' + s + C.reset : s; }
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
  devices: [], rows: [], selectedKey: null, selectedRowKey: null, selectedIndex: 0, detailScroll: 0, leftScroll: 0, tab: 0,
  previousKeys: new Set(), addedUntil: new Map(), removedUntil: new Map(), removedDevices: new Map(),
  lastKernel: [], status: 'Starting...', lastSignature: '', needsRender: true, polling: false,
  leftRowMap: new Map(), lastPollAt: null
};
const tabs = ['Summary', '/dev', 'Driver', 'Kernel', 'Raw USB'];

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
function pruneHighlights(now = Date.now()) {
  let changed = false;
  for (const [k, t] of [...state.addedUntil]) {
    if (t <= now) { state.addedUntil.delete(k); changed = true; }
  }
  for (const [k, t] of [...state.removedUntil]) {
    if (t <= now) {
      state.removedUntil.delete(k);
      state.removedDevices.delete(k);
      changed = true;
    }
  }
  return changed;
}

function isAddedKey(key) {
  const until = state.addedUntil.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    state.addedUntil.delete(key);
    return false;
  }
  return true;
}

function isRemovedDevice(d) {
  if (!d || !d.removed) return false;
  const until = state.removedUntil.get(d.key);
  if (!until) return false;
  if (until <= Date.now()) {
    state.removedUntil.delete(d.key);
    state.removedDevices.delete(d.key);
    return false;
  }
  return true;
}

function updateHighlights(newDevices) {
  const now = Date.now();
  pruneHighlights(now);
  const newKeys = new Set(newDevices.map(d => d.key));
  for (const d of newDevices) {
    if (!state.previousKeys.has(d.key) && state.previousKeys.size) {
      state.addedUntil.set(d.key, now + HIGHLIGHT_MS);
    }
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
  state.previousKeys = newKeys;
}
function mergedDevices(devices) {
  const out = [...devices];
  for (const [k, d] of state.removedDevices) if (!devices.some(x => x.key === k)) out.push(d);
  return out.sort((a,b) => a.bus.localeCompare(b.bus) || Number(a.dev) - Number(b.dev));
}
function signature(snap) {
  pruneHighlights();
  return JSON.stringify({
    d: snap.devices.map(d => [d.key, d.vid, d.pid, d.name, d.devNodes.map(n => n.path).sort()]),
    r: [...state.removedDevices.keys()].sort(),
    a: [...state.addedUntil.keys()].sort(),
    tab: state.tab,
    sel: state.selectedKey,
    row: state.selectedRowKey,
    scroll: state.detailScroll,
    leftScroll: state.leftScroll,
    size: termSize()
  });
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
      state.selectedRowKey = state.selectedKey;
      state.selectedIndex = 0;
      state.detailScroll = 0;
      state.leftScroll = 0;
    } else {
      state.selectedIndex = Math.max(0, state.devices.findIndex(d => d.key === state.selectedKey));
      if (!state.selectedRowKey || !buildRows().some(r => r.key === state.selectedRowKey || r.selectKey === state.selectedRowKey)) {
        state.selectedRowKey = state.selectedKey;
      }
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
  const name = d.name || '(unnamed USB device)';
  return `${d.key} ${d.vid}:${d.pid} ${name}`;
}

function topoSummaryForNode(t) {
  const bits = [];
  if (t.port) bits.push(`P${String(t.port).padStart(3, '0')}`);
  if (t.speed) bits.push(t.speed);
  const drivers = [...new Set((t.interfaces || []).map(i => i.driver).filter(Boolean))];
  if (drivers.length) bits.push(drivers.join('/'));
  return bits.length ? `  ${bits.join(' ')}` : '';
}

function devHandleSummary(d) {
  const count = (d.devNodes || []).length;
  if (!count) return '';
  return `  handles:${count}`;
}

function buildFallbackRows() {
  const rows = [];
  const buses = [...new Set(state.devices.map(d => d.bus))].sort();
  for (const bus of buses) {
    rows.push({ type:'bus', key:`bus:${bus}`, text:`USB Bus ${bus}`, selectable:false });
    const list = state.devices.filter(d => d.bus === bus).sort((a,b) => Number(a.dev) - Number(b.dev));
    list.forEach((d, i) => {
      const isLastDevice = i === list.length - 1;
      const branch = isLastDevice ? '└─' : '├─';
      rows.push({
        type:'dev',
        key:d.key,
        selectKey:d.key,
        device:d,
        text:`${branch} ${deviceLabel(d)}${devHandleSummary(d)}`,
        selectable:true
      });
      const nodes = (d.devNodes || []).map(n => n.path).sort();
      nodes.forEach((n, j) => rows.push({
        type:'node',
        key:`${d.key}:${n}`,
        selectKey:d.key,
        parentKey:d.key,
        device:d,
        text:`${isLastDevice ? '   ' : '│  '} ${j === nodes.length - 1 ? '└─' : '├─'} ${n}`,
        selectable:false
      }));
    });
  }
  return rows;
}

function parseTopologyLine(line, currentBus) {
  const root = line.match(/^\/:\s+Bus\s+(\d+)\.Port\s+(\d+):\s+Dev\s+(\d+),\s*(.*)$/);
  if (root) {
    const [, bus, port, dev, rest] = root;
    return {
      indent: -1,
      bus,
      dev: String(dev).padStart(3, '0'),
      key: `${bus}:${String(dev).padStart(3, '0')}`,
      port,
      rest,
      isRoot: true
    };
  }

  const child = line.match(/^(\s*)\|__\s+Port\s+(\d+):\s+Dev\s+(\d+),\s*(.*)$/);
  if (!child || !currentBus) return null;
  const [, spaces, port, dev, rest] = child;
  return {
    indent: spaces.length,
    bus: currentBus,
    dev: String(dev).padStart(3, '0'),
    key: `${currentBus}:${String(dev).padStart(3, '0')}`,
    port,
    rest,
    isRoot: false
  };
}

function parseTopoRest(rest) {
  const info = {};
  const ifMatch = String(rest || '').match(/\bIf\s+(\d+)/);
  if (ifMatch) info.iface = ifMatch[1];
  const classMatch = String(rest || '').match(/\bClass=([^,]+)/);
  if (classMatch) info.className = classMatch[1].trim();
  const driverMatch = String(rest || '').match(/\bDriver=([^,]+)/);
  if (driverMatch) info.driver = driverMatch[1].trim();
  const speedMatch = String(rest || '').match(/,\s*([^,\s]+)\s*$/);
  if (speedMatch) info.speed = speedMatch[1].trim();
  return info;
}

function mergeTopoInterface(node, parsed) {
  const info = parseTopoRest(parsed.rest);
  if (info.speed && !node.speed) node.speed = info.speed;
  if (info.className && !node.className) node.className = info.className;
  if (info.driver && !node.driver) node.driver = info.driver;
  const ifaceKey = `${info.iface ?? ''}|${info.className ?? ''}|${info.driver ?? ''}|${info.speed ?? ''}`;
  if (!node._ifaceKeys.has(ifaceKey)) {
    node._ifaceKeys.add(ifaceKey);
    node.interfaces.push(info);
  }
}

function parseLsusbTopology(treeText) {
  const roots = [];
  const stack = [];
  let currentBus = '';

  for (const line of String(treeText || '').split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseTopologyLine(line, currentBus);
    if (!parsed) continue;
    currentBus = parsed.bus;

    const node = {
      type: 'topo',
      bus: parsed.bus,
      dev: parsed.dev,
      key: parsed.key,
      port: parsed.port,
      isRoot: parsed.isRoot,
      interfaces: [],
      children: [],
      _ifaceKeys: new Set()
    };
    mergeTopoInterface(node, parsed);

    if (parsed.isRoot) {
      roots.push(node);
      stack.length = 0;
      stack.push({ indent: parsed.indent, node });
      continue;
    }

    while (stack.length && stack[stack.length - 1].indent >= parsed.indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : roots[roots.length - 1];
    if (!parent) continue;

    let existing = parent.children.find(c => c.key === node.key && c.port === node.port);
    if (existing) {
      mergeTopoInterface(existing, parsed);
      stack.push({ indent: parsed.indent, node: existing });
    } else {
      parent.children.push(node);
      stack.push({ indent: parsed.indent, node });
    }
  }

  function cleanup(n) {
    delete n._ifaceKeys;
    for (const c of n.children) cleanup(c);
  }
  for (const r of roots) cleanup(r);
  return roots;
}

function enrichTopoNode(t, deviceMap) {
  const d = deviceMap.get(t.key);
  t.device = d || {
    bus: t.bus,
    dev: t.dev,
    key: t.key,
    vid: '????',
    pid: '????',
    name: t.className || '(USB device)',
    devNodes: []
  };
  for (const c of t.children || []) enrichTopoNode(c, deviceMap);
}

function addTopoNodeRows(rows, t, prefix, isLast) {
  const d = t.device;
  const branch = isLast ? '└─' : '├─';
  const name = d.name || t.className || '(unnamed USB device)';
  const id = d.vid && d.pid ? `${d.vid}:${d.pid}` : '????:????';
  const rootTag = t.isRoot ? 'root' : topoSummaryForNode(t);
  const topoBits = rootTag ? `  ${rootTag}` : '';
  const text = `${prefix}${branch} ${t.key} ${id} ${name}${topoBits}${devHandleSummary(d)}`;
  rows.push({
    type:'dev',
    key:t.key,
    selectKey:t.key,
    device:d,
    topo:t,
    text,
    selectable:true
  });

  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  const children = t.children || [];
  const nodes = (d.devNodes || []).map(n => n.path).sort();

  children.forEach((c, i) => {
    const childIsLast = i === children.length - 1 && nodes.length === 0;
    addTopoNodeRows(rows, c, childPrefix, childIsLast);
  });

  nodes.forEach((n, j) => {
    const nodeIsLast = j === nodes.length - 1;
    rows.push({
      type:'node',
      key:`${t.key}:${n}`,
      selectKey:t.key,
      parentKey:t.key,
      device:d,
      text:`${childPrefix}${nodeIsLast ? '└─' : '├─'} ${n}`,
      selectable:false
    });
  });
}

function buildRows() {
  const roots = parseLsusbTopology(state.tree);
  if (!roots.length) return buildFallbackRows();

  const deviceMap = new Map(state.devices.map(d => [d.key, d]));
  for (const r of roots) enrichTopoNode(r, deviceMap);

  const rows = [];
  const byBus = new Map();
  for (const r of roots) {
    if (!byBus.has(r.bus)) byBus.set(r.bus, []);
    byBus.get(r.bus).push(r);
  }

  for (const bus of [...byBus.keys()].sort()) {
    rows.push({ type:'bus', key:`bus:${bus}`, text:`USB Bus ${bus}`, selectable:false });
    const busRoots = byBus.get(bus).sort((a,b) => Number(a.dev) - Number(b.dev));
    busRoots.forEach((r, i) => addTopoNodeRows(rows, r, '', i === busRoots.length - 1));
  }

  // Some devices can appear in lsusb but not in lsusb -t during hotplug churn.
  // Keep them visible instead of silently losing them.
  const seen = new Set(rows.filter(r => r.type === 'dev').map(r => r.key));
  const missing = state.devices.filter(d => !seen.has(d.key));
  if (missing.length) {
    rows.push({ type:'bus', key:'bus:unmapped', text:'USB devices not placed in topology yet', selectable:false });
    missing.forEach((d, i) => {
      const isLast = i === missing.length - 1;
      rows.push({
        type:'dev',
        key:d.key,
        selectKey:d.key,
        device:d,
        text:`${isLast ? '└─' : '├─'} ${deviceLabel(d)}${devHandleSummary(d)}`,
        selectable:true
      });
    });
  }

  return rows;
}

function selectableRows(rows = buildRows()) {
  // Keyboard navigation is device-level only.
  // Child /dev rows are visible context, not stops in the Up/Down sequence.
  return rows.filter(r => r.type === 'dev' && r.selectable);
}

function selectedRowIndex(rows = buildRows()) {
  let idx = rows.findIndex(r => r.type === 'dev' && r.key === state.selectedRowKey);
  if (idx < 0) idx = rows.findIndex(r => r.type === 'dev' && r.selectKey === state.selectedKey);
  return idx < 0 ? 0 : idx;
}

function selectRow(row) {
  if (!row) return;

  // Device rows are the real selectable objects.
  // Child /dev rows can be clicked, but they select their parent USB device.
  let target = row;
  if (row.type === 'node') {
    const rows = buildRows();
    target = rows.find(r => r.type === 'dev' && r.key === row.parentKey) || row;
  }
  if (!target.selectable || target.type !== 'dev') return;

  state.selectedRowKey = target.key;
  state.selectedKey = target.selectKey || target.key;
  state.detailScroll = 0;
}

function ensureSelectedVisible(rows, height) {
  const idx = selectedRowIndex(rows);
  if (idx < state.leftScroll) state.leftScroll = idx;
  if (idx >= state.leftScroll + height) state.leftScroll = Math.max(0, idx - height + 1);
  const maxScroll = Math.max(0, rows.length - height);
  if (state.leftScroll > maxScroll) state.leftScroll = maxScroll;
  if (state.leftScroll < 0) state.leftScroll = 0;
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
    lines.push(bold('Driver / udev properties'), '');
    if (!activeNodes.length) lines.push('No /dev-backed udev properties found for this device.');
    for (const n of activeNodes) {
      lines.push(bold(n.path));
      const keys = ['SUBSYSTEM','DEVTYPE','ID_BUS','ID_USB_DRIVER','DRIVER','ID_VENDOR','ID_VENDOR_FROM_DATABASE','ID_VENDOR_ID','ID_MODEL','ID_MODEL_FROM_DATABASE','ID_MODEL_ID','ID_SERIAL','ID_SERIAL_SHORT','ID_USB_INTERFACE_NUM','ID_PATH','DEVPATH','TAGS'];
      for (const k of keys) if (n.props[k]) lines.push(`  ${rightPadRaw(k, 24)} ${n.props[k]}`);
      lines.push('');
    }
  } else if (state.tab === 3) {
    lines.push(bold('Recent relevant kernel clues'), '');
    const relevant = state.lastKernel.filter(l => l.includes(`${Number(d.bus)}-`) || l.toLowerCase().includes((d.name || '').split(' ')[0]?.toLowerCase() || '___') || /usb|ttyUSB|ttyACM|disconnect|attached/i.test(l)).slice(-50);
    if (!relevant.length) lines.push('No recent matching kernel lines in dmesg tail.');
    else lines.push(...relevant);
  } else if (state.tab === 4) {
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
    lines.push(`  Root hub: logical top of USB Bus ${d.bus}. Downstream hubs/devices are shown under it in the left topology tree.`);
  } else {
    lines.push('  Check Driver tab for udev details. The left pane shows hub/port placement.');
  }
  return lines;
}

function wrapPlainForWidth(raw, width) {
  raw = String(raw || '');
  if (width <= 4 || raw.length <= width) return [raw];

  const indentMatch = raw.match(/^\s*/);
  const firstIndent = indentMatch ? indentMatch[0] : '';
  const nextIndent = firstIndent + '  ';
  const out = [];
  let line = raw;
  let currentIndent = firstIndent;

  while (line.length > width) {
    const available = Math.max(4, width - currentIndent.length);
    let chunkSource = line.slice(currentIndent.length);

    if (!chunkSource.trim()) {
      out.push(line.slice(0, width));
      line = currentIndent + line.slice(width).trimStart();
      continue;
    }

    let cut = chunkSource.lastIndexOf(' ', available);
    if (cut < Math.floor(available * 0.55)) cut = available;

    const chunk = chunkSource.slice(0, cut).trimEnd();
    out.push(currentIndent + chunk);

    const rest = chunkSource.slice(cut).trimStart();
    currentIndent = nextIndent;
    line = currentIndent + rest;
  }

  out.push(line);
  return out;
}

function wrapDetailLines(lines, width) {
  const out = [];
  for (const line of lines) {
    if (visLen(line) <= width) {
      out.push(line);
      continue;
    }

    // Long detail text should wrap, not truncate. If the line contains ANSI
    // styling, fall back to plain text for the wrapped continuation so ANSI
    // escape sequences do not corrupt the terminal layout.
    const raw = stripAnsi(line);
    for (const wrapped of wrapPlainForWidth(raw, width)) out.push(wrapped);
  }
  return out;
}

function leftRowWrapIndent(text) {
  const m = String(text || '').match(/^(.*?(?:├─|└─)\s*)/);
  if (m) return ' '.repeat(stripAnsi(m[1]).length);
  const plain = stripAnsi(text || '');
  const m2 = plain.match(/^\s*/);
  return (m2 ? m2[0] : '') + '  ';
}

function wrapLeftText(raw, width) {
  raw = stripAnsi(String(raw || ''));
  if (width <= 8 || raw.length <= width) return [raw];

  const contIndent = leftRowWrapIndent(raw);
  const out = [];
  let line = raw;
  let first = true;

  while (line.length > width) {
    const indent = first ? '' : contIndent;
    const available = Math.max(8, width - indent.length);
    const src = first ? line : line.slice(indent.length);
    let cut = src.lastIndexOf(' ', available);
    if (cut < Math.floor(available * 0.55)) cut = available;
    out.push(indent + src.slice(0, cut).trimEnd());
    const rest = src.slice(cut).trimStart();
    line = contIndent + rest;
    first = false;
  }

  out.push(line);
  return out;
}

function buildLeftVisualRows(rows, width) {
  const out = [];
  for (const row of rows) {
    const parts = wrapLeftText(row.text, width);
    parts.forEach((text, partIndex) => out.push({ row, text, partIndex }));
  }
  return out;
}

function selectedVisualIndex(visualRows) {
  let idx = visualRows.findIndex(v => v.row.type === 'dev' && v.row.key === state.selectedRowKey);
  if (idx < 0) idx = visualRows.findIndex(v => v.row.type === 'dev' && v.row.selectKey === state.selectedKey);
  return idx < 0 ? 0 : idx;
}

function ensureSelectedVisualVisible(visualRows, height) {
  const idx = selectedVisualIndex(visualRows);
  if (idx < state.leftScroll) state.leftScroll = idx;
  if (idx >= state.leftScroll + height) state.leftScroll = Math.max(0, idx - height + 1);
  const maxScroll = Math.max(0, visualRows.length - height);
  if (state.leftScroll > maxScroll) state.leftScroll = maxScroll;
  if (state.leftScroll < 0) state.leftScroll = 0;
}

function render() {
  pruneHighlights();
  const { cols, rows: termRows } = termSize();
  const leftW = Math.max(48, Math.min(96, Math.floor(cols * 0.46)));
  const rightW = Math.max(20, cols - leftW - 3);
  const height = Math.max(10, termRows - 4);
  const rows = buildRows();
  const leftVisualRows = buildLeftVisualRows(rows, leftW);
  ensureSelectedVisualVisible(leftVisualRows, height);
  state.rows = rows;
  state.leftRowMap.clear();

  let out = '\x1b[?25l\x1b[H';
  out += pad(cyan('USB Detective'), cols) + '\n';
  out += pad(`Tree: ↑/↓ select USB device/hub  ←/→ tabs  PgUp/PgDn details  Ctrl+↑/↓ tree  r refresh  q quit`, cols) + '\n';
  out += '─'.repeat(cols) + '\n';

  const d = selectedDevice();
  const details = detailLines(d);
  const tabLine = tabs.map((t,i) => i === state.tab ? `[${t}]` : ` ${t} `).join('  ');
  const detailHead = `${tabLine}`;
  const detailBody = wrapDetailLines([detailHead, '─'.repeat(rightW), ...details], rightW).slice(state.detailScroll, state.detailScroll + height);

  const visibleLeft = leftVisualRows.slice(state.leftScroll, state.leftScroll + height);
  for (let i = 0; i < height; i++) {
    const vrow = visibleLeft[i];
    const row = vrow ? vrow.row : null;
    const left = vrow ? formatLeftVisualCell(vrow, leftW) : ' '.repeat(leftW);
    const sep = ' │ ';
    const right = pad(detailBody[i] || '', rightW);
    out += left + sep + right + '\n';
  }
  out += '─'.repeat(cols) + '\n';
  const scrollInfo = leftVisualRows.length > height ? `  |  tree ${state.leftScroll + 1}-${Math.min(leftVisualRows.length, state.leftScroll + height)}/${leftVisualRows.length}` : '';
  out += pad((state.status || '') + scrollInfo, cols) + '\x1b[J';
  process.stdout.write(out);
}
function fitPlainCell(s, width) {
  s = String(s || '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function formatLeftVisualCell(vrow, width) {
  const row = vrow.row;
  const isSel = row.type === 'dev' && row.key === state.selectedRowKey;
  const isNew = row.device && isAddedKey(row.device.key);
  const isRemoved = row.device && isRemovedDevice(row.device);
  const cell = fitPlainCell(vrow.text, width);

  if (isSel) return selected(cell);
  if (row.type === 'bus') return bold(cell);
  if (isRemoved) return red(cell);
  if (isNew) return green(cell);
  if (row.type === 'node') return dim(cell);
  return cell;
}
function termSize() { return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }; }
function selectDelta(delta) {
  const rows = buildRows();
  const selectable = selectableRows(rows);
  if (!selectable.length) return;
  let idx = selectable.findIndex(r => r.key === state.selectedRowKey);
  if (idx < 0) idx = selectable.findIndex(r => r.selectKey === state.selectedKey);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(selectable.length - 1, idx + delta));
  selectRow(selectable[idx]);
  state.selectedIndex = idx;
  render();
}
function setTab(t) { state.tab = Math.max(0, Math.min(tabs.length - 1, t)); state.detailScroll = 0; render(); }
function scrollDetail(delta) { state.detailScroll = Math.max(0, state.detailScroll + delta); render(); }
function scrollLeft(delta) {
  const { cols, rows: termRows } = termSize();
  const leftW = Math.max(48, Math.min(96, Math.floor(cols * 0.46)));
  const visualRows = buildLeftVisualRows(buildRows(), leftW);
  const height = Math.max(10, termRows - 4);
  const maxScroll = Math.max(0, visualRows.length - height);
  state.leftScroll = Math.max(0, Math.min(maxScroll, state.leftScroll + delta));
  render();
}
function cleanup() {
  process.stdout.write('\x1b[?25h\x1b[0m\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
function handleInput(buf) {
  const s = buf.toString('utf8');
  if (s === '\u0003' || s === 'q') { cleanup(); process.exit(0); }
  if (s === 'r') { poll(true); return; }
  if (s === 'j' || s === '\x1b[B') { selectDelta(1); return; }
  if (s === 'k' || s === '\x1b[A') { selectDelta(-1); return; }
  if (s === '\x1b[C') { setTab(state.tab + 1); return; }
  if (s === '\x1b[D') { setTab(state.tab - 1); return; }
  if (s === '\x1b[6~') { scrollDetail(10); return; }
  if (s === '\x1b[5~') { scrollDetail(-10); return; }
  if (s === '\x1b[1;5B') { scrollLeft(5); return; }
  if (s === '\x1b[1;5A') { scrollLeft(-5); return; }
  if (/^[1-5]$/.test(s)) { setTab(Number(s) - 1); return; }

  // Mouse support is intentionally disabled. Terminal mouse coordinate reporting
  // varies enough between terminal emulators, font scaling, title bars, and pane
  // redraw timing that it was causing wrong-row/wrong-tab selection. Keep this
  // TUI keyboard-first: Up/Down selects USB devices, Left/Right changes tabs,
  // PgUp/PgDn scrolls details, Ctrl+Up/Ctrl+Down scrolls the left tree.

}
async function main() {
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleInput);
    process.stdout.write('\x1b[2J');
  }
  await poll(true);
  setInterval(() => poll(false), POLL_MS);
  setInterval(() => {
    if (pruneHighlights()) render();
  }, 250);
}
main().catch(e => { cleanup(); console.error(e); process.exit(1); });
