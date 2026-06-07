# USB Detective

USB Detective is a terminal-based USB exploration and troubleshooting tool for Linux.

It is meant to answer the question:

> “I just plugged something in. What did Linux actually see, what `/dev` nodes appeared, what driver owns it, and what should I use next?”

Unlike plain `lsusb`, USB Detective correlates:

* USB bus devices from `lsusb`
* Linux device nodes such as `/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/video*`, `/dev/sd*`, `/dev/input/event*`
* udev metadata from `udevadm`
* stable `/dev/.../by-id` symlinks
* block/storage information from `lsblk`
* recent kernel USB activity from `dmesg`
* USB topology from `lsusb -t`

It presents everything in a live, file-explorer-style terminal UI.

---

## Current Status

USB Detective is currently a **single-file NodeJS TUI** with no npm dependencies.

It is designed for Linux Mint and other Linux desktop systems with standard USB tools installed.

The current UI is a two-pane layout:

```text
USB Bus 001                         [Summary]  /dev  Topology  Driver  Kernel  Raw USB
├─ 001:003 Xbox360 Controller       selected device details...
│  └─ /dev/event15
├─ 001:004 Syntek EasyCamera
│  ├─ /dev/video0
│  └─ /dev/video1
└─ 001:009 FTDI Dual RS232-HS
   ├─ /dev/ttyUSB0
   └─ /dev/ttyUSB1
```

---

## Features

### Live USB Tree View

Devices are grouped by USB bus and displayed as a tree.

Example:

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

The parent row represents the USB bus device from `lsusb`.

The child rows represent Linux `/dev` nodes matched to that USB device.

---

### Automatic Device Detection

USB Detective continuously polls for:

* USB insertions
* USB removals
* USB bus changes
* newly created `/dev` nodes
* removed `/dev` nodes

Default polling interval:

```bash
USB_DETECTIVE_POLL_MS=1000
```

---

### Visual Change Highlighting

Newly attached devices are highlighted green for several seconds.

Recently removed devices are highlighted red, remain visible briefly, and then disappear from the tree.

Color meaning:

| Color | Meaning |
|---|---|
| Blue | Currently selected USB device |
| Green | Newly attached USB device |
| Red | Recently removed USB device |

---

### Device Intelligence

USB Detective attempts to recognize and describe common USB classes:

| Device Type | Examples |
|---|---|
| USB serial adapters | FTDI, CH340, CP210x, PL2303 |
| Development boards | Arduino, serial bootloaders, CDC ACM boards |
| Cameras | UVC webcams, microscope cameras, capture devices |
| Storage | USB flash drives, card readers, SSDs |
| HID/input devices | Keyboards, mice, gamepads, receivers |
| Bluetooth radios | Internal or external USB Bluetooth |
| Hubs | USB 2.0/3.0 hubs and root hubs |

---

### Stable Device Names

USB Detective searches common stable-name directories:

```text
/dev/serial/by-id/
/dev/serial/by-path/
/dev/disk/by-id/
/dev/disk/by-label/
/dev/disk/by-uuid/
/dev/v4l/by-id/
/dev/v4l/by-path/
```

This is especially useful when `/dev/ttyUSB0` or `/dev/video0` can change between boots or plug order.

For serial devices, prefer a stable path like:

```text
/dev/serial/by-id/usb-FTDI_Dual_RS232-HS-if00-port0
```

instead of:

```text
/dev/ttyUSB0
```

---

## Requirements

Required:

* Linux
* NodeJS 18+
* `lsusb`
* `udevadm`
* `lsblk`
* `dmesg`

Recommended:

* `v4l-utils` for deeper camera inspection

Install common dependencies on Linux Mint / Ubuntu:

```bash
sudo apt install nodejs usbutils util-linux udev
```

Optional camera tooling:

```bash
sudo apt install v4l-utils
```

---

## Running

Make executable:

```bash
chmod +x usbdetective.js
```

Run:

```bash
./usbdetective.js
```

or:

```bash
node usbdetective.js
```

---

## UI Layout

### Left Pane: USB Tree

The left pane shows:

* USB buses
* USB devices
* matched `/dev` nodes under each device

