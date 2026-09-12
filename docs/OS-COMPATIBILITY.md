# OS Compatibility & Platform Guide

`pi-quota` runs on any platform supported by Node.js 20+. Because it interacts with local credential stores, browser cookie databases, and background services, here is exactly how behavior maps across operating systems.

---

## Quick Comparison Matrix

| Feature | Linux (native) | WSL2 (Ubuntu / Debian) | macOS (Darwin) | Windows (PowerShell) |
|---|---|---|---|---|
| **CLI (`piquota`)** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Pi TUI Extension** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **OpenCode via Firefox** | `~/.mozilla/firefox/` | Auto-discovers Windows Firefox (`/mnt/c/Users/...`) | `~/Library/Application Support/Firefox/` | `%APPDATA%\Mozilla\Firefox\` |
| **OpenCode via Chromium** | Plaintext SQLite / Keyring | ⚠️ Encrypted with Windows DPAPI (use Firefox or `--paste`) | ⚠️ Encrypted with macOS Keychain (use Firefox or `--paste`) | ⚠️ Encrypted with DPAPI (use Firefox or `--paste`) |
| **Moshi Background Service** | `systemctl --user` | `systemctl --user` (requires WSL2 systemd enabled) | `launchd` plist agent | Task Scheduler / terminal loop |
| **Pi `auth.json` lookup** | `~/.pi/agent/auth.json` | `~/.pi/agent/auth.json` + `/mnt/c/Users/...` (deduplicated) | `~/.pi/agent/auth.json` | `%USERPROFILE%\.pi\agent\auth.json` |

---

## 1. WSL2 (Windows Subsystem for Linux)

This is the primary tested environment.

* **OpenCode Go Cookie Discovery:**
  * Windows Firefox profiles are located at `/mnt/c/Users/<user>/AppData/Roaming/Mozilla/Firefox/Profiles/`. Firefox stores cookies in unencrypted SQLite (`cookies.sqlite`), allowing `piquota` to safely read the session in read-only mode from WSL.
  * Windows Chrome, Edge, and Brave store cookies in encrypted format using the Windows DPAPI (Data Protection API), which is tied to Windows user credentials and cannot be decrypted from Linux/WSL.
  * **Recommendation:** Log in with Firefox in Windows (`piquota auth opencode`), or use manual pasting (`piquota auth opencode --paste`).
* **Pi Credential Deduplication:**
  * If Pi credentials exist both in WSL (`~/.pi/agent/auth.json`) and Windows (`/mnt/c/Users/<user>/.pi/agent/auth.json`), `piquota` loads both and deduplicates identical accounts automatically.
* **Background Daemon (`piquota moshi watch`):**
  * Uses `systemctl --user`. Requires WSL2 systemd support (enabled by default in modern WSL: check `/etc/wsl.conf` has `[boot]\nsystemd=true`).
  * Enable lingering (`loginctl enable-linger $USER`) so the service runs even when no interactive terminal is open.

---

## 2. Native Linux (Ubuntu, Debian, Fedora, Arch)

* **Prerequisites:**
  * Node.js >= 20.0.0
  * Pi Coding Agent (`pi`) and Gentle AI (`npm:gentle-pi`) installed.
* **OpenCode Go Cookie Discovery:**
  * Reads `~/.mozilla/firefox/` directly.
  * Chromium on Linux uses either plaintext SQLite or libsecret/kwallet depending on the desktop environment.
* **Moshi Background Service:**
  * Installed natively via `piquota moshi service install` into `~/.config/systemd/user/pi-quota-moshi.service`.
  * Managed via `systemctl --user {status,restart,stop}`.

---

## 3. macOS (Apple Silicon / Intel)

* **Prerequisites:**
  * Node.js >= 20.0.0 (`brew install node`)
  * Pi Coding Agent (`pi`) and Gentle AI (`npm:gentle-pi`) installed.
* **OpenCode Go Cookie Discovery:**
  * Reads `~/Library/Application Support/Firefox/Profiles/`.
  * Chrome/Brave on macOS encrypts cookies using the macOS Keychain (Safe Storage), which triggers OS-level security prompts. Use Firefox for automatic extraction, or `piquota auth opencode --paste`.
* **Moshi Background Service:**
  * macOS does not use `systemd`. Instead of `piquota moshi service install`, use a `launchd` agent or run the background command in a tmux/terminal session:
    ```bash
    # Run in background via nohup or tmux
    piquota moshi watch --interval 60 &
    ```
  * Or create `~/Library/LaunchAgents/pi-quota-moshi.plist` pointing to `node $(which piquota) moshi watch`.

---

## 4. Native Windows (PowerShell / Command Prompt)

* **Prerequisites:**
  * Node.js >= 20.0.0 (from nodejs.org)
  * Git for Windows.
* **Paths:**
  * Pi store: `%USERPROFILE%\.pi\agent\auth.json`
  * Firefox profiles: `%APPDATA%\Mozilla\Firefox\Profiles\`
* **Running the CLI:**
  ```powershell
  node bin\piquota.js
  node bin\piquota.js --status
  ```
* **Background Publishing:**
  * Use Windows Task Scheduler or run `node bin\piquota.js moshi watch` inside a background terminal or Windows Service wrapper (NSSM).

---

## Troubleshooting by Platform

| Issue | Platform | Solution |
|---|---|---|
| `Chromium cookies encrypted with DPAPI` | WSL / Windows | Log in to opencode.ai with Firefox, or run `piquota auth opencode --paste` |
| `systemctl: command not found` | macOS / WSL1 | On macOS use launchd or tmux. On WSL ensure WSL2 systemd is enabled (`[boot] systemd=true` in `/etc/wsl.conf`) |
| `Browser cookies locked` | Any | `piquota` copies `cookies.sqlite` to `/tmp` before querying, so open browsers do not cause database locks |
