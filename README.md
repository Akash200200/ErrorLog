# ErrorLog — RTL Error Logger

A web tool for hardware designers to track, log, and resolve EDA/compiler errors across projects.

> **Branch:** `master` — full Supabase backend (cloud storage + auth). For the self-contained localStorage-only version, see the [`localstorage`](../../tree/localstorage) branch.

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
- **Cloud storage** — data synced to Postgres via Supabase; survives device switches
- **User accounts** — email/password auth; each user sees only their own projects and errors
- **Export / Import** — backup your data as JSON and restore it anytime

---

## How to Run Locally

**Prerequisites:** Node.js 18+, a free [Supabase](https://supabase.com) account

```bash
git clone https://github.com/Akash200200/ErrorLog.git
cd ErrorLog
npm install
```

Create a `.env` file in the project root:

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

Then run:

```bash
npm run dev
```

Open **http://localhost:5173** in your browser. Create an account on first visit.

---

## Tech Stack

- **Frontend:** React + Vite
- **Styles:** Inline styles (no CSS framework)
- **Backend:** Supabase — Postgres database + Row Level Security + email/password auth
- **Hosting:** Vercel (coming soon)

---

## Roadmap

- [x] Smart error parser
- [x] Multi-project sidebar
- [x] Detail panel with inline editing
- [x] localStorage persistence + Export/Import
- [x] Supabase backend — cloud sync, user accounts, RLS
- [ ] Vercel deployment (live public URL)
- [ ] Team sharing — colleagues see each other's resolved errors and fixes

---

## Design

- Red accent `#E24B4A`, resolved green `#639922`
- Sidebar collapses to a 44px icon rail
- Modal always white (`#fff`) so it contrasts on any OS theme