Example:

```text
USB Bus 001
├─ 001:003 045e:028e Microsoft Corp. Xbox360 Controller
│  └─ /dev/event15
├─ 001:004 174f:2414 Syntek EasyCamera
│  ├─ /dev/video0
│  └─ /dev/video1
```

The parent line contains:

```text
bus:device VID:PID device name
```

Example:

```text
001:004 174f:2414 Syntek EasyCamera
```

Child lines contain detected `/dev` handles:

```text
/dev/video0
/dev/video1
```

---

### Right Pane: Detail Tabs

The right pane shows details for the selected USB device.

Tabs:

```text
Summary  /dev  Topology  Driver  Kernel  Raw USB
```

Tabs are selected with keyboard shortcuts.

Some versions may support mouse tab clicking, but keyboard tab control is the reliable method.

---

## Selection Model

Selection is device-oriented.

Keyboard Up/Down selects USB **device rows**.

Child `/dev` rows represent handles owned by the parent USB device.

Clicking or selecting a child `/dev` row should show information for its parent USB device.

Example:

```text
Microsoft Corp. Xbox360 Controller
└─ /dev/event15
```

The USB device is:

```text
001:003 045e:028e Microsoft Corp. Xbox360 Controller
```

The Linux input handle is:

```text
/dev/input/event15
```

---

## Keyboard Controls

| Key | Action |
|---|---|
| Up | Select previous USB device |
| Down | Select next USB device |
| j | Select next USB device |
| k | Select previous USB device |
| PgUp | Scroll right-side details up |
| PgDn | Scroll right-side details down |
| [ | Previous detail tab |
| ] | Next detail tab |
| 1 | Summary tab |
| 2 | `/dev` tab |
| 3 | Topology tab |
| 4 | Driver tab |
| 5 | Kernel tab |
| 6 | Raw USB tab |
| r | Refresh immediately |
| q | Quit |
| Ctrl+C | Quit |

Some builds may also support:

| Key | Action |
|---|---|
| Ctrl+Up | Scroll left tree up |
| Ctrl+Down | Scroll left tree down |

---

## Mouse Controls

Mouse support depends on terminal compatibility.

### Left Pane

| Action | Behavior |
|---|---|
| Click USB device row | Select that USB device |
| Click child `/dev` row | Select the parent USB device |
| Mouse wheel | Scroll left tree when pointer is over left pane |

### Right Pane

| Action | Behavior |
|---|---|
| Mouse wheel | Scroll detail text |

### Tabs

Keyboard tab selection is preferred:

```text
[ ] and 1-6
```

Mouse tab click support may be present depending on the current build and terminal mouse reporting behavior.

---

## Detail Tabs

### Summary

The Summary tab gives a quick overview.

Includes:

* active/removed status
* bus number
* device number
* VID/PID
* USB device name
* detected `/dev` handles
* likely next step

Example:

```text
001:004  174f:2414  Syntek EasyCamera

Status: active
Bus: 001
Device number: 004
Vendor/Product ID: 174f:2414
Name: Syntek EasyCamera

Detected /dev handles
  /dev/video0
  /dev/video1
```

---

### `/dev`

The `/dev` tab focuses on Linux device nodes.

It may show:

* node path
* type
* interface mapping
* file permissions
* best stable symlink
* all matching symlinks
* block device metadata for storage

Example:

```text
/dev/ttyUSB0
  Type: USB serial adapter
  Interface: Channel A / interface 0
  Best stable name: /dev/serial/by-id/usb-FTDI_Dual_RS232-HS-if00-port0
```

---

### Topology

The Topology tab displays the current USB topology from:

```bash
lsusb -t
```

Useful for seeing:

* hub hierarchy
* port placement
* speeds
* active drivers

---

### Driver

The Driver tab shows selected udev properties.

Useful fields include:

* `SUBSYSTEM`
* `DEVTYPE`
* `ID_USB_DRIVER`
* `ID_VENDOR`
* `ID_MODEL`
* `ID_VENDOR_ID`
* `ID_MODEL_ID`
* `ID_SERIAL`
* `ID_SERIAL_SHORT`
* `ID_USB_INTERFACE_NUM`
* `ID_PATH`
* `DEVPATH`

