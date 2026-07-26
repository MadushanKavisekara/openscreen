> [!NOTE]
> This repository is an independent continuation of Screenly.
>
> Screenly was originally created by [Siddharth Vaddem](https://github.com/siddharthvaddem). The original repository was archived after v1.5.0 and remains available here: [siddharthvaddem/screenly](https://github.com/siddharthvaddem/screenly).
>
> This fork continues development under the Screenly name with the original author's approval, while remaining fully MIT open source.

> [!WARNING]
> Screenly is not production-grade software. You should expect bugs, rough edges, and occasional breaking changes.

<p align="center">
  <img src="public/screenly.png" alt="Screenly Logo" width="64" />
</p>

# <p align="center">Screenly</p>

<p align="center"><strong>Screenly is a free, open-source tool for creating polished screen recordings, product demos, and walkthroughs.</strong></p>

<p align="center">
  <a href="https://github.com/MadushanKavisekara/screenly/blob/main/LICENSE"><img src="https://img.shields.io/github/license/MadushanKavisekara/screenly?style=for-the-badge&label=License" alt="License" /></a>
  <a href="https://github.com/MadushanKavisekara/screenly/releases/latest"><img src="https://img.shields.io/github/v/release/MadushanKavisekara/screenly?style=for-the-badge&label=Release" alt="Latest Release" /></a>
  <a href="https://github.com/MadushanKavisekara/screenly/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MadushanKavisekara/screenly/ci.yml?style=for-the-badge&label=CI" alt="CI Status" /></a>
  <a href="https://discord.gg/VvT6Vtnyh"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=for-the-badge" alt="Platform" />
</p>


Screenly was originally positioned as a free, open-source alternative to Screen Studio: something you can use to create quick, polished product demos and walkthroughs for X, Reddit, YouTube, documentation, landing pages, or internal demos.

It is not a 1:1 clone of Screen Studio. Screen Studio is an excellent commercial product. Screenly focuses on covering the core open-source workflow: recording, zooms, cursor effects, webcam overlay, captions, editing, annotations, and export.

The goal of this continuation is to keep Screenly alive as a fully open-source project and progressively evolve it toward a broader recording and editing workflow.

**100% free** for both **personal** and **commercial** use. Use it, modify it, distribute it. Please respect the license.

> [!NOTE]
> Software should be accessible. Screenly has no paid tiers, premium features, upsells, or functionality locked behind a paywall.

<p align="center">
	<img src="public/demo.png" alt="" style="height: 320px; margin-right: 12px;" />
  <img src="public/sample.png" alt="" style="height: 320px; margin-right: 12px;" />
</p>

## Core Features
- Record a specific window, or your whole screen.
- Record microphone and system audio.
- Webcam overlay with picture-in-picture, drag-to-position, mirroring, and shape options.
- Auto or manual zooms with adjustable depth, duration, easing, and pixel-precise position; auto-zoom follows your cursor as you work.
- Custom cursor size, smoothing, and click effects, with cursor themes and post-recording path smoothing.
- Automatic captions for voiceovers, generated on-device with no upload (works offline).
- Wallpapers, solid colors, gradients, or your own background image.
- Motion blur.
- Crop, trim, and per-segment speed control on the timeline.
- Text, arrow, and image annotations, with text animation presets.
- Timeline snapping guides and an audio waveform to make trimming easier.
- Customizable keyboard shortcuts.
- Export to MP4 or GIF in multiple aspect ratios and resolutions.
- Languages supported: Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese (Brazil), Russian, Turkish, Vietnamese, Simplified Chinese, and Traditional Chinese.


## Installation

Download the latest installer for your platform from the [GitHub Releases](https://github.com/MadushanKavisekara/screenly/releases) page.

### macOS

Download the `.dmg` installer directly from the [Releases page](https://github.com/MadushanKavisekara/screenly/releases). If Gatekeeper blocks the app, you can bypass it by running the following command in your terminal after installation:

```bash
xattr -rd com.apple.quarantine /Applications/Screenly.app
```

Note: Give your terminal Full Disk Access in **System Settings > Privacy & Security** to grant you access and then run the above command.

After running this command, proceed to **System Settings > Privacy & Security** to grant the necessary permissions for "screen recording" and "accessibility". Once permissions are granted, you can launch the app.

> [!NOTE]
> **Upgrading from an older version and hitting permission issues?** If you already had Screenly installed and the new version won't record (Screen Recording or Accessibility keep failing even after you grant them), uninstall the old version, remove Screenly's existing entries under **System Settings > Privacy & Security** (both Screen Recording and Accessibility), then do a fresh install and grant the permissions again when prompted.

### Windows

Download the `.exe` installer directly from the [Releases page](https://github.com/MadushanKavisekara/screenly/releases).

### Linux

Three packages are published to the [Releases page](https://github.com/MadushanKavisekara/screenly/releases) for each version. Pick the one that matches your distro:

**Debian / Ubuntu / Pop!_OS (`.deb`)**
```bash
sudo apt install ./Screenly-Linux-latest.deb
```

**Arch / Manjaro (`.pacman`)**
```bash
sudo pacman -U Screenly-Linux-latest.pacman
```

**Any distro (`.AppImage`)**
```bash
chmod +x Screenly-Linux-*.AppImage
./Screenly-Linux-*.AppImage
```

**NixOS / Nix (flake)**

Try without installing:
```bash
nix run github:MadushanKavisekara/screenly
```

Install into your user profile:
```bash
nix profile install github:MadushanKavisekara/screenly
```

For a NixOS system config (flake):
```nix
{
  inputs.screenly.url = "github:MadushanKavisekara/screenly";

  outputs = { nixpkgs, screenly, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        screenly.nixosModules.default
        { programs.screenly.enable = true; }
      ];
    };
  };
}
```

For Home Manager, use `screenly.homeManagerModules.default` with the same `programs.screenly.enable = true;`.

You may need to grant screen recording permissions depending on your desktop environment.

**Sandbox error:** If the AppImage fails to launch with a "sandbox" error, run it with `--no-sandbox`:
```bash
./Screenly-Linux-*.AppImage --no-sandbox
```

### Platform differences

Everything in the editor and export is the same on macOS, Windows, and Linux: zooms, backgrounds, motion blur, crop/trim/speed, blur regions, annotations, auto-captions, projects, export, and all languages. The differences are in **capture**, where macOS and Windows use a native pipeline that Linux doesn't have:

- **Native recording**: macOS (ScreenCaptureKit) and Windows (Windows Graphics Capture) record through a native pipeline for higher quality and clean window-level capture. Linux records through the browser pipeline instead.
- **Custom cursors**: on macOS and Windows the real cursor is captured (shape, type, and clicks), which powers the cursor themes, click effects, and editable cursor overlay. On Linux only the cursor position is captured (used for auto-zoom), so those cursor options aren't available.
- **Webcam**: captured natively on macOS and Windows; on Linux it's recorded through the browser, but still works as a picture-in-picture overlay.
- **System audio** support varies by OS:
  - **macOS**: requires macOS 13+. On macOS 14.2+ you'll be prompted to grant audio capture permission. macOS 12 and below can't capture system audio (mic still works).
  - **Windows**: works out of the box.
  - **Linux**: needs PipeWire (default on Ubuntu 22.04+, Fedora 34+). Older PulseAudio-only setups may not capture system audio (mic should still work).

## Official links

Screenly is a rebrand of OpenScreen, itself the community-maintained continuation of the original Openscreen project.

Official / trusted links:

* Original archived repository: https://github.com/siddharthvaddem/openscreen
* Community continuation (OpenScreen): https://github.com/getopenscreen/openscreen
* This project (Screenly): https://github.com/MadushanKavisekara/screenly

For safety, download Screenly only from the official GitHub Releases linked from this repository. Third-party websites using the Screenly name are not affiliated with this continuation unless explicitly listed here.

## Community

Screenly is community-driven. If you need help, want to report a bug, or just want to chat with other users and contributors:

- 💬 **Discord** — [Join the Screenly Discord](https://discord.gg/VvT6Vtnyh) for real-time help, showcase, and discussion
- 🐞 **[GitHub Issues](https://github.com/MadushanKavisekara/screenly/issues)** — bug reports and feature requests
- 🗺️ **[Roadmap](./ROADMAP.md)** — see what we're building next

---

## License

This project is licensed under the [MIT License](./LICENSE). By using this software, you agree that the authors are not liable for any issues, damages, or claims arising from its use.
