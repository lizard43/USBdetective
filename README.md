# USB Detective

USB Detective is a keyboard-driven Linux USB exploration, troubleshooting, and forensics utility.

It answers questions such as:

- What USB device did Linux just detect?
- Which driver attached to it?
- What `/dev` nodes were created?
- What process currently has the device open?
- Where is the device physically connected in the USB topology?
- What stable device path should I use instead of `/dev/ttyUSB0`?

USB Detective correlates information from:

- `lsusb`
- `lsusb -t`
- `udevadm`
- `dmesg`
- `/dev`
- `lsblk`
- `lsof`
- `fuser`
- `/proc/*/fd`

into a single terminal interface.

![USB Detective](docs/usbdetective.png)

The interface is split into:

- Left pane: USB topology tree
- Right pane: Device details
- Status bar: refresh status and device counts

---

# Features

## USB Topology Tree

Displays the real USB hierarchy from `lsusb -t`.

Example:

```text
USB Bus 001
└─ Linux Foundation 2.0 root hub
   ├─ FTDI Dual UART/FIFO IC
   │  ├─ /dev/ttyUSB0
   │  └─ /dev/ttyUSB1
   ├─ Syntek EasyCamera
   │  ├─ /dev/video0
   │  └─ /dev/video1
   └─ Xbox360 Controller
      └─ /dev/input/event15
```

The tree shows:

- Root hubs
- External hubs
- USB devices
- USB speed
- Driver names
- USB classes
- Associated `/dev` handles

---

## Device Correlation

USB Detective correlates USB devices with Linux device nodes.

Examples:

| USB Device | Linux Node |
|------------|------------|
| FTDI Adapter | `/dev/ttyUSB0` |
| Arduino | `/dev/ttyACM0` |
| Webcam | `/dev/video0` |
| Game Controller | `/dev/input/event15` |
| Flash Drive | `/dev/sdb` |

---

## Process Handle Detection

The Handles tab shows which processes currently have a device open.

Examples:

```text
/dev/ttyUSB0

PID     USER      COMMAND
1223    d         node server.js
```
or

```text
/dev/video0

PID     USER      COMMAND
9821    d         ffplay
```

Useful for:

- Serial ports already in use
- Cameras already opened
- Storage devices locked by another process
- Finding unexpected applications using hardware

---

## Stable Device Paths

USB Detective searches common stable path locations:

```text
/dev/serial/by-id
/dev/serial/by-path
/dev/v4l/by-id
/dev/v4l/by-path
/dev/disk/by-id
/dev/disk/by-label
/dev/disk/by-uuid
```

Example:

```text
/dev/ttyUSB0

Best stable name:

/dev/serial/by-id/usb-FTDI_Dual_RS232-HS-if00-port0
```

---

# Requirements

## Required

```bash
sudo apt install \
    nodejs \
    usbutils \
    util-linux \
    udev
```

## Strongly Recommended

```bash
sudo apt install \
    lsof \
    psmisc
```

`psmisc` provides:

```text
fuser
```

which improves handle detection.

## Optional

```bash
sudo apt install v4l-utils
```

Provides:

```text
v4l2-ctl
```

for camera inspection.

---

# Running

```bash
node usbdetective.js
```

or

```bash
chmod +x usbdetective.js
./usbdetective.js
```

---

# User Interface

## Left Pane

The left pane displays the USB topology tree.

Navigation is device-centric.

USB devices are selectable.

Child `/dev` nodes are informational and belong to the parent USB device.

---

## Right Pane

The right pane displays details about the selected USB device.

Current tabs:

```text
Summary
/dev
Handles
Driver
Kernel
Raw USB
```

---

# Tab Reference

## Summary

Overview of the selected device.

Displays:

- Status
- Bus number
- Device number
- VID/PID
- Device name
- Detected handles
- Suggested next actions

---

## /dev

Displays Linux device node information.

Examples:

```text
/dev/ttyUSB0
/dev/video0
/dev/input/event15
```

Includes:

- Node type
- Interface mapping
- Permissions
- Stable paths
- Symlinks
- Storage information

---

## Handles

Displays processes currently using device nodes.

Sources:

```text
lsof
fuser
/proc/*/fd
```

Useful for:

- Busy serial ports
- Busy cameras
- Locked devices

---

## Driver

Displays selected udev metadata.

Examples:

```text
ID_USB_DRIVER
ID_SERIAL
ID_VENDOR
ID_MODEL
ID_PATH
DEVPATH
```

Useful when determining why Linux created a specific device node.

---

## Kernel

Displays recent USB-related kernel messages.

Examples:

```text
device attached
device detached
driver binding
converter attached
```

Derived from:

```bash
dmesg
```

---

## Raw USB

Provides descriptor inspection commands.

Example:

```bash
lsusb -v -s 1:9
```

Useful for deep USB analysis.

---

# Keyboard Controls

| Key | Action |
|------|---------|
| Up | Previous USB device |
| Down | Next USB device |
| Left | Previous tab |
| Right | Next tab |
| PgUp | Scroll detail pane up |
| PgDn | Scroll detail pane down |
| 1-6 | Select tab directly |
| k | Toggle keyboard help |
| r | Refresh |
| q | Quit |
| Ctrl+C | Quit |

---

# Environment Variables

```text
USB_DETECTIVE_POLL_MS
USB_DETECTIVE_COLOR
USB_DETECTIVE_KEEP_REMOVED_MS
USB_DETECTIVE_HIGHLIGHT_MS
```

Examples:

```bash
USB_DETECTIVE_POLL_MS=500 node usbdetective.js
```

```bash
USB_DETECTIVE_COLOR=0 node usbdetective.js
```

---

# Typical Workflows

## Which Serial Port Did My Board Become?

1. Plug in device
2. Refresh
3. Select device
4. Open `/dev` tab

Example result:

```text
/dev/ttyACM0
```

---

## What Process Has My Serial Port Open?

1. Select FTDI or Arduino device
2. Open Handles tab

Example:

```text
PID 3344
node capture.js
```

---

## Why Won't My Webcam Open?

1. Select camera
2. Open Handles tab

Example:

```text
PID 9981
ffplay
```

---

## Which USB Port Is This Connected To?

Use the topology tree.

Example:

```text
Root Hub
 └─ Hub
     └─ Camera
```

---

# Device Examples

## FTDI Dual UART

```text
/dev/ttyUSB0
/dev/ttyUSB1
```

Typical mapping:

```text
Interface 00 -> Channel A
Interface 01 -> Channel B
```

---

## USB Camera

```text
/dev/video0
/ dev/video1
```

Inspect formats:

```bash
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

---

## Storage Devices

```text
/dev/sdb
/dev/sdb1
```

Inspect:

```bash
lsblk -f
```

---

## HID Devices

```text
/dev/input/event*
/dev/hidraw*
```

Examples:

- keyboards
- mice
- gamepads
- wireless receivers

---

# Known Limitations

- Polling based (default 1 second)
- Requires ANSI terminal support
- Some kernel logs require elevated permissions
- Not all USB devices create `/dev` nodes
- Some metadata depends on udev availability
- Handle visibility may depend on permissions

---

# Why USB Detective?

Linux already provides excellent tools:

- lsusb
- lsusb -t
- udevadm
- dmesg
- lsblk
- lsof
- fuser

The challenge is correlation.

USB Detective brings these data sources together and presents them in a single interface designed for hardware debugging, embedded development, cameras, serial adapters, storage devices, arcade hardware, and general Linux troubleshooting.
