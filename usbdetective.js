#!/usr/bin/env node
/*
  usbdetective.js - USB topology TUI for Linux Mint

  No npm dependencies. Uses lsusb, udevadm, lsblk, dmesg, and optional v4l2-ctl.

  Keys:
    Up/Down            Select USB devices/hubs in the topology tree
    PgUp/PgDn          Scroll details
    Left/Right         Previous/next detail tab
    1..6               Select detail tab
    k or K             Toggle keyboard mapping help
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

const APP_VERSION = 'v20260608.10';
const APP_TITLE = `USB Detective ${APP_VERSION}`;

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
function titleGreen(s) { return USE_COLOR ? '\x1b[38;5;71m' + C.bold + s + C.reset : s; }
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

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

function enterTuiScreen() {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALT_SCREEN_ON + CLEAR_SCREEN + '\x1b[?25l');
}

function leaveTuiScreen() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[?25h\x1b[0m' + ALT_SCREEN_OFF);
}

function mouseWheelDelta(s) {
  // SGR mouse wheel from many terminals:
  //   ESC [ < 64 ; x ; y M  wheel up
  //   ESC [ < 65 ; x ; y M  wheel down
  const m = String(s || '').match(/\x1b\[<(\d+);(\d+);(\d+)[mM]/);
  if (!m) return 0;
  const code = Number(m[1]);
  if (code === 64) return -3;
  if (code === 65) return 3;
  return 0;
}


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
  startupMessage: 'Scanning USB buses, hubs, drivers, handles and udev data... please wait',
  showKeys: false,
  devices: [], rows: [], selectedKey: null, selectedRowKey: null, selectedIndex: 0, detailScroll: 0, leftScroll: 0, tab: 0,
  previousKeys: new Set(), addedUntil: new Map(), removedUntil: new Map(), removedDevices: new Map(),
  lastKernel: [], status: 'Starting...', lastSignature: '', needsRender: true, polling: false,
  leftRowMap: new Map(), lastPollAt: null,
  sniff: { fd: null, path: '', kind: '', active: false, opening: false, lines: [], bytes: 0, reads: 0, error: '', targetIndex: 0 }
};
const tabs = ['Summary', '/dev', 'Handles', 'Driver', 'Kernel', 'Raw USB'];

const SNIFF_MAX_LINES = 500;
const SNIFF_READ_SIZE = 64;

function sniffableNodesForDevice(d) {
  if (!d) return [];
  const out = [];
  if (d.rawUsbNode || d.rawUsb) out.push({ path: d.rawUsbNode || d.rawUsb, kind: 'raw usbfs device' });
  for (const n of d.devNodes || []) {
    if (!n || !n.path) continue;
    if (/^\/dev\/input\/(event\d+|mouse\d+|mice)$/.test(n.path)) out.push({ path: n.path, kind: devNodeShortLabel(n) || n.type || 'input node' });
    else if (/^\/dev\/hidraw\d+$/.test(n.path)) out.push({ path: n.path, kind: 'hidraw node' });
  }
  return out;
}

function hexDump(buf) {
  const b = Buffer.from(buf || []);
  const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
  const asc = [...b].map(x => x >= 32 && x <= 126 ? String.fromCharCode(x) : '.').join('');
  return `${hex}  |${asc}|`;
}


function parseLsusbLine(line) {
  const m = line.match(/^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/);
  if (!m) return null;
  const [, bus, dev, vid, pid, name] = m;
  const rawUsbNode = rawUsbNodePath(bus, dev);
  return { bus, dev, vid: vid.toLowerCase(), pid: pid.toLowerCase(), name: (name || '').trim(), key: `${bus}:${dev}`, devNodes: [], links: [], props: {}, block: null, videoInfo: '', rawUsb: rawUsbNode, rawUsbNode, rawUsbStat: '', rawUsbUsers: null, removed: false };
}


function sniffAddLine(line) {
  const stamp = new Date().toLocaleTimeString();
  state.sniff.lines.push(`${stamp}  ${line}`);
  if (state.sniff.lines.length > SNIFF_MAX_LINES) state.sniff.lines.splice(0, state.sniff.lines.length - SNIFF_MAX_LINES);
  render();
}

function closeSniffer(msg = 'closed') {
  const fd = state.sniff.fd;
  state.sniff.fd = null;
  state.sniff.active = false;
  state.sniff.opening = false;
  if (fd !== null && fd !== undefined) {
    try { fs.closeSync(fd); } catch {}
  }
  if (state.sniff.path) sniffAddLine(`sniffer ${msg}: ${state.sniff.path}`);
  state.status = `Sniffer ${msg}`;
  render();
}

function sniffReadLoop() {
  if (!state.sniff.active || state.sniff.fd === null || state.sniff.fd === undefined) return;
  const buf = Buffer.alloc(SNIFF_READ_SIZE);
  fs.read(state.sniff.fd, buf, 0, buf.length, null, (err, bytesRead) => {
    if (!state.sniff.active) return;
    if (err) {
      const code = err.code || '';
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        setTimeout(sniffReadLoop, 25);
        return;
      }
      state.sniff.error = `${code || 'read error'} ${err.message || err}`;
      sniffAddLine(`read error: ${state.sniff.error}`);
      closeSniffer('stopped');
      return;
    }
    if (bytesRead > 0) {
      const chunk = buf.subarray(0, bytesRead);
      state.sniff.bytes += bytesRead;
      state.sniff.reads += 1;
      sniffAddLine(`${rightPadRaw(bytesRead, 4)} bytes  ${hexDump(chunk)}`);
    }
    setTimeout(sniffReadLoop, bytesRead > 0 ? 0 : 25);
  });
}

function selectedSniffTarget(d = selectedDevice()) {
  const targets = sniffableNodesForDevice(d);
  if (!targets.length) return null;
  const idx = Math.max(0, Math.min(targets.length - 1, state.sniff.targetIndex || 0));
  return targets[idx];
}

function cycleSniffTarget(delta) {
  if (state.sniff.active || state.sniff.opening) return;
  const targets = sniffableNodesForDevice(selectedDevice());
  if (!targets.length) return;
  state.sniff.targetIndex = (state.sniff.targetIndex + delta + targets.length) % targets.length;
  render();
}

function toggleSniffer() {
  if (state.sniff.active || state.sniff.opening) { closeSniffer('closed'); return; }
  const target = selectedSniffTarget();
  if (!target) {
    state.status = 'No raw/input/hidraw node available to sniff on selected device';
    render();
    return;
  }
  state.sniff.opening = true;
  state.sniff.path = target.path;
  state.sniff.kind = target.kind || '';
  state.sniff.error = '';
  state.sniff.lines = [];
  state.sniff.bytes = 0;
  state.sniff.reads = 0;
  render();
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  fs.open(target.path, flags, (err, fd) => {
    state.sniff.opening = false;
    if (err) {
      state.sniff.error = `${err.code || 'open error'} ${err.message || err}`;
      sniffAddLine(`open failed: ${state.sniff.error}`);
      state.status = `Sniffer open failed for ${target.path}`;
      render();
      return;
    }
    state.sniff.fd = fd;
    state.sniff.active = true;
    state.sniff.path = target.path;
    state.sniff.kind = target.kind || '';
    sniffAddLine(`opened ${target.path} (${state.sniff.kind || 'node'})`);
    state.status = `Sniffing ${target.path}; press o to close`;
    sniffReadLoop();
  });
}

function rawUsbNodePath(bus, dev) {
  if (!bus || !dev) return '';
  return `/dev/bus/usb/${String(bus).padStart(3, '0')}/${String(dev).padStart(3, '0')}`;
}

function rawUsbNodeSummary(d) {
  const p = d && (d.rawUsbNode || d.rawUsb);
  return p ? `Raw USB node: ${p}` : '';
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
  const cmd = `for p in /dev/ttyUSB* /dev/ttyACM* /dev/video* /dev/hidraw* /dev/sd* /dev/nvme* /dev/input/event* /dev/input/mouse* /dev/input/mice; do [ -e "$p" ] && echo "$p"; done | sort -V`;
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
  const dirs = ['/dev/serial/by-id','/dev/serial/by-path','/dev/disk/by-id','/dev/disk/by-label','/dev/disk/by-uuid','/dev/v4l/by-id','/dev/v4l/by-path','/dev/input/by-id','/dev/input/by-path'];
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

async function readProcText(file, max = 65536) {
  try {
    const s = await fs.promises.readFile(file, 'utf8');
    return s.slice(0, max);
  } catch {
    return '';
  }
}

function parseUidFromStatus(statusText) {
  const m = String(statusText || '').match(/^Uid:\s+(\d+)/m);
  return m ? m[1] : '';
}

async function usernameFromUid(uid) {
  if (!uid) return '';
  const passwd = await readProcText('/etc/passwd', 1024 * 1024);
  for (const line of passwd.split('\n')) {
    const parts = line.split(':');
    if (parts[2] === String(uid)) return parts[0];
  }
  return uid;
}

async function procInfo(pid) {
  const base = `/proc/${pid}`;
  const [comm, status, cmdlineRaw] = await Promise.all([
    readProcText(`${base}/comm`, 4096),
    readProcText(`${base}/status`, 65536),
    fs.promises.readFile(`${base}/cmdline`).catch(() => Buffer.alloc(0))
  ]);

  const uid = parseUidFromStatus(status);
  const user = await usernameFromUid(uid);
  const cmdline = cmdlineRaw.length
    ? cmdlineRaw.toString('utf8').replace(/\0/g, ' ').trim()
    : '';

  return {
    pid: String(pid),
    user,
    command: (comm || '').trim(),
    cmdline
  };
}


function linuxMajor(dev) {
  dev = Number(dev || 0);
  return ((dev >> 8) & 0xfff) | ((dev >> 32) & ~0xfff);
}

function linuxMinor(dev) {
  dev = Number(dev || 0);
  return (dev & 0xff) | ((dev >> 12) & ~0xff);
}

async function devNodeIdentity(devPath) {
  try {
    const st = await fs.promises.stat(devPath);
    return {
      path: devPath,
      dev: st.dev,
      ino: st.ino,
      rdev: st.rdev,
      major: linuxMajor(st.rdev),
      minor: linuxMinor(st.rdev),
      mode: st.mode
    };
  } catch {
    return null;
  }
}

function looksLikeInputConsumer(info) {
  const text = `${info.command || ''} ${info.cmdline || ''}`.toLowerCase();
  return /\b(systemd-logind|xorg|xwayland|wayland|mutter|gnome-shell|cinnamon|kwin|plasmashell|xfce4|mate-settings-daemon|libinput|xinput|evtest|input-remapper|solaar|ratbagd|piper)\b/.test(text);
}

async function scanLikelyInputConsumers() {
  const out = [];
  let pids = [];
  try {
    pids = (await fs.promises.readdir('/proc')).filter(x => /^\d+$/.test(x));
  } catch {
    return out;
  }

  for (const pid of pids) {
    try {
      const info = await procInfo(pid);
      if (looksLikeInputConsumer(info)) out.push({ ...info, fds: [], source: 'input-stack guess' });
    } catch {}
  }

  return out.sort((a, b) => Number(a.pid) - Number(b.pid));
}

async function scanProcOpeners(devPath) {
  const out = [];
  let devReal = devPath;
  try { devReal = await fs.promises.realpath(devPath); } catch {}
  const targetIdentity = await devNodeIdentity(devPath);
  let pids = [];
  try {
    pids = (await fs.promises.readdir('/proc')).filter(x => /^\d+$/.test(x));
  } catch {
    return out;
  }

  for (const pid of pids) {
    const fdDir = `/proc/${pid}/fd`;
    let fds = [];
    try { fds = await fs.promises.readdir(fdDir); } catch { continue; }

    const matchedFds = [];
    for (const fd of fds) {
      const fdPath = `${fdDir}/${fd}`;
      try {
        const link = await fs.promises.readlink(fdPath);
        let resolved = link;
        if (link.startsWith('/dev/')) {
          try { resolved = await fs.promises.realpath(link); } catch {}
        }

        let reason = '';
        if (link === devPath || link === devReal || resolved === devReal) {
          reason = 'path';
        } else if (targetIdentity && Number(targetIdentity.rdev || 0) > 0) {
          try {
            const fst = await fs.promises.stat(fdPath);
            if (Number(fst.rdev || 0) === Number(targetIdentity.rdev || 0)) {
              reason = `major/minor ${targetIdentity.major}:${targetIdentity.minor}`;
            }
          } catch {}
        }

        if (reason) matchedFds.push({ fd, target: link, match: reason });
      } catch {}
    }

    if (matchedFds.length) {
      const info = await procInfo(pid);
      out.push({ ...info, fds: matchedFds, source: 'procfs' });
    }
  }

  return out.sort((a, b) => Number(a.pid) - Number(b.pid));
}

async function lsofOpeners(devPath) {
  const r = await run('lsof', ['-nP', '-F', 'pcuLftn', '--', devPath], { timeout: 2500, maxBuffer: 1024 * 1024 });
  if (!r.ok || !r.stdout) return [];

  const procs = [];
  let cur = null;
  let curFd = null;

  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);

    if (tag === 'p') {
      if (cur) procs.push(cur);
      cur = { pid: val, command: '', user: '', login: '', fds: [], source: 'lsof' };
      curFd = null;
    } else if (!cur) {
      continue;
    } else if (tag === 'c') {
      cur.command = val;
    } else if (tag === 'u') {
      cur.user = val;
    } else if (tag === 'L') {
      cur.login = val;
    } else if (tag === 'f') {
      curFd = { fd: val, type: '', target: '' };
      cur.fds.push(curFd);
    } else if (tag === 't' && curFd) {
      curFd.type = val;
    } else if (tag === 'n' && curFd) {
      curFd.target = val;
    }
  }
  if (cur) procs.push(cur);

  for (const p of procs) {
    const info = await procInfo(p.pid);
    p.command = p.command || info.command;
    p.user = p.login || p.user || info.user;
    p.cmdline = info.cmdline;
  }

  return procs;
}

async function fuserOpeners(devPath) {
  const r = await run('fuser', ['-v', devPath], { timeout: 2500, maxBuffer: 512 * 1024 });
  return {
    ok: r.ok,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    available: !/not found|No such file/i.test(r.error + r.stderr)
  };
}

async function getHandleUsers(devPath) {
  const isInputNode = /^\/dev\/input\//.test(devPath);
  const [lsof, procfs, fuser, likelyInputConsumers] = await Promise.all([
    lsofOpeners(devPath).catch(() => []),
    scanProcOpeners(devPath).catch(() => []),
    fuserOpeners(devPath).catch(() => ({ ok:false, stdout:'', stderr:'', available:false })),
    isInputNode ? scanLikelyInputConsumers().catch(() => []) : Promise.resolve([])
  ]);

  const byPid = new Map();
  for (const p of [...lsof, ...procfs]) {
    if (!p || !p.pid) continue;
    const existing = byPid.get(p.pid) || {};
    byPid.set(p.pid, {
      ...existing,
      ...p,
      user: p.user || existing.user || '',
      command: p.command || existing.command || '',
      cmdline: p.cmdline || existing.cmdline || '',
      fds: [...(existing.fds || []), ...(p.fds || [])],
      source: [existing.source, p.source].filter(Boolean).join('+') || p.source || ''
    });
  }

  const processes = [...byPid.values()].map(p => {
    const seen = new Set();
    p.fds = (p.fds || []).filter(fd => {
      const k = `${fd.fd}|${fd.target || ''}|${fd.match || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return p;
  }).sort((a, b) => Number(a.pid) - Number(b.pid));

  const openPids = new Set(processes.map(p => String(p.pid)));
  const likelyConsumers = (likelyInputConsumers || [])
    .filter(p => p && p.pid && !openPids.has(String(p.pid)))
    .slice(0, 12);

  return { processes, likelyConsumers, fuser };
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
  if (/^mouse\d+$/.test(base) || base === 'mice') return 'Input mouse aggregate node';
  if (/^event\d+$/.test(base)) {
    const kind = inputKindFromProps(props);
    return kind ? `Input event node — ${kind}` : 'Input event node';
  }
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
function usbPathFromProps(props) {
  const candidates = [props.DEVPATH || '', props.ID_PATH || ''];
  for (const c of candidates) {
    const matches = String(c).match(/\b\d+-\d+(?:\.\d+)*(?::\d+\.\d+)?\b/g) || [];
    if (matches.length) {
      return matches[matches.length - 1].replace(/:\d+\.\d+$/, '');
    }
  }
  return '';
}

function inputKindFromProps(props) {
  if (!props) return '';
  const kinds = [];
  if (props.ID_INPUT_MOUSE) kinds.push('Mouse');
  if (props.ID_INPUT_KEYBOARD) kinds.push('Keyboard');
  else if (props.ID_INPUT_KEY) kinds.push('Keyboard/key input');
  if (props.ID_INPUT_TOUCHPAD) kinds.push('Touchpad');
  if (props.ID_INPUT_JOYSTICK) kinds.push('Joystick/gamepad');
  if (props.ID_INPUT_TABLET) kinds.push('Tablet');
  if (props.ID_INPUT_TOUCHSCREEN) kinds.push('Touchscreen');
  return kinds.join(' + ');
}

function cleanInputName(name) {
  return String(name || '').replace(/^["']|["']$/g, '').trim();
}

function inferInputKindFromSysfs(info) {
  const name = cleanInputName(info && info.name);
  if (!name) return '';
  if (/consumer control/i.test(name)) return 'Consumer Control';
  if (/system control/i.test(name)) return 'System Control';
  if (/mouse/i.test(name)) return 'Mouse';
  if (/keyboard/i.test(name)) return 'Keyboard';
  if (/joystick|gamepad|xbox|controller/i.test(name)) return 'Joystick/gamepad';
  if (/touchpad/i.test(name)) return 'Touchpad';
  if (/camera|video/i.test(name)) return 'Video control';
  return '';
}

async function inputSysfsInfo(devPath, props) {
  const base = path.basename(devPath);
  if (!/^(event|mouse)\d+$/.test(base) && base !== 'mice') return null;

  const candidates = [
    `/sys/class/input/${base}/device`,
    props && props.DEVPATH ? `/sys${props.DEVPATH}/device` : ''
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      const name = cleanInputName(await fs.promises.readFile(`${dir}/name`, 'utf8'));
      const phys = (await fs.promises.readFile(`${dir}/phys`, 'utf8').catch(() => '')).trim();
      const uniq = (await fs.promises.readFile(`${dir}/uniq`, 'utf8').catch(() => '')).trim();
      const capsDir = `${dir}/capabilities`;
      const caps = {};
      for (const cap of ['ev','key','rel','abs','msc','led','sw']) {
        const v = (await fs.promises.readFile(`${capsDir}/${cap}`, 'utf8').catch(() => '')).trim();
        if (v) caps[cap] = v;
      }
      return { name, phys, uniq, caps, kind: inferInputKindFromSysfs({ name }) };
    } catch {}
  }

  return null;
}

async function videoNodeInfo(devPath, props) {
  if (!/^video\d+$/.test(path.basename(devPath))) return null;
  const info = { name: '', driver: '', card: '', bus: '', formats: [] };

  const devNamePaths = [
    `/sys/class/video4linux/${path.basename(devPath)}/name`,
    props && props.DEVPATH ? `/sys${props.DEVPATH}/name` : ''
  ].filter(Boolean);
  for (const f of devNamePaths) {
    const v = (await fs.promises.readFile(f, 'utf8').catch(() => '')).trim();
    if (v) { info.name = v; break; }
  }

  const r = await run('v4l2-ctl', ['--device', devPath, '--info'], { timeout: 1800, maxBuffer: 256 * 1024 }).catch(() => ({ ok:false, stdout:'' }));
  if (r && r.ok && r.stdout) {
    for (const line of r.stdout.split('\n')) {
      let m = line.match(/^\s*Driver name\s*:\s*(.*)$/); if (m) info.driver = m[1].trim();
      m = line.match(/^\s*Card type\s*:\s*(.*)$/); if (m) info.card = m[1].trim();
      m = line.match(/^\s*Bus info\s*:\s*(.*)$/); if (m) info.bus = m[1].trim();
      m = line.match(/^\s*Device Caps\s*:\s*(.*)$/); if (m) info.deviceCapsRaw = m[1].trim();
      if (/Video Capture/i.test(line)) info.hasVideoCapture = true;
      if (/Video Output/i.test(line)) info.hasVideoOutput = true;
      if (/Metadata Capture/i.test(line)) info.hasMetadataCapture = true;
      if (/Streaming/i.test(line)) info.hasStreaming = true;
    }
  }

  const fr = await run('v4l2-ctl', ['--device', devPath, '--list-formats-ext'], { timeout: 2200, maxBuffer: 512 * 1024 }).catch(() => ({ ok:false, stdout:'' }));
  if (fr && fr.ok && fr.stdout) {
    for (const line of fr.stdout.split('\n')) {
      const m = line.match(/\[\d+\]:\s+'([^']+)'\s+\((.+)\)/);
      if (m) info.formats.push(`${m[1]} ${m[2]}`);
      if (info.formats.length >= 4) break;
    }
  }

  if (info.formats.length) info.role = 'Video capture';
  else if (info.hasVideoCapture) info.role = 'Video capture';
  else if (info.hasMetadataCapture) info.role = 'Metadata/control';
  else if (info.name || info.card) info.role = 'Video node';

  return (info.name || info.driver || info.card || info.formats.length || info.role) ? info : null;
}

async function decorateDevNode(record) {
  record.devIdentity = await devNodeIdentity(record.path).catch(() => null);
  record.input = await inputSysfsInfo(record.path, record.props).catch(() => null);
  record.video = await videoNodeInfo(record.path, record.props).catch(() => null);
  return record;
}

function devNodeKernelLabel(n) {
  if (!n) return '';
  const k = n.kernel || {};
  const bits = [];
  if (k.role) bits.push(k.role);
  if (k.hidraw) bits.push(k.hidraw);
  if (k.inputNumber && !String(n.path).endsWith(`event${k.inputNumber}`)) bits.push(`input${k.inputNumber}`);
  const propKind = inputKindFromProps(n.props || {});
  if (propKind && !bits.some(b => b.toLowerCase().includes(propKind.toLowerCase().split('/')[0]))) bits.push(propKind);
  return bits.join(' / ');
}

function friendlyDevNodeType(n) {
  const baseType = n.type || 'Device node';
  const label = devNodeShortLabel(n);
  if (!label) return baseType;
  return baseType.includes(label) ? baseType : `${baseType} — ${label}`;
}

function parseKernelUsbClues(lines) {
  const byUsbPath = new Map();
  const byBusDev = new Map();
  const byDevNode = new Map();
  let lastUsbPath = '';

  function ensureUsb(path) {
    if (!path) return null;
    if (!byUsbPath.has(path)) byUsbPath.set(path, { usbPath: path, lines: [], product: '', manufacturer: '', serial: '', vid: '', pid: '', bcdDevice: '', roles: [], hidraw: [], inputNodes: [] });
    return byUsbPath.get(path);
  }

  function addLine(obj, line) {
    if (!obj) return;
    obj.lines.push(line);
    if (obj.lines.length > 80) obj.lines.shift();
  }

  for (const line of lines || []) {
    const body = String(line || '');
    const usbLine = body.match(/\busb\s+(\d+-\d+(?:\.\d+)*):\s+(.*)$/i);
    if (usbLine) {
      const usbPath = usbLine[1];
      const rest = usbLine[2];
      lastUsbPath = usbPath;
      const obj = ensureUsb(usbPath);
      addLine(obj, body);

      let m = rest.match(/New USB device found,\s*idVendor=([0-9a-fA-F]{4}),\s*idProduct=([0-9a-fA-F]{4}),\s*bcdDevice=\s*([^\s]+)/i);
      if (m) { obj.vid = m[1].toLowerCase(); obj.pid = m[2].toLowerCase(); obj.bcdDevice = m[3]; }

      m = rest.match(/new\s+(?:low|full|high|super)-speed USB device number\s+(\d+)\s+using\s+(\S+)/i);
      if (m) {
        const bus = usbPath.split('-')[0].padStart(3, '0');
        const dev = String(m[1]).padStart(3, '0');
        obj.bus = bus; obj.dev = dev; obj.hostDriver = m[2];
        byBusDev.set(`${bus}:${dev}`, obj);
      }

      m = rest.match(/Product:\s*(.*)$/i); if (m) obj.product = m[1].trim();
      m = rest.match(/Manufacturer:\s*(.*)$/i); if (m) obj.manufacturer = m[1].trim();
      m = rest.match(/SerialNumber:\s*(.*)$/i); if (m) obj.serial = m[1].trim();
      continue;
    }

    const inputLine = body.match(/\binput:\s+(.+?)(?:\s+(Keyboard|Mouse|Consumer Control|System Control|Joystick|Gamepad))?\s+as\s+(.+?\/input\/input(\d+))\b/i);
    if (inputLine) {
      const name = inputLine[1].trim();
      const explicitRole = inputLine[2] || '';
      const devpath = inputLine[3];
      const inputNumber = inputLine[4];
      const usbPathMatch = devpath.match(/\/usb\d+\/(?:[^/]+\/)*(\d+-\d+(?:\.\d+)*)(?::\d+\.\d+)?\//);
      const usbPath = usbPathMatch ? usbPathMatch[1] : lastUsbPath;
      const role = explicitRole || (/consumer/i.test(name) ? 'Consumer Control' : /system/i.test(name) ? 'System Control' : /mouse/i.test(name) ? 'Mouse' : /keyboard/i.test(name) ? 'Keyboard' : 'Input');
      const obj = ensureUsb(usbPath);
      const rec = { path: `/dev/input/event${inputNumber}`, inputNumber, name, role, source: 'kernel input', line: body };
      if (obj) {
        obj.inputNodes.push(rec);
        obj.roles.push(role);
        addLine(obj, body);
      }
      byDevNode.set(rec.path, rec);
      continue;
    }

    const hidLine = body.match(/\bhid-generic\s+[^:]+:\s+(.+?)\s+USB HID v[^\[]+\[([^\]]+)\]\s+on\s+usb-[^/]+\/(.+)$/i);
    if (hidLine) {
      const nodeText = hidLine[1];
      const role = (hidLine[2] || '').trim();
      const tail = hidLine[3] || '';
      const hp = nodeText.match(/\bhidraw\d+\b/i);
      const usbPathMatch = tail.match(/(\d+-\d+(?:\.\d+)*)(?::\d+\.\d+)?(?:\/|$)/);
      const usbPath = usbPathMatch ? usbPathMatch[1] : lastUsbPath;
      const obj = ensureUsb(usbPath);
      const rec = { path: hp ? `/dev/${hp[0]}` : '', hidraw: hp ? hp[0] : '', role, source: 'kernel hid-generic', line: body };
      if (obj) {
        if (rec.hidraw) obj.hidraw.push(rec);
        obj.roles.push(role);
        addLine(obj, body);
      }
      if (rec.path) byDevNode.set(rec.path, rec);
      continue;
    }
  }

  for (const obj of byUsbPath.values()) {
    obj.roles = [...new Set((obj.roles || []).filter(Boolean))];
    obj.inputNodes = uniqueBy(obj.inputNodes || [], x => x.path + '|' + x.role);
    obj.hidraw = uniqueBy(obj.hidraw || [], x => x.path + '|' + x.role);
  }

  return { byUsbPath, byBusDev, byDevNode };
}

function uniqueBy(arr, fn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = fn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function enrichDevice(dev, allNodes, blockMap, kernelClues) {
  dev.rawUsbNode = rawUsbNodePath(dev.bus, dev.dev);
  dev.rawUsb = dev.rawUsbNode;
  dev.rawUsbStat = dev.rawUsbNode ? await lsLong(dev.rawUsbNode).catch(() => '') : '';
  const matches = [];
  for (const node of allNodes) {
    const props = await udevProps(node);
    const bd = busDevFromProps(props);
    const vp = vidPidFromProps(props);
    if (bd === dev.key || (!bd && vp === `${dev.vid}:${dev.pid}`) || (vp === `${dev.vid}:${dev.pid}` && path.basename(node).match(/^(ttyUSB|ttyACM|video|hidraw|event|sd|nvme)/))) {
      matches.push(await decorateDevNode({ path: node, props, type: classifyDevNode(node, props), iface: interfaceLabel(props), links: await symlinkMatches(node), stat: await lsLong(node), users: await getHandleUsers(node), usbPath: usbPathFromProps(props), kernel: kernelClues && kernelClues.byDevNode ? kernelClues.byDevNode.get(node) : null }));
    }
  }
  // Fallback: some tty nodes do not expose BUSNUM/DEVNUM, but do expose matching VID/PID.
  if (!matches.length) {
    for (const node of allNodes) {
      const props = await udevProps(node);
      if (vidPidFromProps(props) === `${dev.vid}:${dev.pid}`) {
        matches.push(await decorateDevNode({ path: node, props, type: classifyDevNode(node, props), iface: interfaceLabel(props), links: await symlinkMatches(node), stat: await lsLong(node), users: await getHandleUsers(node), usbPath: usbPathFromProps(props), kernel: kernelClues && kernelClues.byDevNode ? kernelClues.byDevNode.get(node) : null }));
      }
    }
  }
  const usbPaths = [...new Set(matches.map(m => m.usbPath).filter(Boolean))];
  let kdev = kernelClues && kernelClues.byBusDev ? kernelClues.byBusDev.get(dev.key) : null;
  if (!kdev && kernelClues && kernelClues.byUsbPath) {
    for (const p of usbPaths) { if (kernelClues.byUsbPath.has(p)) { kdev = kernelClues.byUsbPath.get(p); break; } }
  }
  dev.kernel = kdev || null;
  dev.devNodes = matches.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const m of matches) {
    const b = blockMap.get(m.path);
    if (b) m.block = b;
  }
  return dev;
}
async function collectSnapshot() {
  const [devices, tree, devNodes, lsblk, kernel] = await Promise.all([getLsusbDevices(), getLsusbTree(), getDevCandidates(), getLsblkJson(), getDmesgTail()]);
  const kernelClues = parseKernelUsbClues(kernel);
  const blockMap = new Map(flattenBlock(lsblk).filter(d => d.path).map(d => [d.path, d]));
  for (const d of devices) {
    await enrichDevice(d, devNodes, blockMap, kernelClues);
  }
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
    d: snap.devices.map(d => [d.key, d.vid, d.pid, d.name, d.rawUsbNode || d.rawUsb || '', d.devNodes.map(n => n.path).sort()]),
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

function topoDrivers(t) {
  return [...new Set((t.interfaces || [])
    .map(i => i.driver)
    .filter(x => x && x !== '[none]'))];
}

function topoClasses(t) {
  return [...new Set((t.interfaces || [])
    .map(i => i.className)
    .filter(Boolean))];
}

function topoSummaryForNode(t) {
  const bits = [];
  if (t.port) bits.push(`Port ${String(t.port).padStart(3, '0')}`);
  if (t.speed) bits.push(`Speed ${t.speed}`);
  return bits.join('  ');
}

function devHandleSummary(d) {
  const count = (d.devNodes || []).length;
  if (!count) return '';
  return `Handles ${count}`;
}

function deviceInfoLines(t, d) {
  const id = d.vid && d.pid ? `${d.vid}:${d.pid}` : '????:????';

  const identityBits = [`Bus ${t.bus}`, `Dev ${t.dev}`, `ID ${id}`];
  if (t.isRoot) identityBits.push('Root hub');
  else {
    if (t.port) identityBits.push(`Port ${String(t.port).padStart(3, '0')}`);
    if (t.speed) identityBits.push(`Speed ${t.speed}`);
  }

  const softwareBits = [];
  const drivers = topoDrivers(t);
  if (drivers.length) softwareBits.push(`Driver ${drivers.join('/')}`);
  const classes = topoClasses(t).filter(c => c && !/root hub/i.test(c));
  if (classes.length) softwareBits.push(`Class ${classes.join('/')}`);
  const handles = devHandleSummary(d);
  if (handles) softwareBits.push(handles);

  const out = [identityBits.join('  '), softwareBits.join('  ')];
  const rawLine = rawUsbNodeSummary(d);
  if (rawLine) out.push(rawLine);
  if (d.kernel && d.kernel.roles && d.kernel.roles.length) {
    out.push(`Functions ${d.kernel.roles.join('/')}`);
  }
  return out;
}


function sameLooseName(a, b) {
  const clean = x => String(x || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const aa = clean(a);
  const bb = clean(b);
  return !!aa && !!bb && (aa === bb || aa.includes(bb) || bb.includes(aa));
}

function genericInputLabel(n) {
  const name = cleanInputName(n && n.input && n.input.name);
  const model = (n && n.props && (n.props.ID_MODEL || n.props.ID_MODEL_FROM_DATABASE)) || '';
  const serial = (n && n.props && n.props.ID_SERIAL) || '';

  // Some HID collections expose no specific udev role. The sysfs name then
  // often repeats only the USB product string, which is not useful in the tree.
  if (sameLooseName(name, model) || sameLooseName(name, serial)) return 'Generic HID input';
  if (/usb device$/i.test(name) || /2\.4g receiver$/i.test(name)) return 'Generic HID input';
  return name || 'Generic HID input';
}

function videoShortLabel(n) {
  if (!n || !n.video) return '';
  const role = n.video.role || (n.video.formats && n.video.formats.length ? 'Video capture' : 'Video node');
  const card = n.video.card || n.video.name || '';

  if (/metadata|control/i.test(role)) return card ? `${card} metadata/control` : 'Metadata/control';
  if (/capture/i.test(role)) return card ? `${card} capture` : 'Video capture';
  return card ? `${card} ${role}` : role;
}

function serialShortLabel(n) {
  if (!n || !n.path) return '';
  const base = path.basename(n.path);
  if (!/^ttyUSB\d+$/.test(base) && !/^ttyACM\d+$/.test(base)) return '';

  const ifaceNum = n.props && n.props.ID_USB_INTERFACE_NUM;
  const iface = interfaceLabel(n.props || '');
  if (/^ttyUSB\d+$/.test(base)) {
    if (ifaceNum === '00') return 'Serial Channel A';
    if (ifaceNum === '01') return 'Serial Channel B';
    if (ifaceNum === '02') return 'Serial Channel C';
    if (ifaceNum === '03') return 'Serial Channel D';
    return iface ? `USB serial — ${iface}` : 'USB serial';
  }

  return iface ? `CDC/ACM serial — ${iface}` : 'CDC/ACM serial';
}

function devNodeShortLabel(n) {
  if (!n) return '';

  const serialLabel = serialShortLabel(n);
  if (serialLabel) return serialLabel;

  if (n.video) return videoShortLabel(n);

  const kernelLabel = devNodeKernelLabel(n);
  if (kernelLabel) return kernelLabel;

  const propKind = inputKindFromProps(n.props || {});
  if (propKind) return propKind;

  if (n.input) {
    if (n.input.kind) return n.input.kind;
    return genericInputLabel(n);
  }

  if (/^hidraw\d+$/.test(path.basename(n.path))) return 'Raw HID';
  if (/^video\d+$/.test(path.basename(n.path))) return 'Video node';
  return '';
}

function leftDevNodeLabel(d, devPath) {
  const n = (d.devNodes || []).find(x => x.path === devPath);
  if (!n) return devPath;
  const label = devNodeShortLabel(n);
  return label ? `${devPath}  ${label}` : devPath;
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
      const childPrefix = isLastDevice ? '   ' : '│  ';
      rows.push({
        type:'dev',
        key:d.key,
        selectKey:d.key,
        device:d,
        text:`${branch} ${d.name || '(unnamed USB device)'}`,
        selectable:true
      });
      const nodes = (d.devNodes || []).map(n => n.path).sort();
      const metaPrefix = childPrefix + (nodes.length ? '│  ' : '   ');
      const fallbackInfo = [`Bus ${d.bus}  Dev ${d.dev}  ID ${d.vid}:${d.pid}${d.devNodes && d.devNodes.length ? `  Handles ${d.devNodes.length}` : ''}`];
      const rawFallback = rawUsbNodeSummary(d);
      if (rawFallback) fallbackInfo.push(rawFallback);
      if (d.kernel && d.kernel.roles && d.kernel.roles.length) fallbackInfo.push(`Functions ${d.kernel.roles.join('/')}`);
      fallbackInfo.forEach((line, idx) => rows.push({
        type:'meta',
        key:`${d.key}:meta${idx || ''}`,
        selectKey:d.key,
        parentKey:d.key,
        device:d,
        text:`${metaPrefix}${line}`,
        selectable:false
      }));
      nodes.forEach((n, j) => rows.push({
        type:'node',
        key:`${d.key}:${n}`,
        selectKey:d.key,
        parentKey:d.key,
        device:d,
        text:`${childPrefix}${j === nodes.length - 1 ? '└─' : '├─'} ${leftDevNodeLabel(d, n)}`,
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
  const text = `${prefix}${branch} ${name}`;
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
  const hasChildRows = children.length > 0 || nodes.length > 0;

  // Metadata belongs to the selected USB device, but visually it should stay
  // inside that device's branch. If the device has downstream children or /dev
  // handles, keep an internal vertical pipe running through the metadata lines.
  const metaPrefix = childPrefix + (hasChildRows ? '│  ' : '   ');
  const infoLines = deviceInfoLines(t, d).filter(Boolean);
  infoLines.forEach((line, idx) => rows.push({
    type:'meta',
    key:`${t.key}:meta${idx || ''}`,
    selectKey:t.key,
    parentKey:t.key,
    device:d,
    topo:t,
    text:`${metaPrefix}${line}`,
    selectable:false
  }));

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
      text:`${childPrefix}${nodeIsLast ? '└─' : '├─'} ${leftDevNodeLabel(d, n)}`,
      selectable:false
    });
  });
}

function collectTopoKeys(roots) {
  const keys = new Set();
  function walk(n) {
    if (!n) return;
    if (n.key) keys.add(n.key);
    for (const c of n.children || []) walk(c);
  }
  for (const r of roots || []) walk(r);
  return keys;
}

function newsReasonForDevice(d, topoKeys) {
  if (isRemovedDevice(d)) return 'Unplugged / recently removed';
  if (isAddedKey(d.key) && !topoKeys.has(d.key)) return 'New / topology pending';
  if (isAddedKey(d.key)) return 'Newly detected';
  if (!topoKeys.has(d.key) && !d.removed) return 'Not placed in topology yet';
  return '';
}

function addNewsDeviceRows(rows, d, reason, isLast) {
  const branch = isLast ? '└─' : '├─';
  const childPrefix = isLast ? '   ' : '│  ';
  rows.push({
    type:'dev',
    key:d.key,
    selectKey:d.key,
    device:d,
    text:`${branch} ${reason}: ${d.name || '(unnamed USB device)'}`,
    selectable:true
  });

  const nodes = (d.devNodes || []).map(n => n.path).sort();
  const metaPrefix = childPrefix + (nodes.length ? '│  ' : '   ');
  const lines = [
    `Bus ${d.bus}  Dev ${d.dev}  ID ${d.vid}:${d.pid}${d.devNodes && d.devNodes.length ? `  Handles ${d.devNodes.length}` : ''}`
  ];
  const rawNews = rawUsbNodeSummary(d);
  if (rawNews) lines.push(rawNews);
  if (d.kernel && d.kernel.roles && d.kernel.roles.length) lines.push(`Functions ${d.kernel.roles.join('/')}`);
  if (d.removed) lines.push('Device is no longer active; retained briefly for visibility.');

  lines.forEach((line, idx) => rows.push({
    type:'meta',
    key:`news:${d.key}:meta${idx || ''}`,
    selectKey:d.key,
    parentKey:d.key,
    device:d,
    text:`${metaPrefix}${line}`,
    selectable:false
  }));

  nodes.forEach((n, j) => rows.push({
    type:'node',
    key:`news:${d.key}:${n}`,
    selectKey:d.key,
    parentKey:d.key,
    device:d,
    text:`${childPrefix}${j === nodes.length - 1 ? '└─' : '├─'} ${leftDevNodeLabel(d, n)}`,
    selectable:false
  }));
}

function addTopNewsRows(rows, topoKeys) {
  const news = [];
  const seen = new Set();

  for (const d of state.devices) {
    const reason = newsReasonForDevice(d, topoKeys);
    if (!reason || seen.has(d.key)) continue;
    seen.add(d.key);
    news.push({ d, reason });
  }

  news.sort((a, b) => {
    const rank = r => /Unplugged/.test(r) ? 0 : /New/.test(r) ? 1 : 2;
    return rank(a.reason) - rank(b.reason) ||
      String(a.d.bus).localeCompare(String(b.d.bus)) ||
      Number(a.d.dev) - Number(b.d.dev);
  });

  if (!news.length) return;

  rows.push({ type:'bus', key:'news:top', text:'USB changes / topology pending', selectable:false });
  news.forEach((item, i) => addNewsDeviceRows(rows, item.d, item.reason, i === news.length - 1));
}

function buildRows() {
  const roots = parseLsusbTopology(state.tree);
  if (!roots.length) return buildFallbackRows();

  const deviceMap = new Map(state.devices.map(d => [d.key, d]));
  for (const r of roots) enrichTopoNode(r, deviceMap);

  const rows = [];
  const topoKeys = collectTopoKeys(roots);
  addTopNewsRows(rows, topoKeys);

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


function shortCmd(p) {
  return p.cmdline || p.command || '';
}

function handleDetailLines(d) {
  const lines = [];
  const activeNodes = d.devNodes || [];

  lines.push(bold('Handles / open processes'), '');
  lines.push('For each /dev node created by the selected USB device, this tab shows node metadata and any user-space processes that currently have that node open.');
  lines.push('Use PgUp/PgDn to scroll this pane when a device has many handles.');
  lines.push('');

  if (d.rawUsbNode || d.rawUsb) {
    lines.push(bold('Raw USB device node'));
    lines.push(`  ${d.rawUsbNode || d.rawUsb}`);
    lines.push('  This node represents the whole USB device under usbfs. libusb applications open this path directly.');
    if (d.rawUsbStat) lines.push(`  Node: ${d.rawUsbStat}`);
    if (d.rawUsbUsers) {
      const procs = d.rawUsbUsers.processes || [];
      if (procs.length) {
        lines.push('  Raw USB process holders:');
        lines.push('    PID       USER        FD(s)                 COMMAND');
        for (const p of procs) {
          const fds = (p.fds || []).map(fd => `${fd.fd}${fd.type ? '/' + fd.type : ''}${fd.match ? '[' + fd.match + ']' : ''}`).join(', ') || '?';
          lines.push(`    ${rightPadRaw(p.pid, 9)} ${rightPadRaw(p.user || '?', 11)} ${rightPadRaw(fds, 21)} ${shortCmd(p) || '?'}`);
        }
      } else {
        lines.push('  Raw USB process holders: none detected');
      }
    }
    lines.push('');
  }

  if (!activeNodes.length) {
    lines.push('No higher-level /dev handles discovered for this USB device.');
    lines.push('That is normal for vendor-specific devices controlled through the raw USB node by libusb applications.');
    return lines;
  }

  let anyProcess = false;

  activeNodes.forEach((n, idx) => {
    lines.push(bold(`${idx + 1}/${activeNodes.length}  ${n.path}`));
    lines.push(`  Type: ${friendlyDevNodeType(n)}`);
    if (n.iface) lines.push(`  Interface: ${n.iface}`);
    if (n.stat) lines.push(`  Node: ${n.stat}`);
    if (n.devIdentity && Number(n.devIdentity.rdev || 0) > 0) lines.push(`  Device ID: major/minor ${n.devIdentity.major}:${n.devIdentity.minor}`);
    if (n.input && n.input.name) {
      lines.push(`  Input name: ${n.input.name}`);
      if (devNodeShortLabel(n) === 'Generic HID input') lines.push('  Input role: generic HID collection; kernel/udev did not expose a more specific role');
    }
    if (n.video) {
      const vb = [videoShortLabel(n), n.video.driver].filter(Boolean).join(' / ');
      if (vb) lines.push(`  Video: ${vb}`);
    }

    const best = n.links.find(l => l.startsWith('/dev/serial/by-id/')) ||
      n.links.find(l => l.startsWith('/dev/v4l/by-id/')) ||
      n.links.find(l => l.startsWith('/dev/disk/by-id/')) ||
      n.links[0];

    if (best) lines.push(`  Stable name: ${best.split(' -> ')[0]}`);

    const users = n.users || {};
    const procs = users.processes || [];
    if (!procs.length) {
      lines.push('  Process holders: none detected');
      const likely = users.likelyConsumers || [];
      if (likely.length) {
        lines.push('  Likely desktop/input stack consumers:');
        lines.push('    PID       USER        COMMAND');
        for (const p of likely) {
          lines.push(`    ${rightPadRaw(p.pid, 9)} ${rightPadRaw(p.user || '?', 11)} ${shortCmd(p) || '?'}`);
        }
        lines.push('    Note: these processes may receive input through libinput/logind without holding this exact event node open.');
      }
      if (users.fuser && users.fuser.stderr && /Permission denied/i.test(users.fuser.stderr)) {
        lines.push('  Note: process detection may need sudo for full visibility.');
      }
      if (users.fuser && users.fuser.stderr && /Cannot stat/i.test(users.fuser.stderr)) {
        lines.push(`  fuser: ${users.fuser.stderr.trim()}`);
      }
      lines.push('');
      return;
    }

    anyProcess = true;
    lines.push('  Process holders:');
    lines.push('    PID       USER        FD(s)                 COMMAND');
    for (const p of procs) {
      const user = p.user || '?';
      const cmd = shortCmd(p) || '?';
      const fds = (p.fds || []).map(fd => `${fd.fd}${fd.type ? '/' + fd.type : ''}${fd.match ? '[' + fd.match + ']' : ''}`).join(', ') || '?';
      lines.push(`    ${rightPadRaw(p.pid, 9)} ${rightPadRaw(user, 11)} ${rightPadRaw(fds, 21)} ${cmd}`);
      if (p.source) lines.push(`              Found by: ${p.source}`);
    }
    const likely = users.likelyConsumers || [];
    if (likely.length) {
      lines.push('  Other likely desktop/input stack consumers:');
      for (const p of likely) lines.push(`    ${rightPadRaw(p.pid, 9)} ${rightPadRaw(p.user || '?', 11)} ${shortCmd(p) || '?'}`);
    }
    lines.push('');
  });

  lines.push(bold('Notes'));
  if (anyProcess) {
    lines.push('  A listed process has the device node open right now. That can block serial ports, cameras, HID devices, or storage operations.');
    lines.push('  Kill is intentionally manual for now. Verify the PID, then use kill PID or kill -TERM PID.');
  } else {
    lines.push('  No process currently appears to hold these /dev handles open.');
    lines.push('  That is normal for many input devices. The kernel driver can own the USB interface even when no user process has the /dev node open.');
  }
  lines.push('  Manual checks:');
  for (const n of activeNodes) {
    lines.push(`    lsof ${n.path}`);
    lines.push(`    fuser -v ${n.path}`);
  }

  return lines;
}


function driverSummaryValue(n, key) {
  return (n.props && n.props[key]) ? n.props[key] : '';
}

function driverDetailLines(d) {
  const lines = [];
  const activeNodes = d.devNodes || [];

  lines.push(bold('Driver / udev properties'), '');
  lines.push('Top summary shows every /dev handle for the selected USB device. Detailed udev properties follow below.');
  lines.push('Use PgUp/PgDn to scroll this pane.');
  lines.push('');

  if (d.rawUsbNode || d.rawUsb) {
    lines.push(bold('Raw USB device node'));
    lines.push(`  ${d.rawUsbNode || d.rawUsb}`);
    if (d.rawUsbStat) lines.push(`  Node: ${d.rawUsbStat}`);
    lines.push('');
  }

  if (!activeNodes.length) {
    lines.push('No higher-level /dev-backed udev properties found for this device.');
    lines.push('The device may still be used through the raw USB node above.');
    return lines;
  }

  lines.push(bold(`Handle summary (${activeNodes.length})`));
  lines.push('  #   NODE                    IF  SUBSYSTEM  DRIVER        KERNEL ROLE          MODEL');
  activeNodes.forEach((n, idx) => {
    const iface = driverSummaryValue(n, 'ID_USB_INTERFACE_NUM') || '-';
    const subsystem = driverSummaryValue(n, 'SUBSYSTEM') || '-';
    const driver = driverSummaryValue(n, 'ID_USB_DRIVER') || driverSummaryValue(n, 'DRIVER') || '-';
    const model = driverSummaryValue(n, 'ID_MODEL_FROM_DATABASE') || driverSummaryValue(n, 'ID_MODEL') || '-';
    lines.push(`  ${rightPadRaw(idx + 1, 3)} ${rightPadRaw(n.path, 23)} ${rightPadRaw(iface, 3)} ${rightPadRaw(subsystem, 10)} ${rightPadRaw(driver, 13)} ${rightPadRaw(devNodeKernelLabel(n) || '-', 20)} ${model}`);
  });
  lines.push('');

  const keyGroups = [
    ['Core', ['SUBSYSTEM','DEVTYPE','ID_BUS','ID_USB_DRIVER','DRIVER','ID_USB_INTERFACE_NUM']],
    ['Identity', ['ID_VENDOR','ID_VENDOR_FROM_DATABASE','ID_VENDOR_ID','ID_MODEL','ID_MODEL_FROM_DATABASE','ID_MODEL_ID','ID_SERIAL','ID_SERIAL_SHORT']],
    ['Path', ['ID_PATH','DEVPATH','TAGS']]
  ];

  activeNodes.forEach((n, idx) => {
    lines.push(bold(`${idx + 1}/${activeNodes.length}  ${n.path}`));

    if (n.kernel) {
      lines.push('  Kernel:');
      if (n.kernel.role) lines.push(`    ${rightPadRaw('ROLE', 24)} ${n.kernel.role}`);
      if (n.kernel.name) lines.push(`    ${rightPadRaw('NAME', 24)} ${n.kernel.name}`);
      if (n.kernel.inputNumber) lines.push(`    ${rightPadRaw('INPUT_NUMBER', 24)} ${n.kernel.inputNumber}`);
      if (n.kernel.hidraw) lines.push(`    ${rightPadRaw('HIDRAW', 24)} ${n.kernel.hidraw}`);
    }

    for (const [groupName, keys] of keyGroups) {
      const present = keys.filter(k => n.props[k]);
      if (!present.length) continue;
      lines.push(`  ${groupName}:`);
      for (const k of present) {
        lines.push(`    ${rightPadRaw(k, 24)} ${n.props[k]}`);
      }
    }

    const extraKeys = Object.keys(n.props || {})
      .filter(k => /^ID_INPUT|^ID_FOR_SEAT|^USEC_INITIALIZED|^MAJOR$|^MINOR$|^DEVNAME$/.test(k))
      .sort();

    if (extraKeys.length) {
      lines.push('  Extra:');
      for (const k of extraKeys) {
        lines.push(`    ${rightPadRaw(k, 24)} ${n.props[k]}`);
      }
    }

    lines.push('');
  });

  return lines;
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
    if (d.rawUsbNode || d.rawUsb) {
      lines.push(`Raw USB node: ${d.rawUsbNode || d.rawUsb}`);
      if (d.rawUsbStat) lines.push(`Raw USB stat: ${d.rawUsbStat}`);
    }
    if (d.kernel) {
      if (d.kernel.manufacturer && d.kernel.manufacturer !== d.name) lines.push(`Kernel manufacturer: ${d.kernel.manufacturer}`);
      if (d.kernel.product) lines.push(`Kernel product: ${d.kernel.product}`);
      if (d.kernel.bcdDevice) lines.push(`USB bcdDevice: ${d.kernel.bcdDevice}`);
      if (d.kernel.roles && d.kernel.roles.length) lines.push(`Kernel HID roles: ${d.kernel.roles.join(', ')}`);
      const hidraws = (d.kernel.hidraw || []).map(h => h.path).filter(Boolean);
      if (hidraws.length) lines.push(`Kernel hidraw nodes: ${hidraws.join(', ')}`);
    }
    lines.push('');
    lines.push(bold('Detected /dev handles'));
    if (activeNodes.length) for (const n of activeNodes) lines.push(`  ${n.path}  ${n.iface ? '(' + n.iface + ')' : ''}  ${friendlyDevNodeType(n)}`);
    else lines.push('  None found. Root hubs and some internal devices may not create user-facing /dev nodes.');
    lines.push('');
    lines.push(...suggestions(d));

  } else if (state.tab === 1) {
    lines.push(bold('/dev nodes and stable names'), '');
    if (d.rawUsbNode || d.rawUsb) {
      lines.push(bold('Raw USB device node'));
      lines.push(`  ${d.rawUsbNode || d.rawUsb}`);
      lines.push('  This exists for the whole USB device. libusb-style applications can open this even when no tty/video/input/storage node exists.');
      if (d.rawUsbStat) lines.push(`  Node: ${d.rawUsbStat}`);
      lines.push('');
    }
    if (!activeNodes.length) lines.push('No higher-level /dev nodes discovered for this USB device.');
    for (const n of activeNodes) {
      lines.push(bold(n.path));
      lines.push(`  Type: ${friendlyDevNodeType(n)}`);
      if (n.iface) lines.push(`  Interface: ${n.iface}`);
      if (n.kernel && n.kernel.role) lines.push(`  Kernel role: ${n.kernel.role}`);
      if (n.kernel && n.kernel.hidraw) lines.push(`  Kernel hidraw: ${n.kernel.hidraw}`);
      if (n.kernel && n.kernel.name) lines.push(`  Kernel name: ${n.kernel.name}`);
      if (n.input) {
        if (n.input.name) lines.push(`  Input name: ${n.input.name}`);
        if (devNodeShortLabel(n) === 'Generic HID input') lines.push('  Input role: generic HID collection; kernel/udev did not expose a more specific role');
        if (n.input.phys) lines.push(`  Input phys: ${n.input.phys}`);
      }
      if (n.video) {
        if (n.video.role) lines.push(`  Video role: ${n.video.role}`);
        if (n.video.name) lines.push(`  Video name: ${n.video.name}`);
        if (n.video.driver) lines.push(`  Video driver: ${n.video.driver}`);
        if (n.video.card) lines.push(`  Video card: ${n.video.card}`);
        if (n.video.bus) lines.push(`  Video bus: ${n.video.bus}`);
        if (n.video.formats && n.video.formats.length) lines.push(`  Video formats: ${n.video.formats.join(', ')}`);
      }
      if (n.stat) lines.push(`  Node: ${n.stat}`);
      const best = n.links.find(l => l.startsWith('/dev/serial/by-id/')) ||
        n.links.find(l => l.startsWith('/dev/v4l/by-id/')) ||
        n.links.find(l => l.startsWith('/dev/disk/by-id/')) ||
        n.links[0];
      if (best) lines.push(`  Best stable name: ${best.split(' -> ')[0]}`);
      if (n.links.length) {
        lines.push('  Symlinks:');
        for (const l of n.links) lines.push(`    ${l}`);
      }
      if (n.block) lines.push(`  Block: ${n.block.type || ''} ${n.block.size || ''} ${n.block.fstype || ''} ${n.block.label || ''} ${(n.block.mountpoints || []).filter(Boolean).join(',')}`);
      lines.push('');
    }

  } else if (state.tab === 2) {
    lines.push(...handleDetailLines(d));

  } else if (state.tab === 3) {
    lines.push(...driverDetailLines(d));

  } else if (state.tab === 4) {
    lines.push(bold('Recent relevant kernel clues'), '');
    let relevant = d.kernel && d.kernel.lines && d.kernel.lines.length ? d.kernel.lines.slice(-60) : [];
    if (!relevant.length) {
      relevant = state.lastKernel.filter(l => l.includes(`${Number(d.bus)}-`) || l.toLowerCase().includes((d.name || '').split(' ')[0]?.toLowerCase() || '___') || /usb|ttyUSB|ttyACM|disconnect|attached/i.test(l)).slice(-50);
    }
    if (!relevant.length) lines.push('No recent matching kernel lines in dmesg tail.');
    else lines.push(...relevant);

  } else if (state.tab === 5) {
    const targets = sniffableNodesForDevice(d);
    if (state.sniff.targetIndex >= targets.length) state.sniff.targetIndex = Math.max(0, targets.length - 1);
    const target = selectedSniffTarget(d);

    lines.push(bold('Raw USB / device-node sniffer'), '');
    lines.push('This is a first-pass byte viewer. Press o to open/close the selected node. Press [ or ] to choose a sniff target.');
    lines.push('Raw /dev/bus/usb nodes are usbfs control endpoints, not a passive bus tap; many devices will show little or nothing on read.');
    lines.push('Input event, mouse, and hidraw nodes are better first sniff targets because they stream kernel-decoded reports.');
    lines.push('');
    lines.push('Basic identity:');
    lines.push(`  Bus ${d.bus} Device ${d.dev}: ID ${d.vid}:${d.pid} ${d.name}`);
    lines.push(`  Descriptor command: lsusb -v -s ${Number(d.bus)}:${Number(d.dev)}`);
    if (d.rawUsbNode || d.rawUsb) {
      lines.push(`  Raw USB node: ${d.rawUsbNode || d.rawUsb}`);
      if (d.rawUsbStat) lines.push(`  ${d.rawUsbStat}`);
    }
    lines.push('');
    lines.push(bold('Sniff targets'));
    if (!targets.length) {
      lines.push('  No raw/input/hidraw target available for this selected device.');
    } else {
      targets.forEach((t, idx) => {
        const marker = target && t.path === target.path ? '>' : ' ';
        const live = state.sniff.active && state.sniff.path === t.path ? '  OPEN' : '';
        lines.push(`  ${marker} ${idx + 1}. ${t.path}  ${t.kind}${live}`);
      });
    }
    lines.push('');
    lines.push(bold('Sniffer status'));
    lines.push(`  State: ${state.sniff.opening ? 'opening' : state.sniff.active ? 'open/read loop active' : 'closed'}`);
    if (state.sniff.path) lines.push(`  Node: ${state.sniff.path}`);
    if (state.sniff.kind) lines.push(`  Kind: ${state.sniff.kind}`);
    lines.push(`  Reads: ${state.sniff.reads || 0}   Bytes: ${state.sniff.bytes || 0}`);
    if (state.sniff.error) lines.push(`  Last error: ${state.sniff.error}`);
    lines.push('');
    lines.push(bold('Received bytes'));
    const sniffLines = state.sniff.lines || [];
    if (!sniffLines.length) lines.push('  No bytes yet. Open a node, then move/click/type/use the selected USB device.');
    else for (const l of sniffLines.slice(-220)) lines.push(`  ${l}`);
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
  } else if (nodes.some(n => /event\d+$/.test(n.path) || /hidraw\d+$/.test(n.path))) {
    lines.push('  HID/input device: kernel lines can identify keyboard, mouse, consumer-control, system-control, and hidraw functions.');
    lines.push('  For stable matching, prefer ID_PATH/DEVPATH over event numbers because /dev/input/eventN can change after replug.');
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


function titleHelpLine() {
  const title = cyan(APP_TITLE);
  if (!state.showKeys) return `${title} —  press k for keyboard mappings`;

  return `${title} —  Keys: ↑/↓ select USB device/hub  ←/→ tabs  PgUp/PgDn details  Ctrl+↑/↓ tree  1-6 tabs  o open/close sniffer  [/] target  r refresh  k hide keys  q quit`;
}

function render() {
  pruneHighlights();

  if (!state.lastPollAt && !state.devices.length) {
    const { cols, rows } = termSize();
    let out = '\x1b[?25l\x1b[H';
    out += pad(cyan(APP_TITLE + ' '), cols) + '\n';
    out += '─'.repeat(cols) + '\n';
    out += '\n';
    out += pad(state.startupMessage, cols) + '\n';
    out += '\n';
    out += pad('Gathering USB topology from lsusb -t...', cols) + '\n';
    out += pad('Enumerating /dev handles...', cols) + '\n';
    out += pad('Querying udev properties...', cols) + '\n';
    out += pad('Scanning process handles...', cols) + '\n';
    out += '\x1b[J';
    process.stdout.write(out);
    return;
  }

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
  out += pad(titleHelpLine(), cols) + '\n';
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
  out += pad((state.status || ''), cols) + '\x1b[J';
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
  if (row.type === 'node' || row.type === 'meta') return dim(cell);
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
let didCleanup = false;
function cleanup() {
  if (didCleanup) return;
  didCleanup = true;
  if (state.sniff && state.sniff.fd !== null && state.sniff.fd !== undefined) {
    try { fs.closeSync(state.sniff.fd); } catch {}
    state.sniff.fd = null;
    state.sniff.active = false;
  }
  leaveTuiScreen();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
function handleInput(buf) {
  const s = buf.toString('utf8');

  // Mouse selection remains disabled, but terminals may still send wheel packets.
  // Consume them so the terminal does not scroll the normal scrollback and smear
  // old frames above the TUI.
  const wheel = mouseWheelDelta(s);
  if (wheel) { scrollDetail(wheel); return; }
  if (/\x1b\[<\d+;\d+;\d+[mM]/.test(s)) return;

  if (s === '\u0003' || s === 'q') { cleanup(); process.exit(0); }
  if (s === 'r') { poll(true); return; }
  if (s === 'k' || s === 'K') { state.showKeys = !state.showKeys; render(); return; }
  if (s === 'o' || s === 'O') { if (state.tab !== 5) state.tab = 5; toggleSniffer(); return; }
  if (s === '[') { if (state.tab !== 5) state.tab = 5; cycleSniffTarget(-1); return; }
  if (s === ']') { if (state.tab !== 5) state.tab = 5; cycleSniffTarget(1); return; }
  if (s === 'j' || s === '\x1b[B') { selectDelta(1); return; }
  if (s === '\x1b[A') { selectDelta(-1); return; }
  if (s === '\x1b[C') { setTab(state.tab + 1); return; }
  if (s === '\x1b[D') { setTab(state.tab - 1); return; }
  if (s === '\x1b[6~') { scrollDetail(10); return; }
  if (s === '\x1b[5~') { scrollDetail(-10); return; }
  if (s === '\x1b[1;5B') { scrollLeft(5); return; }
  if (s === '\x1b[1;5A') { scrollLeft(-5); return; }
  if (/^[1-6]$/.test(s)) { setTab(Number(s) - 1); return; }

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
  }

  enterTuiScreen();
  render();
  await poll(true);
  setInterval(() => poll(false), POLL_MS);
  setInterval(() => {
    if (pruneHighlights()) render();
  }, 250);
}
main().catch(e => { cleanup(); console.error(e); process.exit(1); });