This is often the best tab for understanding why Linux created a particular `/dev` node.

---

### Kernel

The Kernel tab shows recent USB-related kernel messages from `dmesg`.

Useful for:

* attach events
* detach events
* driver binding
* serial converter attachment
* storage probing
* camera detection

Example kernel lines may include:

```text
usb 1-1.3: New USB device found, idVendor=0403, idProduct=6010
ftdi_sio 1-1.3:1.0: FTDI USB Serial Device converter detected
usb 1-1.3: FTDI USB Serial Device converter now attached to ttyUSB0
```

---

### Raw USB

The Raw USB tab gives the useful command for deeper descriptor inspection:

```bash
lsusb -v -s BUS:DEVICE
```

Example:

```bash
lsusb -v -s 1:9
```

Some USB descriptor reads require elevated permissions.

---

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `USB_DETECTIVE_POLL_MS` | `1000` | Poll interval in milliseconds |
| `USB_DETECTIVE_KEEP_REMOVED_MS` | `4500` | How long removed devices stay red before disappearing |
| `USB_DETECTIVE_HIGHLIGHT_MS` | `5000` | How long newly attached devices stay green |
| `USB_DETECTIVE_COLOR` | `1` | Set to `0` to disable ANSI colors |

Examples:

```bash
USB_DETECTIVE_POLL_MS=500 ./usbdetective.js
```

```bash
USB_DETECTIVE_COLOR=0 ./usbdetective.js
```

```bash
USB_DETECTIVE_KEEP_REMOVED_MS=8000 USB_DETECTIVE_HIGHLIGHT_MS=8000 ./usbdetective.js
```

---

## Device Matching Strategy

USB Detective correlates data from several Linux sources.

### 1. `lsusb`

Provides:

* bus number
* device number
* VID/PID
* USB display name

Example:

```text
Bus 001 Device 009: ID 0403:6010 Future Technology Devices International, Ltd FT2232C/D/H Dual UART/FIFO IC
```

---

### 2. `udevadm`

Provides:

* `/dev` node metadata
* USB interface number
* driver
* serial number
* vendor/model IDs
* device path

Example:

```bash
udevadm info --query=property --name=/dev/ttyUSB0
```

---

### 3. `/dev`

USB Detective scans common USB-created device nodes:

```text
/dev/ttyUSB*
/dev/ttyACM*
/dev/video*
/dev/hidraw*
/dev/sd*
/dev/nvme*
/dev/input/event*
```

---

### 4. `lsblk`

For storage devices, `lsblk` provides:

* block device type
* size
* filesystem
* label
* serial
* mountpoints

---

### Matching Fields

Matching is based primarily on:

* BUSNUM / DEVNUM
* VID/PID
* udev metadata
* realpath matching for symlinks

Example correlation:

```text
Bus 001 Device 009
      ↓
VID:PID 0403:6010
      ↓
FTDI Dual RS232-HS
      ↓
/dev/ttyUSB0
/dev/ttyUSB1
      ↓
/dev/serial/by-id/usb-FTDI_Dual_RS232-HS-if00-port0
/dev/serial/by-id/usb-FTDI_Dual_RS232-HS-if01-port0
```

---

## Device Examples

### FTDI FT2232H Dual Serial Adapter

Expected tree:

```text
USB Bus 001
└─ 001:009 0403:6010 FTDI Dual RS232-HS
   ├─ /dev/ttyUSB0
   └─ /dev/ttyUSB1
```

Typical interpretation:

```text
Channel A / interface 0 -> /dev/ttyUSB0
Channel B / interface 1 -> /dev/ttyUSB1
```

Use stable paths from:

```text
/dev/serial/by-id/
```

---

### Arduino / CDC ACM Device

Expected node:

```text
/dev/ttyACM0
```

If upload/serial access fails, check group membership:

```bash
groups $USER
```

Common required groups:

```text
dialout
plugdev
```

---

### USB Camera

Expected nodes:

```text
/dev/video0
/dev/video1
```

Inspect supported camera formats with:

