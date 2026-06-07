# USB Detective

USB Detective is a terminal-based USB exploration and troubleshooting tool for Linux.

Unlike `lsusb`, USB Detective correlates:

* USB bus devices (`lsusb`)
* Linux device nodes (`/dev/ttyUSB*`, `/dev/video*`, `/dev/sd*`, etc.)
* udev metadata
* stable `/dev/.../by-id` symlinks
* storage information (`lsblk`)
* kernel USB activity (`dmesg`)
* USB topology (`lsusb -t`)

and presents everything in a live file-explorer style interface.

---

## Features

### Live USB Topology View

Devices are grouped by USB bus and displayed in a tree:

```text
USB Bus 001
├─ FTDI Dual RS232-HS
│  ├─ /dev/ttyUSB0
│  └─ /dev/ttyUSB1
│
├─ Logitech Webcam
│  └─ /dev/video0
│
└─ USB Flash Drive
   ├─ /dev/sdb
   └─ /dev/sdb1
```

### Automatic Device Detection

USB Detective continuously scans for:

* device insertions
* device removals
* USB bus changes
* newly created `/dev` nodes

### Visual Change Highlighting

New devices:

* highlighted green
* remain highlighted for several seconds

Removed devices:

* highlighted red
* remain visible briefly
* then disappear

### Device Intelligence

USB Detective automatically identifies:

| Device Type    | Examples                     |
| -------------- | ---------------------------- |
| Serial Devices | FTDI, CP210x, CH340, Arduino |
| Cameras        | UVC webcams, capture devices |
| Storage        | USB flash drives, SSDs       |
| HID Devices    | Keyboards, mice, gamepads    |
| Input Devices  | Linux event devices          |

### Stable Device Names

Automatically discovers:

```text
/dev/serial/by-id/
/dev/serial/by-path/
/dev/disk/by-id/
/dev/v4l/by-id/
```

Useful for applications where `/dev/ttyUSB0` may change.

---

# Requirements

Linux system with:

* NodeJS 18+
* lsusb
* udevadm
* lsblk
* dmesg

Optional:

* v4l-utils

Install:

```bash
sudo apt install usbutils util-linux udev
sudo apt install v4l-utils
```

---

# Running

```bash
chmod +x usbdetective.js
./usbdetective.js
```

or

```bash
node usbdetective.js
```

---

# Keyboard Controls

| Key    | Action                 |
| ------ | ---------------------- |
| Up     | Select previous device |
| Down   | Select next device     |
| j      | Select next device     |
| k      | Select previous device |
| PgUp   | Scroll details up      |
| PgDn   | Scroll details down    |
| [      | Previous tab           |
| ]      | Next tab               |
| 1      | Summary tab            |
| 2      | /dev tab               |
| 3      | Topology tab           |
| 4      | Driver tab             |
| 5      | Kernel tab             |
| 6      | Raw USB tab            |
| r      | Refresh                |
| q      | Quit                   |
| Ctrl+C | Quit                   |

---

# Mouse Controls

### Left Pane

Click any USB device to select it.

### Detail Pane

Mouse wheel scrolls detail content.

---

# Detail Tabs

## Summary

General device overview.

Includes:

* USB bus/device numbers
* VID/PID
* device name
* detected `/dev` nodes
* recommended next actions

---

## /dev

Displays:

* device nodes
* interface mapping
* permissions
* stable symlink names

Example:

```text
/dev/ttyUSB0
/dev/serial/by-id/usb-FTDI...
```

---

## Topology

Displays:

```bash
lsusb -t
```

Useful for determining:

* hubs
* ports
* parent relationships

---

## Driver

Displays:

* udev properties
* driver information
* interface numbers
* USB paths

---

## Kernel

Displays recent USB-related kernel messages from:

```bash
dmesg
```

---

## Raw USB

Displays commands and identifiers useful for:

```bash
lsusb -v
```

deep investigation.

---

# Environment Variables

| Variable                      | Default | Description                |
| ----------------------------- | ------- | -------------------------- |
| USB_DETECTIVE_POLL_MS         | 1000    | Refresh interval           |
| USB_DETECTIVE_KEEP_REMOVED_MS | 4500    | Red removal hold time      |
| USB_DETECTIVE_HIGHLIGHT_MS    | 5000    | Green new-device highlight |
| USB_DETECTIVE_COLOR           | 1       | Enable ANSI colors         |

Example:

```bash
USB_DETECTIVE_POLL_MS=500 ./usbdetective.js
```

---

# Device Matching Strategy

USB Detective correlates information from:

1. lsusb
2. udevadm
3. /dev device nodes
4. lsblk

Matching uses:

* BUSNUM / DEVNUM
* VID/PID
* udev metadata

This allows USB Detective to associate:

```text
Bus 001 Device 009
      ↓
FTDI Dual RS232-HS
      ↓
/dev/ttyUSB0
/dev/ttyUSB1
```

---

# Troubleshooting

## Device Appears In lsusb But Not In USB Detective

Press:

```text
r
```

to force refresh.

---

## No USB Events Detected

Verify:

```bash
lsusb
```

changes when plugging devices.

---

## Serial Permission Errors

Check:

```bash
groups $USER
```

and ensure membership in:

```text
dialout
plugdev
```

---

## Camera Information Missing

Install:

```bash
sudo apt install v4l-utils
```

---

# Typical Use Cases

### Arduino Development

Find:

```text
/dev/ttyACM0
```

and stable names.

### Arcade Hardware

Identify:

```text
FTDI
CH340
CP210x
```

serial adapters connected to test rigs.

### Webcam Troubleshooting

Locate:

```text
/dev/video0
```

and inspect device details.

### USB Storage Analysis

Determine:

* mountpoints
* labels
* filesystem types

---

# Future Ideas

* USB bandwidth monitoring
* Live serial terminal
* Descriptor decoding
* Hub port numbering
* Device history timeline
* Export to JSON
* Search/filter
* USB power reporting
* PCI USB controller information
* Device compare mode
