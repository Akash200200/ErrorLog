# ErrorLog — RTL Error Logger

A web tool for hardware designers to track, log, and resolve EDA/compiler errors across projects.

> **Branch:** `localstorage` — self-contained, no backend, no account required. All data lives in your browser's localStorage. This is the original version of the app.
> | Branch | What it is |
> |---|---|
> | [`master`](../../tree/master) | Live hosted app — just open the URL, no setup |
> | [`local-dev`](../../tree/local-dev) | Run locally with your own Supabase backend |
> | [`localstorage`](../../tree/localstorage) | No backend, no account — data stays in your browser ← you are here |

The full version with cloud storage and user accounts is **live at [log-your-error.vercel.app](https://log-your-error.vercel.app/)**.

---

## The Problem

Hardware designers writing RTL (VHDL, Verilog, SystemVerilog) face compiler and EDA tool errors constantly — during simulation, synthesis, place & route. They solve an error, move on, and weeks later the same error appears in a different module. By then they've forgotten the fix. Current "solution": Excel sheets. ErrorLog fixes that properly.

---

## Features

- **Multi-project sidebar** — collapsible VSCode-style dock, color-coded projects
- **Smart error parser** — paste raw EDA output, auto-extracts error code, file, line, severity, tool, language, and tags
- **Supports all major EDA tools** — Vivado, Synopsys DC, Cadence Innovus, ModelSim, VCS, Quartus, and any custom tool you add
- **Error cards** — color coded by severity (Error / Warning / Critical / Info), green when resolved
- **Detail panel** — click any error to open; every field is click-to-edit inline
- **Resolution tracking** — short title shown in the list, full details expandable on click
- **Filter + Search** — by status (All / Open / Resolved), tag filters, free text search
- **Deduplication alert** — warns you if you log an error code you've already solved before
- **Custom tool/language lists** — add your own EDA tools and HDL languages on the fly
- **localStorage persistence** — data survives refresh and browser restarts
- **Export / Import** — backup your data as JSON and restore it anytime

---

## How to Run Locally

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/Akash200200/ErrorLog.git
cd ErrorLog
git checkout localstorage
npm install
npm run dev
```

Open **http://localhost:5173** in your browser. No account needed — start logging immediately.

---

## Tech Stack

- **Frontend:** React + Vite
- **Styles:** Inline styles (no CSS framework)
- **Storage:** localStorage (browser-based, no backend required)

---

## Roadmap

- [x] Smart error parser
- [x] Multi-project sidebar
- [x] Detail panel with inline editing
- [x] localStorage persistence + Export/Import
- [x] Supabase backend — done in `master` / `local-dev` branches
- [x] Vercel deployment — live at [log-your-error.vercel.app](https://log-your-error.vercel.app/)
- [ ] Team sharing — colleagues see each other's resolved errors and fixes

---

## Design

- Red accent `#E24B4A`, resolved green `#639922`
- Sidebar collapses to a 44px icon rail
- Modal always white (`#fff`) so it contrasts on any OS theme