```bash
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

Install if missing:

```bash
sudo apt install v4l-utils
```

---

### USB Storage

Expected nodes:

```text
/dev/sdb
/dev/sdb1
```

Inspect with:

```bash
lsblk -f
```

or:

```bash
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS,MODEL,SERIAL
```

---

### HID / Input Devices

Expected nodes:

```text
/dev/input/event15
/dev/hidraw0
```

Examples:

* gamepads
* 2.4 GHz receivers
* keyboards
* mice
* some cabinet controls

---

## Troubleshooting

### Device Appears In `lsusb` But Has No `/dev` Node

This can be normal.

Examples:

* USB hubs
* root hubs
* some Bluetooth adapters
* raw HID-only devices
* devices needing a driver
* devices unsupported by the current kernel

Check the Driver and Kernel tabs.

---

### Device Does Not Appear At All

Run:

```bash
watch -n 0.5 lsusb
```

Plug/unplug the device.

If `lsusb` does not change, Linux is not seeing the USB electrical attach.

Try:

* a different USB port
* a different cable
* no hub
* a powered hub
* rebooting if the USB controller got wedged

---

### `dmesg` Shows Permission Errors

Some systems restrict kernel log access.

Check:

```bash
dmesg | tail
```

If restricted, you may need:

```bash
sudo dmesg --follow
```

or temporary access:

```bash
sudo sysctl kernel.dmesg_restrict=0
```

---

### Terminal Looks Broken After Crash

USB Detective uses raw keyboard and mouse reporting modes.

If the terminal is left weird after a crash:

```bash
stty sane
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?25h'
reset
```

---

### Serial Permission Denied

Check ownership:

```bash
ls -l /dev/ttyUSB0
```

Check groups:

```bash
groups $USER
```

Add yourself if needed:

```bash
sudo usermod -aG dialout $USER
```

Log out and back in after changing groups.

---

### Camera Formats Missing

Install:

```bash
sudo apt install v4l-utils
```

Then run:

```bash
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

---

## Typical Use Cases

### Arduino / Embedded Development

USB Detective helps identify:

* whether the board was detected
* whether it created `/dev/ttyACM*` or `/dev/ttyUSB*`
* which stable `/dev/serial/by-id` path to use

---

### Arcade / Bench Hardware

Useful for identifying:

* FTDI serial adapters
* CH340 serial adapters
* CP210x serial adapters
* USB cameras
* USB capture devices
* input controllers
* 2.4 GHz receivers

---

### Webcam / Microscope Camera Troubleshooting

Useful for seeing:

* whether the camera enumerated
* which `/dev/video*` nodes appeared
* whether stable `/dev/v4l/by-id` paths exist
* what the kernel said during attach

---

### USB Storage Analysis

Useful for identifying:

* drive node
* partition node
* filesystem
* label
* mountpoint
* model
* serial number

---

## Known Limitations

* The current UI is hand-drawn ANSI, not a full TUI framework.
* Some terminals handle mouse reporting better than others.
* USB topology from `lsusb -t` is shown raw and not yet cross-highlighted against the selected tree row.
* Raw USB descriptor tab currently gives the command rather than decoding the full descriptor inline.
* Some devices do not expose enough udev metadata to perfectly match every `/dev` node.
* Kernel log access depends on system permissions.
* The tool is polling-based, not a real-time libudev subscriber.

---

## Roadmap Ideas

* Search/filter mode
* Collapsible tree nodes
* “Interesting devices only” toggle
* Export selected device to JSON
* Export full snapshot to JSON
* Decode USB descriptors inline
* Inline `v4l2-ctl` camera format listing
* Inline serial-port open/test helper
* Inline `lsblk -f` storage detail
* Show USB controller / PCI parent
* Better hub port numbering
* Device history timeline
* Compare before/after snapshots
* Optional blessed/neo-blessed UI backend

---

## Quick Reference

Run:

```bash
./usbdetective.js
```

Quit:

```text
q
```

Refresh:

```text
r
```

Select device:

```text
Up / Down / j / k
```

Switch tabs:

```text
[ / ] or 1-6
```

Scroll details:

```text
PgUp / PgDn
```
