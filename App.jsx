import { useState, useEffect, useRef } from "react";
import * as XLSX from 'xlsx';
import { supabase } from './src/supabase.js';

const DEFAULT_TOOLS = ['Vivado', 'Synopsys DC', 'Cadence Innovus', 'ModelSim', 'VCS', 'Quartus', 'Design Compiler', 'Genus', 'Xcelium', 'Other'];
const DEFAULT_LANGS = ['SystemVerilog', 'Verilog', 'VHDL', 'C', 'Python', 'TCL', 'Other'];
const PHASES = ['RTL Design', 'Synthesis', 'Place & Route', 'Simulation', 'Lint', 'Other'];
const ALL_TAGS = ['timing', 'CDC', 'synthesis', 'place-route', 'lint', 'simulation', 'DRC', 'power', 'constraints', 'area'];
const PROJ_COLORS = ['#E24B4A', '#185FA5', '#1D9E75', '#BA7517', '#7F77DD', '#D4537E'];

// Tracks the viewport width so inline-styled components can adapt to the device.
// isMobile ≈ phones, isTablet ≈ small laptops / large phones in landscape.
function useViewport() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return { width, isMobile: width <= 640, isTablet: width <= 980 };
}

// Flow-stage / category classification — maps raw error text to the design-flow
// stages a hardware engineer thinks in. Stored in the error's `tags` array.
const CATEGORY_RULES = [
  { tag: 'timing',      re: /timing|slack|setup|hold|\bwns\b|\btns\b|max.?delay|min.?delay|recovery|removal/i },
  { tag: 'CDC',         re: /\bcdc\b|clock.?domain|metastab|synchroniz|async.*cross/i },
  { tag: 'place-route', re: /\bplace|\brout(e|ing)|congest|placer|legaliz|\bp&?r\b|unplaced|overlap|\bnstd\b|io.?standard/i },
  { tag: 'synthesis',   re: /synth|elaborat|infer|latch|combinational loop|black.?box|optimiz|netlist|unconnected/i },
  { tag: 'lint',        re: /lint|width.?mismatch|\bport\b|sensitiv|signed|truncat|implicit|multiple driver/i },
  { tag: 'simulation',  re: /\bsim\b|testbench|assert|\$fatal|\$error|\buvm\b|vsim|xsim|\bvcs\b|out.?of.?bound|null.?pointer/i },
  { tag: 'DRC',         re: /\bdrc\b|design.?rule|spacing|antenna|geometry|short.?circuit|min.?area|density/i },
  { tag: 'power',       re: /power|\bupf\b|ir.?drop|switching|leakage|isolation.?cell|level.?shifter/i },
  { tag: 'constraints', re: /\bsdc\b|\bxdc\b|constraint|create_clock|false.?path|multicycle|set_input|set_output/i },
];
function classify(text) {
  const tags = [];
  for (const { tag, re } of CATEGORY_RULES) if (re.test(text)) tags.push(tag);
  return tags;
}

function parseError(raw) {
  const r = raw.trim();
  const result = { code: '', tool: '', lang: '', file: '', line: '', severity: 'Error', description: '', tags: [] };
  // Error code — try canonical short codes first (NSTD-1, CDC-1042, ELAB-900),
  // then Vivado/Xilinx bracket codes ([Synth 8-3331], [Timing 38-282]),
  // then Quartus numeric codes (Error (10228)).
  const codePatterns = [
    /\b([A-Z][A-Z0-9_]{2,}-\d+)\b/,
    /[\[\(]\s*([A-Za-z][\w]*\s+\d+-\d+)\s*[\]\)]/,
    /\bError\s*\((\d+)\)/i,
  ];
  for (const p of codePatterns) { const m = r.match(p); if (m) { result.code = m[1].replace(/\s+/g, ' '); break; } }
  if (/\b(critical|fatal)\b/i.test(r)) result.severity = 'Critical';
  else if (/\bwarning\b/i.test(r)) result.severity = 'Warning';
  else if (/\binfo\b/i.test(r)) result.severity = 'Info';
  else result.severity = 'Error';
  const filePatterns = [
    /["']?([\w\/\.\-]+\.(sv|v|vhd|vhdl|c|h))["']?[,\s:]*(?:line[:\s]*)?(\d+)/i,
    /([\w\/\.\-]+\.(sv|v|vhd|vhdl|c|h))\s*\((\d+)\)/i,
    /at\s+([\w\/\.\-]+\.(sv|v|vhd|vhdl|c|h)):(\d+)/i,
    /([\w\/\.\-]+\.(sv|v|vhd|vhdl|c|h))/i,
  ];
  for (const p of filePatterns) { const m = r.match(p); if (m) { result.file = m[1]; result.line = m[3] || ''; break; } }
  const ext = (result.file.match(/\.(\w+)$/) || [])[1];
  if (ext === 'sv') result.lang = 'SystemVerilog';
  else if (ext === 'v') result.lang = 'Verilog';
  else if (ext === 'vhd' || ext === 'vhdl') result.lang = 'VHDL';
  else if (ext === 'c' || ext === 'h') result.lang = 'C';
  if (/vivado|xsim/i.test(r)) result.tool = 'Vivado';
  else if (/synopsys|design.compiler|dc_shell/i.test(r)) result.tool = 'Synopsys DC';
  else if (/innovus|cadence/i.test(r)) result.tool = 'Cadence Innovus';
  else if (/modelsim|vsim/i.test(r)) result.tool = 'ModelSim';
  else if (/quartus/i.test(r)) result.tool = 'Quartus';
  else if (/\bvcs\b/i.test(r)) result.tool = 'VCS';
  // Vivado/Xilinx logs use [Subsystem N-N] tags even without naming the tool
  else if (/[\[\(](synth|timing|place|route|drc|opt|common|netlist|ip_flow|filemgmt|constraints|power|pwropt|board|xpm|vivado)\s+\d+-\d+[\]\)]/i.test(r)) result.tool = 'Vivado';
  let desc = r
    .replace(/^[\s>*|#-]+/, '')
    .replace(/^\s*(critical\s+warning|fatal|error|warning|info)\b\s*[:\-]?\s*/i, '')
    .replace(/[\[\(]\s*[A-Za-z][\w]*\s+[A-Z0-9]+-\d+\s*[\]\)]\s*[:\-]?\s*/, '')
    .replace(/^\s*[\[\(]?[A-Z][A-Z0-9_]+\-\d+[\]\)]?\s*[:\-]?\s*/, '')
    .replace(/[\[\(]["']?[\w\/\.\-]+\.(sv|v|vhd|vhdl|c|h)["']?[\s,:]*\d*[\]\)]/gi, '')
    .replace(/["']?[\w\/]+\.(sv|v|vhd|vhdl|c|h)["']?/gi, '')
    .replace(/\bline[:\s]*\d+/gi, '')
    .replace(/[\[\(]\s*:?\s*\d*\s*[\]\)]/g, '')
    .replace(/\s+:\s*\d+/g, '')
    .replace(/\(\s*\d+\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:\-–]+/, '')
    .trim();
  const sentences = desc.split(/[.\n]+/).map(s => s.trim()).filter(s => s.length > 8);
  result.description = sentences[0] || desc.slice(0, 140);
  result.tags = classify(r);
  const filled = [result.code, result.file, result.description].filter(Boolean).length;
  return { result, parseStatus: filled >= 3 ? 'ok' : filled >= 1 ? 'partial' : 'fail' };
}

// Split a full log file into individual error/warning chunks. A new chunk begins
// on any line that starts with a severity keyword or an EDA error code; following
// (usually indented) lines are treated as continuation of the current chunk.
function splitLogIntoErrors(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  // Allow leading noise like "** " (ModelSim), "*E," (VCS), ">", "|" before the severity word.
  const SEV_START = /^[\s*>|#-]*(critical\s+warning|fatal|error|warning|info)\b[\s:,\-\[\(]/i;
  const CODE_START = /^\s*[\[\(]?[A-Z][A-Z0-9_]+-\d+[\]\)]?[\s:\-]/;
  const isStart = l => SEV_START.test(l) || CODE_START.test(l);
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (isStart(line)) {
      if (cur) chunks.push(cur);
      cur = line.trim();
    } else if (cur && cur.length < 600) {
      cur += ' ' + line.trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Parse a whole log into a deduped list of structured errors, ready for review.
function parseLog(raw) {
  const map = new Map();
  for (const chunk of splitLogIntoErrors(raw)) {
    const { result, parseStatus } = parseError(chunk);
    if (!result.code && !result.file && result.description.length < 6) continue;
    const key = [result.code, result.file, result.line, result.description.slice(0, 60)].join('|');
    if (map.has(key)) { map.get(key).count++; continue; }
    map.set(key, { ...result, raw: chunk, parseStatus, count: 1, selected: result.severity !== 'Info' });
  }
  return [...map.values()];
}

function getPasswordChecks(pw) {
  return [
    { label: 'At least 8 characters',        ok: pw.length >= 8 },
    { label: 'One uppercase letter (A–Z)',    ok: /[A-Z]/.test(pw) },
    { label: 'One lowercase letter (a–z)',    ok: /[a-z]/.test(pw) },
    { label: 'One number (0–9)',              ok: /[0-9]/.test(pw) },
    { label: 'One special character (!@#…)',  ok: /[^A-Za-z0-9]/.test(pw) },
  ];
}

const SEV_COLOR = {
  Error:    { bg: '#FAECE7', text: '#993C1D', border: '#E24B4A' },
  Warning:  { bg: '#FAEEDA', text: '#854F0B', border: '#BA7517' },
  Critical: { bg: '#FCEBEB', text: '#A32D2D', border: '#E24B4A' },
  Info:     { bg: '#E6F1FB', text: '#185FA5', border: '#378ADD' },
};

function EditableField({ label, value, onChange, mono = false, multiline = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef();
  function commit() { onChange(draft); setEditing(false); }
  if (editing) {
    const shared = {
      value: draft, onChange: e => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: e => { if (!multiline && e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } },
      autoFocus: true, ref: inputRef,
      style: { flex: 1, padding: '3px 7px', borderRadius: 5, border: '1.5px solid #4A90D9', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: mono ? 'monospace' : 'inherit', outline: 'none', resize: multiline ? 'vertical' : 'none', minHeight: multiline ? 64 : 'auto', boxSizing: 'border-box', width: '100%' }
    };
    return (
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', width: 76, minWidth: 76, paddingTop: 4 }}>{label}</span>
        {multiline ? <textarea {...shared} /> : <input {...shared} />}
      </div>
    );
  }
  return (
    <div onClick={() => { setDraft(value); setEditing(true); }}
      style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start', cursor: 'text', borderRadius: 5, padding: '2px 4px', margin: '0 -4px 6px' }}
      title="Click to edit">
      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', width: 76, minWidth: 76, paddingTop: 2 }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: mono ? 'monospace' : 'inherit', flex: 1, color: value ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', fontStyle: value ? 'normal' : 'italic', lineHeight: 1.5 }}>
        {value || `— click to add ${label.toLowerCase()}`}
      </span>
    </div>
  );
}

function EditableSelect({ label, value, options, onChange }) {
  const [editing, setEditing] = useState(false);
  if (editing) return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', width: 76, minWidth: 76 }}>{label}</span>
      <select value={value} autoFocus onBlur={() => setEditing(false)}
        onChange={e => { onChange(e.target.value); setEditing(false); }}
        style={{ padding: '3px 7px', borderRadius: 5, border: '1.5px solid #4A90D9', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}>
        <option value="">— none —</option>
        {options.map(o => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
  return (
    <div onClick={() => setEditing(true)} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', cursor: 'pointer', borderRadius: 5, padding: '2px 4px', margin: '0 -4px 6px' }} title="Click to edit">
      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', width: 76, minWidth: 76 }}>{label}</span>
      <span style={{ fontSize: 13, color: value ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', fontStyle: value ? 'normal' : 'italic' }}>{value || `— click to set`}</span>
    </div>
  );
}

function CustomSelect({ label, value, options, onChange, onAddOption, onDeleteOption, modalStyle = false }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newVal, setNewVal] = useState('');
  const lbl = { fontSize: 11, color: modalStyle ? '#888' : 'var(--color-text-tertiary)', width: 88, minWidth: 88, textTransform: 'uppercase', letterSpacing: '0.06em' };
  const sel = { padding: '5px 8px', borderRadius: 5, border: modalStyle ? '1px solid #c8c8c8' : '0.5px solid var(--color-border-secondary)', background: modalStyle ? '#fff' : 'var(--color-background-primary)', color: modalStyle ? '#111' : 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: showAdd ? 'flex-start' : 'center' }}>
      <span style={lbl}>{label}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={value || ''} onChange={e => onChange(e.target.value)} style={{ ...sel, flex: 1 }}>
            <option value="">— select —</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          {value && options.includes(value) && !['Other'].includes(value) && (
            <button onClick={() => { onDeleteOption(value); onChange(''); }}
              style={{ padding: '4px 7px', borderRadius: 5, border: modalStyle ? '1px solid #e0a0a0' : '0.5px solid var(--color-border-tertiary)', background: 'transparent', color: '#c44', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1 }}>✕</button>
          )}
          <button onClick={() => setShowAdd(v => !v)}
            style={{ padding: '4px 8px', borderRadius: 5, border: modalStyle ? '1px solid #c8c8c8' : '0.5px solid var(--color-border-secondary)', background: 'transparent', color: modalStyle ? '#555' : 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1 }}>+</button>
        </div>
        {showAdd && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input value={newVal} onChange={e => setNewVal(e.target.value)} placeholder={`Custom ${label.toLowerCase()}...`}
              onKeyDown={e => { if (e.key === 'Enter' && newVal.trim()) { onAddOption(newVal.trim()); onChange(newVal.trim()); setNewVal(''); setShowAdd(false); } if (e.key === 'Escape') setShowAdd(false); }}
              style={{ ...sel, flex: 1, padding: '5px 8px' }} autoFocus />
            <button onClick={() => { if (newVal.trim()) { onAddOption(newVal.trim()); onChange(newVal.trim()); setNewVal(''); setShowAdd(false); } }}
              style={{ padding: '5px 10px', borderRadius: 5, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
          </div>
        )}
      </div>
    </div>
  );
}

function avatarColor(str) {
  const colors = ['#E24B4A', '#185FA5', '#1D9E75', '#BA7517', '#7F77DD', '#D4537E'];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function mostCommon(arr) {
  const freq = {};
  arr.forEach(v => { if (v) freq[v] = (freq[v] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
}

// ── Profile Modal ──
function ProfileModal({ user, errors, onClose }) {
  const [displayName, setDisplayName] = useState(user.user_metadata?.display_name || '');
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);

  const total = errors.length;
  const resolved = errors.filter(e => e.resolved).length;
  const rate = total > 0 ? Math.round(resolved / total * 100) : 0;
  const topTool = mostCommon(errors.map(e => e.tool));
  const topSev  = mostCommon(errors.map(e => e.severity));

  const initial = (displayName || user.email || '?')[0].toUpperCase();
  const color = avatarColor(user.email || '');
  const memberSince = new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

  async function saveName() {
    setSaving(true);
    await supabase.auth.updateUser({ data: { display_name: draftName.trim() } });
    setDisplayName(draftName.trim());
    setEditingName(false);
    setSaving(false);
  }

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1.5px solid #e0e0e0', width: '100%', maxWidth: 360, boxShadow: '0 24px 64px rgba(0,0,0,0.25)', overflow: 'hidden' }}>

        {/* Close */}
        <div style={{ padding: '16px 18px 0', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#bbb', lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        {/* Avatar + identity */}
        <div style={{ padding: '6px 24px 20px', textAlign: 'center', borderBottom: '0.5px solid #ebebeb' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: color, color: '#fff', fontSize: 24, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', letterSpacing: '-0.01em' }}>
            {initial}
          </div>
          {editingName ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
              <input value={draftName} onChange={e => setDraftName(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
                style={{ padding: '5px 9px', borderRadius: 6, border: '1px solid #d0d0d0', background: '#f7f7f7', color: '#111', fontSize: 14, fontFamily: 'inherit', outline: 'none', textAlign: 'center', width: 180 }} />
              <button onClick={saveName} disabled={saving}
                style={{ padding: '5px 10px', borderRadius: 6, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                {saving ? '…' : 'Save'}
              </button>
            </div>
          ) : (
            <div onClick={() => { setDraftName(displayName); setEditingName(true); }} title="Click to edit"
              style={{ fontSize: 17, fontWeight: 700, color: '#111', marginBottom: 4, cursor: 'text', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {displayName || <span style={{ color: '#bbb', fontStyle: 'italic', fontSize: 14, fontWeight: 400 }}>Add display name</span>}
              <span style={{ fontSize: 11, color: '#bbb' }}>✎</span>
            </div>
          )}
          <div style={{ fontSize: 13, color: '#666', marginBottom: 3 }}>{user.email}</div>
          <div style={{ fontSize: 11, color: '#999' }}>Member since {memberSince}</div>
        </div>

        {/* Stats */}
        <div style={{ padding: '16px 22px' }}>
          <div style={{ fontSize: 10, color: '#999', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Your stats</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            {[{ val: total, label: 'Logged' }, { val: resolved, label: 'Resolved' }, { val: `${rate}%`, label: 'Rate' }].map(s => (
              <div key={s.label} style={{ textAlign: 'center', padding: '10px 4px', borderRadius: 8, background: '#f5f5f5', border: '0.5px solid #e8e8e8' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#111', lineHeight: 1, marginBottom: 3 }}>{s.val}</div>
                <div style={{ fontSize: 10, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ label: 'Top tool', val: topTool }, { label: 'Top severity', val: topSev }].map(s => (
              <div key={s.label} style={{ flex: 1, padding: '8px 12px', borderRadius: 8, background: '#f5f5f5', border: '0.5px solid #e8e8e8' }}>
                <div style={{ fontSize: 10, color: '#999', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{s.val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Team teaser */}
        <div style={{ margin: '0 22px 22px', padding: '12px 14px', borderRadius: 8, border: '1px dashed #e0e0e0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>👥</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#111', marginBottom: 2 }}>Team sharing — coming soon</div>
            <div style={{ fontSize: 11, color: '#999', lineHeight: 1.4 }}>Invite teammates, share errors and resolutions across your group.</div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Reset Password Screen (shown after clicking email reset link) ──
function ResetPasswordScreen({ onDone }) {
  const { isMobile } = useViewport();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  async function handleReset(e) {
    e.preventDefault();
    if (password !== confirm) { setMsg({ type: 'error', text: 'Passwords do not match.' }); return; }
    if (!getPasswordChecks(password).every(c => c.ok)) { setMsg({ type: 'error', text: 'Password does not meet all requirements.' }); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setMsg({ type: 'error', text: error.message });
    else { setMsg({ type: 'success', text: 'Password updated! Signing you in...' }); setTimeout(onDone, 1200); }
    setLoading(false);
  }

  const inp = { padding: '9px 11px', borderRadius: 7, border: '1px solid var(--color-border-secondary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', marginBottom: 8 };
  const pwChecks = password ? getPasswordChecks(password) : null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', fontFamily: 'system-ui, sans-serif', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ background: 'var(--color-background-primary)', borderRadius: 14, border: '1px solid var(--color-border-tertiary)', width: '100%', maxWidth: 360, padding: isMobile ? '24px 20px 20px' : '32px 28px 24px', boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E24B4A', display: 'inline-block' }} />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--color-text-primary)' }}>ErrorLog</span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>Set new password</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 22 }}>Choose a new password for your account.</div>
        <form onSubmit={handleReset}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>New password</div>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus style={inp} />
          {pwChecks && (
            <div style={{ marginBottom: 12 }}>
              {pwChecks.map(c => (
                <div key={c.label} style={{ fontSize: 11, color: c.ok ? '#3B6D11' : '#aaa', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 10 }}>{c.ok ? '✓' : '○'}</span> {c.label}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Confirm password</div>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} style={{ ...inp, marginBottom: 18 }} />
          {msg.text && (
            <div style={{ fontSize: 12, marginBottom: 14, padding: '8px 10px', borderRadius: 6, background: msg.type === 'error' ? '#FAECE7' : '#EAF3DE', color: msg.type === 'error' ? '#993C1D' : '#3B6D11' }}>
              {msg.text}
            </div>
          )}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '10px', borderRadius: 8, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Auth Screen ──
function AuthScreen({ initialMode = 'login', onBack }) {
  const { isMobile } = useViewport();
  const [mode, setMode] = useState(initialMode);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setMsg({ type: '', text: '' });
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg({ type: 'error', text: error.message });
    } else {
      if (!getPasswordChecks(password).every(c => c.ok)) {
        setMsg({ type: 'error', text: 'Password does not meet all requirements.' });
        setLoading(false);
        return;
      }
      const displayName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName, first_name: firstName.trim(), last_name: lastName.trim() } } });
      if (error) setMsg({ type: 'error', text: error.message });
      else setMsg({ type: 'success', text: 'Check your email to confirm your account, then sign in.' });
    }
    setLoading(false);
  }

  async function handleForgot(e) {
    e.preventDefault();
    setLoading(true);
    setMsg({ type: '', text: '' });
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://log-your-error.vercel.app',
    });
    if (error) setMsg({ type: 'error', text: error.message });
    else setMsg({ type: 'success', text: 'Check your email for a reset link.' });
    setLoading(false);
  }

  const inp = { padding: '9px 11px', borderRadius: 7, border: '1px solid var(--color-border-secondary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', marginBottom: 12 };
  const pwChecks = mode === 'signup' && password ? getPasswordChecks(password) : null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', fontFamily: 'system-ui, sans-serif', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ background: 'var(--color-background-primary)', borderRadius: 14, border: '1px solid var(--color-border-tertiary)', width: '100%', maxWidth: 360, padding: isMobile ? '24px 20px 20px' : '32px 28px 24px', boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E24B4A', display: 'inline-block' }} />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--color-text-primary)' }}>ErrorLog</span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
          {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 22 }}>
          {mode === 'login' ? 'Welcome back.' : mode === 'signup' ? 'Start logging your EDA errors.' : 'Enter your email and we\'ll send a reset link.'}
        </div>
        <form onSubmit={mode === 'forgot' ? handleForgot : handleSubmit}>
          {mode === 'signup' && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>First name</div>
                <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} required autoFocus placeholder="Jane" style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last name</div>
                <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} required placeholder="Smith" style={inp} />
              </div>
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email</div>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus={mode !== 'signup'} style={inp} />
          {mode !== 'forgot' && <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Password</div>
              {mode === 'login' && (
                <button type="button" onClick={() => { setMode('forgot'); setMsg({ type: '', text: '' }); }}
                  style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 12, padding: 0, fontFamily: 'inherit' }}>
                  Forgot password?
                </button>
              )}
            </div>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} style={{ ...inp, marginBottom: pwChecks ? 8 : 18 }} />
            {pwChecks && (
              <div style={{ marginBottom: 14 }}>
                {pwChecks.map(c => (
                  <div key={c.label} style={{ fontSize: 11, color: c.ok ? '#3B6D11' : '#aaa', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 10 }}>{c.ok ? '✓' : '○'}</span> {c.label}
                  </div>
                ))}
              </div>
            )}
          </>}
          {mode === 'forgot' && <div style={{ marginBottom: 18 }} />}
          {msg.text && (
            <div style={{ fontSize: 12, marginBottom: 14, padding: '8px 10px', borderRadius: 6, background: msg.type === 'error' ? '#FAECE7' : '#EAF3DE', color: msg.type === 'error' ? '#993C1D' : '#3B6D11' }}>
              {msg.text}
            </div>
          )}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '10px', borderRadius: 8, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>
        </form>
        <div style={{ marginTop: 16, fontSize: 13, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
          {mode === 'forgot' ? (
            <button onClick={() => { setMode('login'); setMsg({ type: '', text: '' }); }}
              style={{ background: 'none', border: 'none', color: '#E24B4A', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, fontFamily: 'inherit' }}>
              Back to sign in
            </button>
          ) : (
            <>
              {mode === 'login' ? "No account? " : 'Have an account? '}
              <button onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg({ type: '', text: '' }); }}
                style={{ background: 'none', border: 'none', color: '#E24B4A', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, fontFamily: 'inherit' }}>
                {mode === 'login' ? 'Sign up' : 'Sign in'}
              </button>
            </>
          )}
        </div>
        {onBack && (
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <button onClick={onBack}
              style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: 12, padding: 0, fontFamily: 'inherit' }}>
              ← Back to home
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Export Modal ──
function ExportModal({ projects, errors, onClose }) {
  const [projectId, setProjectId] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  const filtered = errors
    .filter(e => projectId === 'all' || e.projId === projectId)
    .filter(e => !dateFrom || e.date >= dateFrom)
    .filter(e => !dateTo || e.date <= dateTo);

  function doExport() {
    if (filtered.length === 0) return;
    setExporting(true);
    const includeProject = projectId === 'all';
    const headers = [
      ...(includeProject ? ['Project'] : []),
      'Error Code', 'Severity', 'Tool', 'Language', 'File', 'Line',
      'Date', 'Status', 'Description', 'Notes', 'Tags', 'Fix Summary', 'Fix Details',
    ];
    const rows = filtered.map(e => {
      const proj = projects.find(p => p.id === e.projId);
      return [
        ...(includeProject ? [proj?.name || ''] : []),
        e.code || '', e.severity || '', e.tool || '', e.lang || '',
        e.file || '', e.line || '', e.date || '',
        e.resolved ? 'Resolved' : 'Open',
        e.description || '', e.notes || '',
        (e.tags || []).join(', '),
        e.resolutionTitle || '', e.resolution || '',
      ];
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [
      ...(includeProject ? [{ wch: 20 }] : []),
      { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 6 },
      { wch: 12 }, { wch: 10 }, { wch: 50 }, { wch: 30 }, { wch: 20 }, { wch: 30 }, { wch: 50 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Errors');
    const projName = projectId === 'all'
      ? 'all-projects'
      : (projects.find(p => p.id === projectId)?.name?.replace(/\s+/g, '-').toLowerCase() || 'export');
    XLSX.writeFile(wb, `errorlog-${projName}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
    onClose();
  }

  const inp = { padding: '9px 11px', borderRadius: 7, border: '1px solid #d0d0d0', fontSize: 13, fontFamily: 'inherit', outline: 'none', background: '#f7f7f7', color: '#111', boxSizing: 'border-box' };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1.5px solid #e0e0e0', width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.25)', overflow: 'hidden' }}>

        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Export errors</div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Downloads as an Excel (.xlsx) spreadsheet</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#bbb', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div style={{ padding: '22px 24px' }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Project</div>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              <option value="all">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Date range</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...inp, flex: 1 }} />
              <span style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }}>→</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...inp, flex: 1 }} />
            </div>
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo(''); }}
                style={{ marginTop: 6, background: 'none', border: 'none', color: '#999', fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit', textDecoration: 'underline' }}>
                Clear dates
              </button>
            )}
          </div>

          <div style={{ padding: '11px 14px', borderRadius: 8, background: filtered.length > 0 ? '#EAF3DE' : '#f5f5f5', border: `1px solid ${filtered.length > 0 ? '#a8d87a' : '#e8e8e8'}`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15 }}>{filtered.length > 0 ? '✓' : '○'}</span>
            <span style={{ fontSize: 13, color: filtered.length > 0 ? '#3B6D11' : '#999', fontWeight: 500 }}>
              {filtered.length} error{filtered.length !== 1 ? 's' : ''} will be exported
            </span>
          </div>
        </div>

        <div style={{ padding: '14px 24px 20px', borderTop: '1px solid #e8e8e8', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d0d0d0', background: 'transparent', color: '#555', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            Cancel
          </button>
          <button onClick={doExport} disabled={filtered.length === 0 || exporting}
            style={{ padding: '9px 20px', borderRadius: 8, background: filtered.length === 0 ? '#ddd' : '#E24B4A', color: filtered.length === 0 ? '#aaa' : '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: filtered.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: exporting ? 0.75 : 1 }}>
            {exporting ? 'Exporting…' : '↓ Export .xlsx'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Landing Page ──
function LandingPage({ onLogin, onSignUp }) {
  const { isMobile } = useViewport();
  const px = isMobile ? 18 : 36;           // shared horizontal page padding
  const sectionPadY = isMobile ? 48 : 76;  // shared vertical section padding
  const [modalOpen, setModalOpen] = useState(false);
  const [typedLen, setTypedLen] = useState(0);
  const [parsedVisible, setParsedVisible] = useState(false);
  const [fieldCount, setFieldCount] = useState(0);
  const [cardVisible, setCardVisible] = useState(false);

  const SAMPLE = "ERROR: [NSTD-1] I/O Standard not set\nfor port 'clk_in' — top_module.sv line 42";
  const FIELDS = [
    { label: 'Code',     value: 'NSTD-1',       mono: true },
    { label: 'File',     value: 'top_module.sv', mono: true },
    { label: 'Tool',     value: 'Vivado',        mono: false },
    { label: 'Severity', value: 'Error',         mono: false },
  ];

  useEffect(() => {
    const ids = [];
    let alive = true;
    function at(fn, ms) { const id = setTimeout(() => { if (alive) fn(); }, ms); ids.push(id); }

    function cycle() {
      setModalOpen(false); setTypedLen(0); setParsedVisible(false); setFieldCount(0); setCardVisible(false);
      let t = 900;
      at(() => setModalOpen(true), t); t += 520;
      for (let i = 1; i <= SAMPLE.length; i++) { const n = i; at(() => setTypedLen(n), t + n * 24); }
      t += SAMPLE.length * 24 + 360;
      at(() => setParsedVisible(true), t); t += 240;
      for (let i = 1; i <= 4; i++) { const n = i; at(() => setFieldCount(n), t + n * 230); }
      t += 4 * 230 + 720;
      at(() => setModalOpen(false), t);
      at(() => { setParsedVisible(false); setTypedLen(0); setFieldCount(0); }, t + 80);
      t += 440;
      at(() => setCardVisible(true), t); t += 3200;
      at(() => { setCardVisible(false); at(cycle, 500); }, t);
    }

    at(cycle, 400);
    return () => { alive = false; ids.forEach(clearTimeout); };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#f9f9f9', fontFamily: 'system-ui, -apple-system, sans-serif', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes lp-slide-in  { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes lp-fade-in   { from { opacity: 0; transform: translateX(-5px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes lp-blink     { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes lp-modal-in  { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        html { scroll-behavior: smooth; }
        .lp-navlink:hover { background: #f2f2f2; color: #111; }
        @media (min-width: 720px) { .lp-navlink { display: inline-flex !important; } }
        .lp-card { transition: transform 0.15s ease, box-shadow 0.15s ease; }
        .lp-card:hover { transform: translateY(-3px); box-shadow: 0 12px 32px rgba(0,0,0,0.09); }
      `}</style>

      {/* Nav */}
      <nav style={{ padding: `13px ${px}px`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid #ebebeb', background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="#D97757" />
            <rect x="8" y="8" width="3.5" height="16" fill="white" />
            <rect x="8" y="8" width="15" height="3" fill="white" />
            <rect x="8" y="14.5" width="11" height="2.5" fill="white" />
            <rect x="8" y="21" width="15" height="3" fill="white" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em', color: '#111' }}>ErrorLog</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {[['Features', '#features'], ['How it works', '#how'], ['About', '#about']].map(([lbl, href]) => (
            <a key={href} href={href} style={{ display: 'none', padding: '7px 12px', fontSize: 13, color: '#555', textDecoration: 'none', borderRadius: 7, fontWeight: 500 }} className="lp-navlink">{lbl}</a>
          ))}
          <button onClick={onLogin} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #d8d8d8', background: '#fff', color: '#333', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            Sign in
          </button>
          <button onClick={onSignUp} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: '#E24B4A', color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
            Sign up
          </button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{ minHeight: isMobile ? 'auto' : 'calc(100vh - 130px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${isMobile ? 36 : 52}px ${px}px ${isMobile ? 44 : 68}px` }}>
        <div style={{ width: '100%', maxWidth: 1120, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: isMobile ? 34 : 56, flexWrap: 'wrap' }}>

        {/* Left: copy */}
        <div style={{ flex: '1 1 360px', maxWidth: isMobile ? '100%' : 440 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 11px', borderRadius: 20, background: '#fff', border: '1px solid #ececec', fontSize: 12, color: '#777', marginBottom: 18, fontWeight: 500 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1D9E75' }} /> Built for RTL & EDA engineers
          </div>
          <h1 style={{ fontSize: isMobile ? 31 : 42, fontWeight: 800, lineHeight: 1.1, color: '#111', letterSpacing: '-0.03em', margin: '0 0 16px' }}>
            Log your EDA errors.<br />
            <span style={{ color: '#E24B4A' }}>Learn from them.</span>
          </h1>
          <p style={{ fontSize: 15, color: '#555', lineHeight: 1.65, margin: '0 0 30px', maxWidth: 360 }}>
            Paste a single error or drop a full Vivado / Synopsys / Quartus log. ErrorLog extracts every error, categorizes it by flow stage, and remembers how you fixed it — across all your projects.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onSignUp}
              style={{ padding: '11px 22px', borderRadius: 9, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '-0.01em' }}>
              Sign up — free
            </button>
            <button onClick={onLogin}
              style={{ padding: '11px 18px', borderRadius: 9, border: '1px solid #d0d0d0', background: '#fff', color: '#444', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
              Sign in
            </button>
          </div>
        </div>

        {/* Right: animated demo window */}
        <div style={{ flex: '1 1 420px', maxWidth: isMobile ? '100%' : 520, width: '100%' }}>
          <div style={{ borderRadius: 12, border: '1px solid #e0e0e0', boxShadow: '0 16px 56px rgba(0,0,0,0.11)', overflow: 'hidden', background: '#fff' }}>
            {/* Window chrome */}
            <div style={{ height: 34, background: '#f5f5f5', borderBottom: '0.5px solid #e8e8e8', display: 'flex', alignItems: 'center', padding: '0 14px', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
              <div style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#999', marginRight: 36 }}>ErrorLog — AXI Bridge</div>
            </div>

            {/* App body (position: relative so modal can overlay) */}
            <div style={{ display: 'flex', height: 360, position: 'relative' }}>

              {/* Sidebar */}
              <div style={{ width: 148, background: '#fafafa', borderRight: '0.5px solid #ededed', padding: '10px 6px', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                <div style={{ fontSize: 9, color: '#c0c0c0', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '2px 8px 5px' }}>Projects</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, background: '#eef0f2', marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#185FA5', minWidth: 6 }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#111', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>AXI Bridge</span>
                  <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 8, background: '#FAECE7', color: '#993C1D', fontWeight: 700 }}>{cardVisible ? 2 : 1}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1D9E75', minWidth: 6 }} />
                  <span style={{ fontSize: 11, color: '#888', flex: 1 }}>SoC Top</span>
                  <span style={{ fontSize: 10, color: '#639922' }}>✓</span>
                </div>
                <div style={{ marginTop: 'auto', padding: '8px 8px 6px', borderTop: '0.5px solid #ededed' }}>
                  <div style={{ fontSize: 10, color: '#c0c0c0', marginBottom: 2 }}>Total logged</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#111', lineHeight: 1 }}>{cardVisible ? 3 : 2}</div>
                  <div style={{ fontSize: 10, color: '#c0c0c0', marginTop: 1 }}>across 2 projects</div>
                </div>
              </div>

              {/* Main area */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {/* Topbar */}
                <div style={{ background: '#fff', borderBottom: '0.5px solid #ededed', padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#185FA5', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#111', flex: 1 }}>AXI Bridge</span>
                  <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: '#FAECE7', color: '#993C1D', fontWeight: 600, flexShrink: 0 }}>{cardVisible ? 2 : 1} open</span>
                  <div style={{ padding: '4px 9px', borderRadius: 5, background: '#E24B4A', color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>+ Log Error</div>
                </div>

                {/* Error list */}
                <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'hidden' }}>
                  {cardVisible && (
                    <div style={{ background: '#fff', border: '0.5px solid #e8e8e8', borderLeft: '2.5px solid #E24B4A', borderRadius: 7, padding: '9px 11px', animation: 'lp-slide-in 0.38s ease' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3, fontFamily: 'monospace', background: '#FAECE7', color: '#993C1D' }}>NSTD-1</span>
                        <span style={{ fontSize: 11, fontWeight: 500, color: '#111', flex: 1, lineHeight: 1.3 }}>I/O Standard not set for port 'clk_in'</span>
                      </div>
                      <div style={{ display: 'flex', gap: 5, fontSize: 10, color: '#999' }}>
                        <span style={{ padding: '1px 5px', borderRadius: 3, background: '#f0f0f0', fontWeight: 500 }}>Vivado</span>
                        <span>📄 top_module.sv:42</span>
                      </div>
                    </div>
                  )}
                  <div style={{ background: '#fff', border: '0.5px solid #e8e8e8', borderLeft: '2.5px solid #639922', borderRadius: 7, padding: '9px 11px', opacity: 0.82 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3, fontFamily: 'monospace', background: '#EAF3DE', color: '#3B6D11' }}>CDC-004</span>
                      <span style={{ fontSize: 11, fontWeight: 500, color: '#111', flex: 1, lineHeight: 1.3 }}>Missing synchronizer on async reset</span>
                      <span style={{ color: '#639922', fontSize: 12, flexShrink: 0 }}>✓</span>
                    </div>
                    <div style={{ display: 'flex', gap: 5, fontSize: 10, color: '#999' }}>
                      <span style={{ padding: '1px 5px', borderRadius: 3, background: '#f0f0f0', fontWeight: 500 }}>Synopsys DC</span>
                      <span>📄 reset_sync.sv:17</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modal overlay — absolutely positioned over the whole app body */}
              {modalOpen && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.36)', backdropFilter: 'blur(1.5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
                  <div style={{ background: '#fff', borderRadius: 9, border: '1.5px solid #d0d0d0', width: '88%', maxWidth: 310, boxShadow: '0 10px 36px rgba(0,0,0,0.18)', animation: 'lp-modal-in 0.28s ease', overflow: 'hidden' }}>
                    <div style={{ padding: '11px 13px 8px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Log new error</span>
                      <span style={{ fontSize: 16, color: '#ccc' }}>×</span>
                    </div>
                    <div style={{ padding: '11px 13px' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#444', marginBottom: 5 }}>Paste error output</div>
                      <div style={{ width: '100%', minHeight: 60, padding: '7px 9px', borderRadius: 5, border: '1px solid #d0d0d0', background: '#f7f7f7', fontSize: 10, fontFamily: 'monospace', color: '#222', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', boxSizing: 'border-box' }}>
                        {SAMPLE.slice(0, typedLen)}
                        <span style={{ display: 'inline-block', width: 1, height: '1em', background: '#444', marginLeft: 0.5, verticalAlign: 'text-bottom', animation: 'lp-blink 1s step-end infinite' }} />
                      </div>
                      {parsedVisible && (
                        <div style={{ marginTop: 7, padding: '5px 9px', borderRadius: 5, background: '#EAF3DE', border: '1px solid #a8d87a', fontSize: 10, color: '#3B6D11', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                          ✓ Parsed successfully — review below
                        </div>
                      )}
                      {fieldCount > 0 && (
                        <div style={{ marginTop: 8, background: '#f3f3f3', borderRadius: 6, padding: '8px 10px', border: '1px solid #ddd' }}>
                          {FIELDS.slice(0, fieldCount).map((f, i) => (
                            <div key={f.label} style={{ display: 'flex', gap: 8, marginBottom: i < fieldCount - 1 ? 5 : 0, alignItems: 'center', animation: 'lp-fade-in 0.26s ease' }}>
                              <span style={{ fontSize: 9, color: '#999', width: 50, minWidth: 50, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.label}</span>
                              <span style={{ fontSize: 10, fontFamily: f.mono ? 'monospace' : 'system-ui', color: '#111', background: '#fff', padding: '2px 5px', borderRadius: 3, border: '1px solid #e0e0e0' }}>{f.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {fieldCount >= 4 && (
                      <div style={{ padding: '8px 13px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 7 }}>
                        <div style={{ padding: '5px 11px', borderRadius: 5, border: '1px solid #d0d0d0', color: '#666', fontSize: 11 }}>Cancel</div>
                        <div style={{ padding: '5px 11px', borderRadius: 5, background: '#E24B4A', color: '#fff', fontSize: 11, fontWeight: 700 }}>Save error</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* Tools strip */}
      <div style={{ padding: `28px ${px}px`, borderTop: '0.5px solid #ebebeb', borderBottom: '0.5px solid #ebebeb', background: '#fff' }}>
        <div style={{ maxWidth: 980, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 16, fontWeight: 600 }}>Understands output from the tools you already run</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '14px 28px' }}>
            {['Vivado', 'Synopsys DC', 'Cadence Innovus', 'ModelSim', 'VCS', 'Quartus', 'Genus', 'Xcelium'].map(t => (
              <span key={t} style={{ fontSize: 15, fontWeight: 700, color: '#c4c4c8', letterSpacing: '-0.01em' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Features */}
      <div id="features" style={{ padding: `${sectionPadY}px ${px}px`, background: '#f9f9f9' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: isMobile ? 24 : 30, fontWeight: 800, color: '#111', letterSpacing: '-0.02em', margin: '0 0 12px' }}>Everything you need to stop re-solving the same error</h2>
            <p style={{ fontSize: 15, color: '#666', maxWidth: 520, margin: '0 auto', lineHeight: 1.6 }}>From a single pasted line to a thousand-line synthesis log — turn raw tool output into a searchable knowledge base.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 18 }}>
            {[
              { icon: '⚡', title: 'Smart error parser', body: 'Paste any compiler output — the error code, file, line, tool, language and severity are extracted automatically.' },
              { icon: '⬆', title: 'Bulk log import', body: 'Drop a full Vivado, Synopsys or Quartus log file. Every error and warning is pulled out, deduplicated and ready to review.' },
              { icon: '🏷', title: 'Auto-categorized', body: 'Each issue is tagged by flow stage — synthesis, timing, CDC, place & route, DRC — so filters build themselves.' },
              { icon: '💡', title: 'Resolution memory', body: 'Record how you fixed it. Hit the same error code again and ErrorLog instantly resurfaces your past fix.' },
              { icon: '📊', title: 'Cross-project tracking', body: 'Organize errors per project, track open vs resolved, and watch your resolution rate climb over time.' },
              { icon: '↓', title: 'Excel export', body: 'Export any project or date range to a clean .xlsx — for reports, reviews, or sharing with your team.' },
            ].map(f => (
              <div key={f.title} className="lp-card" style={{ background: '#fff', borderRadius: 12, border: '1px solid #ececec', padding: '22px 20px' }}>
                <div style={{ width: 40, height: 40, borderRadius: 9, background: '#FAECE7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, marginBottom: 14 }}>{f.icon}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 7 }}>{f.title}</div>
                <div style={{ fontSize: 13.5, color: '#666', lineHeight: 1.6 }}>{f.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* How it works */}
      <div id="how" style={{ padding: `${sectionPadY}px ${px}px`, background: '#fff', borderTop: '0.5px solid #ebebeb' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: isMobile ? 24 : 30, fontWeight: 800, color: '#111', letterSpacing: '-0.02em', margin: '0 0 12px' }}>Three steps, then never lose a fix again</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 28 }}>
            {[
              { n: '1', title: 'Paste or import', body: 'Drop a log file or paste a single error straight from your terminal or EDA tool.' },
              { n: '2', title: 'Auto-parsed & sorted', body: 'ErrorLog structures every issue and tags it by flow stage — no manual data entry.' },
              { n: '3', title: 'Resolve & remember', body: 'Write down the fix once. It comes back automatically the next time the error appears.' },
            ].map(s => (
              <div key={s.n} style={{ textAlign: 'center' }}>
                <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#E24B4A', color: '#fff', fontSize: 19, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>{s.n}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 8 }}>{s.title}</div>
                <div style={{ fontSize: 13.5, color: '#666', lineHeight: 1.6, maxWidth: 260, margin: '0 auto' }}>{s.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* About / contact */}
      <div id="about" style={{ padding: `${sectionPadY}px ${px}px`, background: '#f9f9f9', borderTop: '0.5px solid #ebebeb' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: avatarColor('akash'), color: '#fff', fontSize: 26, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}>A</div>
          <h2 style={{ fontSize: isMobile ? 22 : 26, fontWeight: 800, color: '#111', letterSpacing: '-0.02em', margin: '0 0 14px' }}>Built by an engineer who lived the problem</h2>
          <p style={{ fontSize: 15, color: '#555', lineHeight: 1.7, margin: '0 0 12px' }}>
            I'm <strong>Akash Biyani</strong>, a hardware / RTL engineer at RPTU. I got tired of solving the same Vivado and Synopsys errors month after month and digging through scattered Excel sheets to remember the fix. ErrorLog is the tool I wished I had — a real, shared memory for EDA errors.
          </p>
          <p style={{ fontSize: 14, color: '#777', lineHeight: 1.7, margin: '0 0 24px' }}>
            It's actively being built. If you run RTL flows and have ideas, bugs, or just want to talk shop — I'd genuinely love to hear from you.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="https://www.linkedin.com/in/akash-biyani" target="_blank" rel="noopener noreferrer"
              style={{ padding: '9px 18px', borderRadius: 8, background: '#fff', border: '1px solid #d8d8d8', color: '#333', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              in · LinkedIn
            </a>
            <a href="mailto:aakash.biyani29@gmail.com"
              style={{ padding: '9px 18px', borderRadius: 8, background: '#fff', border: '1px solid #d8d8d8', color: '#333', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              ✉ Email me
            </a>
          </div>
        </div>
      </div>

      {/* CTA band */}
      <div style={{ padding: `${isMobile ? 48 : 64}px ${px}px`, background: '#111', textAlign: 'center' }}>
        <h2 style={{ fontSize: isMobile ? 23 : 28, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: '0 0 12px' }}>Start your error knowledge base today</h2>
        <p style={{ fontSize: 15, color: '#aaa', margin: '0 0 26px', lineHeight: 1.6 }}>Free to use. No setup. Just paste your first error.</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={onSignUp}
            style={{ padding: '12px 26px', borderRadius: 9, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            Sign up — free
          </button>
          <button onClick={onLogin}
            style={{ padding: '12px 24px', borderRadius: 9, border: '1px solid #444', background: 'transparent', color: '#eee', fontSize: 15, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
            Sign in
          </button>
        </div>
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '22px 24px', fontSize: 12, color: '#aaa', background: '#0c0c0c' }}>
        <span style={{ color: '#888' }}>ErrorLog</span> — built by{' '}
        <a href="https://www.linkedin.com/in/akash-biyani" target="_blank" rel="noopener noreferrer"
          style={{ color: '#aaa', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 }}>
          Akash Biyani
        </a>
        <span style={{ color: '#555' }}> · © {new Date().getFullYear()}</span>
      </div>
    </div>
  );
}

// ── Import Log Modal — drop/paste a full EDA log, extract every error ──
function ImportLogModal({ projects, activeProj, onClose, onImport }) {
  const [text, setText] = useState('');
  const [items, setItems] = useState(null);   // null = not parsed yet
  const [projId, setProjId] = useState(activeProj || (projects[0]?.id ?? ''));
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showWarnings, setShowWarnings] = useState(true);
  const [showInfo, setShowInfo] = useState(false);

  function runParse(raw) {
    const parsed = parseLog(raw);
    setItems(parsed);
  }
  function loadFile(file) {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => { const t = e.target.result || ''; setText(t); runParse(t); };
    reader.readAsText(file);
  }

  const sevRank = { Critical: 0, Error: 1, Warning: 2, Info: 3 };
  const visible = (items || [])
    .filter(it => (it.severity !== 'Warning' || showWarnings) && (it.severity !== 'Info' || showInfo))
    .sort((a, b) => (sevRank[a.severity] ?? 4) - (sevRank[b.severity] ?? 4));
  const counts = (items || []).reduce((a, it) => { const k = it.severity === 'Critical' ? 'Error' : it.severity; a[k] = (a[k] || 0) + 1; return a; }, {});
  const selectedItems = visible.filter(it => it.selected);

  function toggle(idx) {
    setItems(prev => prev.map(it => it === visible[idx] ? { ...it, selected: !it.selected } : it));
  }
  function setAll(val) {
    setItems(prev => prev.map(it => visible.includes(it) ? { ...it, selected: val } : it));
  }
  async function doImport() {
    if (!projId || selectedItems.length === 0) return;
    setImporting(true);
    await onImport(selectedItems, projId);
    setImporting(false);
  }

  const sectionTitle = { fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1.5px solid #e0e0e0', width: '100%', maxWidth: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '20px 26px 16px', borderBottom: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Import log file</div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Drop a Vivado / Synopsys / Quartus log — we extract every error automatically.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#bbb', lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>

        <div style={{ padding: '18px 26px', overflowY: 'auto', flex: 1 }}>
          {/* Drop zone */}
          <label
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files[0]); }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '20px', borderRadius: 10, border: `1.5px dashed ${dragOver ? '#E24B4A' : '#cfcfcf'}`, background: dragOver ? '#FAECE7' : '#fafafa', cursor: 'pointer', textAlign: 'center', marginBottom: 14 }}>
            <span style={{ fontSize: 22 }}>⬆</span>
            <span style={{ fontSize: 13, color: '#444', fontWeight: 600 }}>{fileName || 'Drop a log file here, or click to browse'}</span>
            <span style={{ fontSize: 11, color: '#aaa' }}>.log · .rpt · .out · .txt</span>
            <input type="file" accept=".log,.rpt,.out,.txt,text/plain" style={{ display: 'none' }}
              onChange={e => loadFile(e.target.files[0])} />
          </label>

          {/* Or paste */}
          <div style={sectionTitle}>Or paste the log</div>
          <textarea value={text} onChange={e => { setText(e.target.value); if (e.target.value.trim().length > 20) runParse(e.target.value); else setItems(null); }}
            placeholder="Paste the full compiler / synthesis / P&R log output..."
            style={{ width: '100%', minHeight: 90, padding: '10px 12px', borderRadius: 8, border: '1.5px solid #c0c0c0', background: '#f7f7f7', color: '#111', fontSize: 12, fontFamily: 'monospace', outline: 'none', resize: 'vertical', boxSizing: 'border-box', marginBottom: 16 }} />

          {/* Results */}
          {items && (items.length === 0 ? (
            <div style={{ padding: '14px', borderRadius: 8, background: '#FAEEDA', border: '1px solid #e6c97a', fontSize: 13, color: '#854F0B' }}>
              No errors detected. Make sure the log contains lines like <code>ERROR: [Synth 8-1234] ...</code>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{items.length} unique issue{items.length !== 1 ? 's' : ''} found</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#FAECE7', color: '#993C1D', fontWeight: 600 }}>{counts.Error || 0} errors</span>
                <span onClick={() => setShowWarnings(v => !v)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', background: showWarnings ? '#FAEEDA' : '#f0f0f0', color: showWarnings ? '#854F0B' : '#aaa', fontWeight: 600 }}>{counts.Warning || 0} warnings {showWarnings ? '✓' : ''}</span>
                {(counts.Info || 0) > 0 && <span onClick={() => setShowInfo(v => !v)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', background: showInfo ? '#E6F1FB' : '#f0f0f0', color: showInfo ? '#185FA5' : '#aaa', fontWeight: 600 }}>{counts.Info} info {showInfo ? '✓' : ''}</span>}
                <div style={{ flex: 1 }} />
                <button onClick={() => setAll(true)} style={{ fontSize: 11, background: 'none', border: 'none', color: '#185FA5', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Select all</button>
                <button onClick={() => setAll(false)} style={{ fontSize: 11, background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontFamily: 'inherit' }}>None</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((it, idx) => {
                  const sev = SEV_COLOR[it.severity] || SEV_COLOR.Error;
                  return (
                    <label key={idx} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 8, border: '1px solid #ececec', background: it.selected ? '#fff' : '#fafafa', borderLeft: `3px solid ${sev.border}`, cursor: 'pointer', opacity: it.selected ? 1 : 0.6 }}>
                      <input type="checkbox" checked={it.selected} onChange={() => toggle(idx)} style={{ marginTop: 3, accentColor: '#E24B4A', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace', background: sev.bg, color: sev.text }}>{it.code || it.severity}</span>
                          {it.count > 1 && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: '#eee', color: '#777' }}>×{it.count}</span>}
                          {it.tool && <span style={{ fontSize: 10, color: '#888', background: '#f0f0f0', padding: '1px 6px', borderRadius: 4 }}>{it.tool}</span>}
                          {it.tags.map(t => <span key={t} style={{ fontSize: 10, color: '#185FA5', background: '#E6F1FB', padding: '1px 6px', borderRadius: 4, fontWeight: 500 }}>{t}</span>)}
                        </div>
                        <div style={{ fontSize: 12, color: '#222', lineHeight: 1.4 }}>{it.description}</div>
                        {it.file && <div style={{ fontSize: 11, color: '#999', marginTop: 2, fontFamily: 'monospace' }}>📄 {it.file}{it.line ? `:${it.line}` : ''}</div>}
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 26px 18px', borderTop: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ fontSize: 12, color: '#777', flexShrink: 0 }}>Into project</span>
            <select value={projId} onChange={e => setProjId(e.target.value)}
              style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid #c8c8c8', background: '#fff', color: '#111', fontSize: 13, fontFamily: 'inherit', outline: 'none', maxWidth: 200 }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button onClick={onClose} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #d0d0d0', background: 'transparent', color: '#555', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>Cancel</button>
          <button onClick={doImport} disabled={selectedItems.length === 0 || !projId || importing}
            style={{ padding: '9px 20px', borderRadius: 8, background: selectedItems.length === 0 ? '#ddd' : '#E24B4A', color: selectedItems.length === 0 ? '#aaa' : '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: selectedItems.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: importing ? 0.7 : 1 }}>
            {importing ? 'Importing…' : `Import ${selectedItems.length || ''} error${selectedItems.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // ── Responsive ──
  const { isMobile } = useViewport();
  const [mobileSidebar, setMobileSidebar] = useState(false);

  // ── Auth ──
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);
  const [authMode, setAuthMode] = useState(null); // null=landing, 'login', 'signup'
  const [showProfile, setShowProfile] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [verifyDismissed, setVerifyDismissed] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('errlog_theme') || 'light'; } catch { return 'light'; } });

  // ── App state ──
  const [projects, setProjects] = useState([]);
  const [errors, setErrors] = useState([]);
  const [activeProj, setActiveProj] = useState(null);
  const [filter, setFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [showNewProj, setShowNewProj] = useState(false);
  const [toast, setToast] = useState(null);
  const [resExpanded, setResExpanded] = useState({});

  // ── Preferences — stay in localStorage ──
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { const s = localStorage.getItem('errlog_sidebarCollapsed'); return s ? JSON.parse(s) : false; } catch { return false; } });
  const [toolList, setToolList] = useState(() => { try { const s = localStorage.getItem('errlog_toolList'); return s ? JSON.parse(s) : DEFAULT_TOOLS; } catch { return DEFAULT_TOOLS; } });
  const [langList, setLangList] = useState(() => { try { const s = localStorage.getItem('errlog_langList'); return s ? JSON.parse(s) : DEFAULT_LANGS; } catch { return DEFAULT_LANGS; } });

  // ── Log modal state ──
  const [rawInput, setRawInput] = useState('');
  const [parsed, setParsed] = useState(null);
  const [parseStatus, setParseStatus] = useState(null);
  const [editP, setEditP] = useState({});

  // ── New project state ──
  const [newProjName, setNewProjName] = useState('');
  const [newProjColor, setNewProjColor] = useState(PROJ_COLORS[0]);
  const [newProjPhase, setNewProjPhase] = useState('RTL Design');

  // ── Auth listener ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Load data when user logs in / clears on logout ──
  useEffect(() => {
    if (!user) { setProjects([]); setErrors([]); setActiveProj(null); return; }
    loadData();
  }, [user]);

  // ── Theme: apply to <html> + persist ──
  useEffect(() => {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('errlog_theme', theme); } catch {}
  }, [theme]);

  // ── Persist UI preferences ──
  useEffect(() => { localStorage.setItem('errlog_sidebarCollapsed', JSON.stringify(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem('errlog_toolList', JSON.stringify(toolList)); }, [toolList]);
  useEffect(() => { localStorage.setItem('errlog_langList', JSON.stringify(langList)); }, [langList]);
  useEffect(() => { if (activeProj) localStorage.setItem('errlog_activeProj', JSON.stringify(activeProj)); }, [activeProj]);

  // ── DB field mapping (DB uses snake_case, React uses camelCase) ──
  function fromDb(r) {
    return { ...r, projId: r.proj_id, resolutionTitle: r.resolution_title };
  }
  function toDb(obj) {
    const out = { ...obj };
    if ('projId' in out) { out.proj_id = out.projId; delete out.projId; }
    if ('resolutionTitle' in out) { out.resolution_title = out.resolutionTitle; delete out.resolutionTitle; }
    delete out.id; delete out.user_id; delete out.created_at; delete out.proj_id_alias;
    return out;
  }

  // ── Load all data from Supabase ──
  async function loadData() {
    const [{ data: projs }, { data: errs }] = await Promise.all([
      supabase.from('projects').select('*').order('created_at'),
      supabase.from('errors').select('*').order('created_at'),
    ]);
    const mappedProjs = projs || [];
    const mappedErrs = (errs || []).map(fromDb);
    setProjects(mappedProjs);
    setErrors(mappedErrs);
    const saved = (() => { try { return JSON.parse(localStorage.getItem('errlog_activeProj')); } catch { return null; } })();
    if (saved && mappedProjs.find(p => p.id === saved)) setActiveProj(saved);
    else if (mappedProjs.length > 0) setActiveProj(mappedProjs[0].id);
  }

  // ── Debounced DB save — collects rapid field edits before flushing ──
  const pendingPatches = useRef({});
  const dbSaveTimer = useRef(null);
  function updateError(id, patch) {
    setErrors(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
    pendingPatches.current[id] = { ...(pendingPatches.current[id] || {}), ...patch };
    clearTimeout(dbSaveTimer.current);
    dbSaveTimer.current = setTimeout(async () => {
      const all = pendingPatches.current;
      pendingPatches.current = {};
      for (const [eid, p] of Object.entries(all)) {
        await supabase.from('errors').update(toDb(p)).eq('id', eid);
      }
    }, 600);
  }

  // ── CRUD ──
  async function submitError() {
    const entry = {
      user_id: user.id, proj_id: activeProj,
      code: editP.code || '', tool: editP.tool || '', lang: editP.lang || '',
      file: editP.file || '', line: editP.line || '', severity: editP.severity || 'Error',
      description: editP.description || 'Unknown error', notes: editP.notes || '',
      resolution_title: '', resolution: '', resolved: false,
      tags: editP.tags || [], date: new Date().toISOString().slice(0, 10),
    };
    const dupe = errors.find(e => e.projId === activeProj && e.code && e.code === entry.code && e.resolved);
    const { data, error } = await supabase.from('errors').insert(entry).select().single();
    if (error) { showToast('Failed to save error'); return; }
    const mapped = fromDb(data);
    setErrors(prev => [...prev, mapped]);
    setShowLog(false);
    setDetailId(mapped.id);
    if (dupe) showToast(`⚡ You fixed ${entry.code} before — check your previous resolution!`);
    else showToast('Error logged');
  }

  // ── Bulk import parsed errors from a log file ──
  async function importErrors(list, projId) {
    if (!list.length || !projId) return;
    const today = new Date().toISOString().slice(0, 10);
    const entries = list.map(r => ({
      user_id: user.id, proj_id: projId,
      code: r.code || '', tool: r.tool || '', lang: r.lang || '',
      file: r.file || '', line: r.line || '', severity: r.severity || 'Error',
      description: r.description || 'Unknown error', notes: '',
      resolution_title: '', resolution: '', resolved: false,
      tags: r.tags || [], date: today,
    }));
    const { data, error } = await supabase.from('errors').insert(entries).select();
    if (error) { showToast('Import failed — please try again'); return; }
    setErrors(prev => [...prev, ...data.map(fromDb)]);
    setShowImport(false);
    setActiveProj(projId);
    showToast(`Imported ${data.length} error${data.length !== 1 ? 's' : ''}`);
  }

  async function deleteError(id) {
    setErrors(prev => prev.filter(e => e.id !== id));
    setDetailId(null);
    await supabase.from('errors').delete().eq('id', id);
    showToast('Error deleted');
  }

  async function createProject() {
    if (!newProjName.trim()) return;
    const { data, error } = await supabase.from('projects')
      .insert({ user_id: user.id, name: newProjName.trim(), color: newProjColor, phase: newProjPhase })
      .select().single();
    if (error) { showToast('Failed to create project'); return; }
    setProjects(prev => [...prev, data]);
    setActiveProj(data.id);
    setShowNewProj(false);
    showToast(`Project "${data.name}" created`);
  }

  async function logout() {
    await supabase.auth.signOut();
    setProjects([]); setErrors([]); setActiveProj(null); setDetailId(null);
  }

  async function resendVerification() {
    await supabase.auth.resend({ type: 'signup', email: user.email });
    showToast('Verification email resent — check your inbox.');
  }

  // ── Export backup ──
  function exportData() {
    const data = { projects, errors, toolList, langList };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `errorlog-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  }

  async function clearAllData() {
    if (!confirm('Delete ALL your data from the cloud? This cannot be undone.')) return;
    await supabase.from('errors').delete().eq('user_id', user.id);
    await supabase.from('projects').delete().eq('user_id', user.id);
    setProjects([]); setErrors([]); setActiveProj(null); setDetailId(null);
    showToast('All data cleared');
  }

  // ── Toast ──
  const toastTimer = useRef(null);
  function showToast(msg) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  function handlePasteInput(v) {
    setRawInput(v);
    if (v.trim().length < 5) { setParsed(null); setParseStatus(null); setEditP({}); return; }
    const { result, parseStatus: ps } = parseError(v);
    setParsed(result); setParseStatus(ps); setEditP({ ...result });
  }

  const projErrors = errors.filter(e => e.projId === activeProj);
  const openCount = projErrors.filter(e => !e.resolved).length;
  const resolvedCount = projErrors.filter(e => e.resolved).length;
  const activeP = projects.find(p => p.id === activeProj);

  // Smart filter chips — built from the categories actually present in this project
  const tagCounts = {};
  projErrors.forEach(e => (e.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const smartTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);

  const filtered = projErrors
    .filter(e => { if (filter === 'open') return !e.resolved; if (filter === 'resolved') return e.resolved; return true; })
    .filter(e => !categoryFilter || (e.tags || []).includes(categoryFilter))
    .filter(e => {
      if (!search) return true;
      const q = search.toLowerCase();
      return e.code.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) ||
        e.file.toLowerCase().includes(q) || e.tool.toLowerCase().includes(q) ||
        e.tags.some(t => t.includes(q));
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const detail = detailId ? errors.find(e => e.id === detailId) : null;

  // On mobile the sidebar is an off-canvas drawer that always shows the full
  // (expanded) content; on desktop it honors the user's collapse preference.
  const collapsed = isMobile ? false : sidebarCollapsed;

  // ── Auth gates ──
  if (authLoading) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', color: '#999', fontSize: 14, fontFamily: 'system-ui' }}>
      Loading...
    </div>
  );
  if (!user) {
    if (authMode === null) return <LandingPage onLogin={() => setAuthMode('login')} onSignUp={() => setAuthMode('signup')} />;
    return <AuthScreen initialMode={authMode} onBack={() => setAuthMode(null)} />;
  }
  if (isRecovery) return <ResetPasswordScreen onDone={() => setIsRecovery(false)} />;

  const unverified = user && !user.email_confirmed_at && !verifyDismissed;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'var(--font-sans, system-ui)', background: 'var(--color-background-tertiary)', color: 'var(--color-text-primary)', overflow: 'hidden' }}>

      <style>{`.sl-h{transition:background 0.12s ease;border-radius:7px}.sl-h:hover{background:rgba(0,0,0,0.048)!important}`}</style>

      {/* ── VERIFICATION BANNER ── */}
      {unverified && (
        <div style={{ background: '#FAEEDA', borderBottom: '1px solid #e6c97a', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#854F0B', flexShrink: 0, zIndex: 60 }}>
          <span>⚠</span>
          <span style={{ flex: 1 }}>
            Please verify your account — check your inbox for a confirmation email.{' '}
            <button onClick={resendVerification}
              style={{ background: 'none', border: 'none', color: '#854F0B', textDecoration: 'underline', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, padding: 0 }}>
              Resend email
            </button>
          </span>
          <button onClick={() => setVerifyDismissed(true)}
            style={{ background: 'none', border: 'none', color: '#BA7517', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', fontFamily: 'inherit' }}>
            ×
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* ── SIDEBAR ── */}
      {isMobile && mobileSidebar && (
        <div onClick={() => setMobileSidebar(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 69 }} />
      )}
      <div style={{
        width: collapsed ? 44 : (isMobile ? 248 : 220), minWidth: collapsed ? 44 : (isMobile ? 248 : 220),
        background: 'var(--color-background-primary)', borderRight: '0.5px solid var(--color-border-tertiary)',
        display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden',
        ...(isMobile
          ? { position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 70, transform: mobileSidebar ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.25s ease', boxShadow: mobileSidebar ? '0 0 50px rgba(0,0,0,0.35)' : 'none' }
          : { transition: 'width 0.2s, min-width 0.2s' }),
      }}>

        {collapsed ? (
          /* ── COLLAPSED ── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
            <div style={{ padding: '14px 0 12px', borderBottom: '0.5px solid var(--color-border-tertiary)', width: '100%', display: 'flex', justifyContent: 'center' }}>
              <button onClick={() => setSidebarCollapsed(false)} title="Expand sidebar"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: '4px 6px', borderRadius: 5, display: 'flex', flexDirection: 'column', gap: 3.5, alignItems: 'center' }}>
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
              </button>
            </div>
            <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1 }}>
              {projects.map(p => (
                <div key={p.id} onClick={() => { setActiveProj(p.id); setDetailId(null); setFilter('all'); setSearch(''); setCategoryFilter(null); setMobileSidebar(false); }}
                  title={p.name}
                  style={{ width: 10, height: 10, borderRadius: '50%', background: p.color, cursor: 'pointer', border: p.id === activeProj ? '2px solid var(--color-text-primary)' : '2px solid transparent', boxSizing: 'border-box' }} />
              ))}
              <div onClick={() => { setSidebarCollapsed(false); setShowNewProj(true); setNewProjName(''); setNewProjColor(PROJ_COLORS[0]); }}
                title="New project"
                style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed var(--color-border-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14, color: 'var(--color-text-tertiary)', marginTop: 2 }}>+</div>
            </div>
            <div style={{ paddingBottom: 14, paddingTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, borderTop: '0.5px solid var(--color-border-tertiary)', width: '100%' }}>
              <button onClick={() => setShowExport(true)} title="Export to Excel"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>↓</button>
              <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>{theme === 'dark' ? '☀' : '☾'}</button>
              <button onClick={() => setShowProfile(true)} title="My profile"
                style={{ width: 26, height: 26, borderRadius: '50%', background: avatarColor(user.email), border: 'none', cursor: 'pointer', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {(user.user_metadata?.display_name || user.email || '?')[0].toUpperCase()}
              </button>
              <button onClick={logout} title="Sign out"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>⏻</button>
            </div>
          </div>
        ) : (
          /* ── EXPANDED ── */
          <>
            {/* Logo */}
            <div style={{ padding: '14px 14px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid var(--color-border-tertiary)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="18" height="18" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
                  <rect width="32" height="32" rx="7" fill="#D97757"/>
                  <rect x="8" y="8" width="3.5" height="16" fill="white"/>
                  <rect x="8" y="8" width="15" height="3" fill="white"/>
                  <rect x="8" y="14.5" width="11" height="2.5" fill="white"/>
                  <rect x="8" y="21" width="15" height="3" fill="white"/>
                </svg>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--color-text-primary)' }}>ErrorLog</span>
              </div>
              <button onClick={() => isMobile ? setMobileSidebar(false) : setSidebarCollapsed(true)} title={isMobile ? 'Close menu' : 'Collapse sidebar'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: '4px 5px', borderRadius: 5, display: 'flex', flexDirection: 'column', gap: 3.5, alignItems: 'center' }}>
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 14, height: 1.8, borderRadius: 1, background: 'currentColor' }} />
              </button>
            </div>

            {/* Projects */}
            <div style={{ padding: '10px 6px 6px' }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '2px 10px 6px' }}>Projects</div>
              {projects.map(p => {
                const pOpen = errors.filter(e => e.projId === p.id && !e.resolved).length;
                return (
                  <div key={p.id} onClick={() => { setActiveProj(p.id); setDetailId(null); setFilter('all'); setSearch(''); setCategoryFilter(null); setMobileSidebar(false); }}
                    className="sl-h"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, margin: '1px 4px', cursor: 'pointer', fontSize: 13, background: p.id === activeProj ? 'var(--color-background-secondary)' : 'transparent', color: p.id === activeProj ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: p.id === activeProj ? 500 : 400 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, minWidth: 8 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {pOpen > 0
                      ? <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: '#FAECE7', color: '#993C1D', fontWeight: 600 }}>{pOpen}</span>
                      : <span style={{ fontSize: 11, color: '#639922' }}>✓</span>}
                  </div>
                );
              })}
              <div onClick={() => { setShowNewProj(true); setNewProjName(''); setNewProjColor(PROJ_COLORS[0]); setMobileSidebar(false); }}
                className="sl-h"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 7, margin: '2px 4px', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New project
              </div>
            </div>

            {/* Bottom stack */}
            <div style={{ marginTop: 'auto' }}>

              {/* Stats */}
              <div style={{ padding: '12px 16px 10px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
                  <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1 }}>{errors.length}</span> errors logged
                  <br />across <span style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{projects.length}</span> project{projects.length !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Export */}
              <div style={{ padding: '6px 10px 6px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                <button onClick={() => setShowExport(true)}
                  className="sl-h"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 7, border: '0.5px solid var(--color-border-secondary)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', textAlign: 'left' }}>
                  <span>↓</span> Export errors (.xlsx)
                </button>
              </div>

              {/* Appearance / theme */}
              <div style={{ padding: '6px 10px 6px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px' }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: 1, paddingLeft: 4 }}>Appearance</span>
                  {[['light', '☀', 'Light'], ['dark', '☾', 'Dark']].map(([val, icon, lbl]) => (
                    <button key={val} onClick={() => setTheme(val)} title={lbl}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', border: '0.5px solid', borderColor: theme === val ? 'var(--color-border-primary)' : 'var(--color-border-tertiary)', background: theme === val ? 'var(--color-background-secondary)' : 'transparent', color: theme === val ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', fontWeight: theme === val ? 600 : 400 }}>
                      <span>{icon}</span>{lbl}
                    </button>
                  ))}
                </div>
              </div>

              {/* Profile + Sign out */}
              <div style={{ padding: '6px 10px 4px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                <button onClick={() => setShowProfile(true)}
                  className="sl-h"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 7, border: '0.5px solid var(--color-border-secondary)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', marginBottom: 4 }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: avatarColor(user.email), color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {(user.user_metadata?.display_name || user.email || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {user.user_metadata?.display_name || 'My Profile'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>›</span>
                </button>
                <button onClick={logout}
                  className="sl-h"
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                  Sign out
                </button>
              </div>

              {/* Built by */}
              <div style={{ padding: '8px 16px 16px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
                  Built by{' '}
                  <a href="https://www.linkedin.com/in/akash-biyani" target="_blank" rel="noopener noreferrer"
                    style={{ color: 'var(--color-text-tertiary)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
                    Akash Biyani
                  </a>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── MAIN ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginRight: detail && !isMobile ? 390 : 0, transition: 'margin-right 0.2s', minWidth: 0 }}>
        {projects.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: 'var(--color-text-tertiary)', padding: 40 }}>
            <div style={{ fontSize: 40 }}>◎</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-secondary)' }}>No projects yet</div>
            <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 280 }}>Create a project to start logging EDA errors across your RTL designs.</div>
            <button onClick={() => { setShowNewProj(true); setNewProjName(''); setNewProjColor(PROJ_COLORS[0]); setNewProjPhase('RTL Design'); }}
              style={{ padding: '9px 20px', borderRadius: 8, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              + New project
            </button>
          </div>
        )}
        {projects.length > 0 && (<>
          {/* Topbar */}
          <div style={{ background: 'var(--color-background-primary)', borderBottom: '0.5px solid var(--color-border-tertiary)', padding: isMobile ? '10px 14px' : '10px 20px', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexWrap: 'wrap' }}>
            {isMobile && (
              <button onClick={() => setMobileSidebar(true)} title="Menu"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '2px 6px 2px 0', display: 'flex', flexDirection: 'column', gap: 3.5, alignItems: 'center', flexShrink: 0 }}>
                <span style={{ display: 'block', width: 18, height: 2, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 18, height: 2, borderRadius: 1, background: 'currentColor' }} />
                <span style={{ display: 'block', width: 18, height: 2, borderRadius: 1, background: 'currentColor' }} />
              </button>
            )}
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: activeP?.color, flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{activeP?.name}</span>
            <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: '#FAECE7', color: '#993C1D', fontWeight: 500 }}>{openCount} open</span>
            <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: '#EAF3DE', color: '#3B6D11', fontWeight: 500 }}>{resolvedCount} resolved</span>
            <button onClick={() => setShowImport(true)} title="Import a full log file"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7, background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
              ⬆ Import log
            </button>
            <button onClick={() => { setShowLog(true); setRawInput(''); setParsed(null); setParseStatus(null); setEditP({}); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              + Log Error
            </button>
          </div>

          {/* Filters */}
          <div style={{ padding: '12px 20px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-primary)' }}>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>⌕</span>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search errors..."
                style={{ paddingLeft: 26, paddingRight: 10, paddingTop: 5, paddingBottom: 5, borderRadius: 7, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 190 }} />
            </div>
            {['all', 'open', 'resolved'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ padding: '5px 13px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: '0.5px solid', borderColor: filter === f ? 'var(--color-border-primary)' : 'var(--color-border-tertiary)', background: filter === f ? 'var(--color-background-secondary)' : 'transparent', color: filter === f ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: filter === f ? 500 : 400, fontFamily: 'inherit' }}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            {smartTags.length > 0 && <span style={{ width: 1, height: 18, background: 'var(--color-border-tertiary)', margin: '0 2px' }} />}
            {smartTags.map(t => {
              const active = categoryFilter === t;
              return (
                <button key={t} onClick={() => setCategoryFilter(active ? null : t)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: '0.5px solid', borderColor: active ? '#185FA5' : 'var(--color-border-tertiary)', background: active ? '#E6F1FB' : 'transparent', color: active ? '#185FA5' : 'var(--color-text-tertiary)', fontWeight: active ? 600 : 400, fontFamily: 'inherit' }}>
                  {t}<span style={{ fontSize: 10, opacity: 0.7 }}>{tagCounts[t]}</span>
                </button>
              );
            })}
          </div>

          {/* Error List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
            {filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--color-text-tertiary)' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>◎</div>
                <div style={{ fontSize: 15, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  {filter === 'resolved' ? 'No resolved errors yet' : filter === 'open' ? 'No open errors — nice!' : 'No errors logged yet'}
                </div>
                <div style={{ fontSize: 13 }}>{filter === 'all' ? 'Click "Log Error" to get started.' : ''}</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filtered.map(e => {
                  const sev = SEV_COLOR[e.severity] || SEV_COLOR.Error;
                  return (
                    <div key={e.id} onClick={() => setDetailId(detailId === e.id ? null : e.id)}
                      style={{ background: 'var(--color-background-primary)', border: '0.5px solid', borderColor: detailId === e.id ? 'var(--color-border-primary)' : 'var(--color-border-tertiary)', borderLeft: `3px solid ${e.resolved ? '#639922' : sev.border}`, borderRadius: 10, padding: '13px 15px', cursor: 'pointer', opacity: e.resolved ? 0.85 : 1 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 5, fontFamily: 'monospace', whiteSpace: 'nowrap', background: e.resolved ? '#EAF3DE' : sev.bg, color: e.resolved ? '#3B6D11' : sev.text }}>{e.code || '—'}</span>
                        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, lineHeight: 1.45 }}>{e.description}</span>
                        {e.resolved && <span style={{ color: '#639922', fontSize: 16, marginTop: 1 }}>✓</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {e.tool && <span style={{ padding: '2px 7px', borderRadius: 4, background: 'var(--color-background-secondary)', fontWeight: 500 }}>{e.tool}</span>}
                        {e.lang && <span style={{ padding: '2px 7px', borderRadius: 4, background: 'var(--color-background-secondary)', fontWeight: 500 }}>{e.lang}</span>}
                        {e.file && <span>📄 {e.file}{e.line ? `:${e.line}` : ''}</span>}
                        <span>🗓 {e.date}</span>
                        {e.tags.map(t => <span key={t} style={{ padding: '2px 7px', borderRadius: 4, background: '#E6F1FB', color: '#185FA5', fontWeight: 500 }}>{t}</span>)}
                      </div>
                      {e.notes && <div style={{ marginTop: 8, padding: '7px 10px', background: 'var(--color-background-secondary)', borderRadius: 6, fontSize: 12, color: 'var(--color-text-secondary)', borderLeft: '2px solid var(--color-border-secondary)' }}>📝 {e.notes}</div>}
                      {e.resolved && e.resolutionTitle && (
                        <div style={{ marginTop: 8 }}>
                          <div onClick={ev => { ev.stopPropagation(); setResExpanded(r => ({ ...r, [e.id]: !r[e.id] })); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: '#EAF3DE', borderRadius: resExpanded[e.id] ? '6px 6px 0 0' : 6, fontSize: 12, color: '#3B6D11', borderLeft: '2px solid #639922', cursor: 'pointer', userSelect: 'none' }}>
                            <span>💡</span>
                            <span style={{ fontWeight: 600 }}>Fix:</span>
                            <span style={{ flex: 1 }}>{e.resolutionTitle}</span>
                            <span style={{ fontSize: 10 }}>{resExpanded[e.id] ? '▲' : '▼'}</span>
                          </div>
                          {resExpanded[e.id] && e.resolution && (
                            <div style={{ padding: '8px 10px', background: '#f0f9e8', borderRadius: '0 0 6px 6px', fontSize: 12, color: '#3B6D11', lineHeight: 1.6, borderLeft: '2px solid #639922', borderTop: '1px solid #c5e8a0' }}>
                              {e.resolution}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>)}
      </div>

      {/* ── DETAIL PANEL ── */}
      {detail && (
        <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: isMobile ? '100%' : 390, maxWidth: '100vw', background: 'var(--color-background-primary)', borderLeft: '0.5px solid var(--color-border-tertiary)', zIndex: 40, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 5, fontFamily: 'monospace', background: detail.resolved ? '#EAF3DE' : (SEV_COLOR[detail.severity]?.bg || '#FAECE7'), color: detail.resolved ? '#3B6D11' : (SEV_COLOR[detail.severity]?.text || '#993C1D') }}>{detail.code || '—'}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail.description.slice(0, 36)}{detail.description.length > 36 ? '…' : ''}</span>
            <button onClick={() => setDetailId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>×</button>
          </div>
          <div style={{ padding: '16px 18px', flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 12, padding: '5px 8px', background: 'var(--color-background-secondary)', borderRadius: 5, display: 'flex', gap: 5, alignItems: 'center' }}>
              <span>✎</span> Click any field below to edit it
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>Error info</div>
              <EditableField label="Code" value={detail.code} mono onChange={v => updateError(detail.id, { code: v })} />
              <EditableSelect label="Severity" value={detail.severity} options={['Error','Warning','Critical','Info']} onChange={v => updateError(detail.id, { severity: v })} />
              <EditableField label="File" value={detail.file} mono onChange={v => updateError(detail.id, { file: v })} />
              <EditableField label="Line" value={detail.line} mono onChange={v => updateError(detail.id, { line: v })} />
              <EditableSelect label="Tool" value={detail.tool} options={toolList} onChange={v => updateError(detail.id, { tool: v })} />
              <EditableSelect label="Language" value={detail.lang} options={langList} onChange={v => updateError(detail.id, { lang: v })} />
              <EditableField label="Date" value={detail.date} onChange={v => updateError(detail.id, { date: v })} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Description</div>
            <EditableField label="" value={detail.description} multiline onChange={v => updateError(detail.id, { description: v })} />
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, marginTop: 6 }}>Tags</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {ALL_TAGS.map(t => {
                const active = (detail.tags || []).includes(t);
                return (
                  <span key={t} onClick={() => updateError(detail.id, { tags: active ? detail.tags.filter(x => x !== t) : [...detail.tags, t] })}
                    style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer', border: '0.5px solid', borderColor: active ? '#185FA5' : 'var(--color-border-tertiary)', background: active ? '#E6F1FB' : 'transparent', color: active ? '#185FA5' : 'var(--color-text-tertiary)', fontWeight: active ? 500 : 400 }}>
                    {t}
                  </span>
                );
              })}
            </div>
            <hr style={{ border: 'none', borderTop: '0.5px solid var(--color-border-tertiary)', margin: '14px 0' }} />
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Notes</div>
            <textarea value={detail.notes} onChange={e => updateError(detail.id, { notes: e.target.value })}
              placeholder="Add context about this error..."
              style={{ width: '100%', minHeight: 68, padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box', marginBottom: 14 }} />
            <hr style={{ border: 'none', borderTop: '0.5px solid var(--color-border-tertiary)', margin: '2px 0 14px' }} />
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Resolution</div>
            <input value={detail.resolutionTitle || ''} onChange={e => updateError(detail.id, { resolutionTitle: e.target.value })}
              placeholder="Short fix summary (shown in error list)..."
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 8 }} />
            <textarea value={detail.resolution || ''} onChange={e => updateError(detail.id, { resolution: e.target.value })}
              placeholder="Full resolution details — as long as you need..."
              style={{ width: '100%', minHeight: 90, padding: '8px 10px', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box', marginBottom: 14 }} />
            <button onClick={() => { updateError(detail.id, { resolved: !detail.resolved }); showToast(detail.resolved ? 'Reopened' : 'Marked as resolved ✓'); }}
              style={{ width: '100%', padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '0.5px solid', borderColor: detail.resolved ? '#639922' : 'var(--color-border-secondary)', background: detail.resolved ? '#EAF3DE' : 'var(--color-background-secondary)', color: detail.resolved ? '#3B6D11' : 'var(--color-text-primary)', fontFamily: 'inherit', marginBottom: 10 }}>
              {detail.resolved ? '✓ Resolved — click to reopen' : '◯ Mark as resolved'}
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => deleteError(detail.id)}
                style={{ flex: 1, padding: '7px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '0.5px solid var(--color-border-tertiary)', background: 'transparent', color: '#A32D2D', fontFamily: 'inherit' }}>
                🗑 Delete
              </button>
              <button onClick={() => {
                const txt = `Error: ${detail.code}\nSeverity: ${detail.severity}\nFile: ${detail.file}:${detail.line}\nTool: ${detail.tool}\n\nDescription:\n${detail.description}\n\nResolution:\n${detail.resolutionTitle ? detail.resolutionTitle + '\n' : ''}${detail.resolution || '—'}`;
                navigator.clipboard.writeText(txt).then(() => showToast('Copied to clipboard'));
              }}
                style={{ flex: 1, padding: '7px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '0.5px solid var(--color-border-tertiary)', background: 'transparent', color: 'var(--color-text-secondary)', fontFamily: 'inherit' }}>
                ⎘ Copy report
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── LOG MODAL ── */}
      {showLog && (
        <div onClick={e => e.target === e.currentTarget && setShowLog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
          <div style={{ background: '#ffffff', borderRadius: 14, border: '2px solid #d0d0d0', width: '100%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.28)' }}>
            <div style={{ padding: '22px 26px 18px', borderBottom: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#111' }}>Log new error</span>
              <button onClick={() => setShowLog(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#999', lineHeight: 1, padding: '0 4px' }}>×</button>
            </div>
            <div style={{ padding: 26 }}>
              <label style={{ fontSize: 14, color: '#111', fontWeight: 600, display: 'block', marginBottom: 8 }}>Paste error output</label>
              <textarea value={rawInput} onChange={e => handlePasteInput(e.target.value)}
                placeholder="Paste your full compiler / EDA error message here..."
                style={{ width: '100%', minHeight: 110, padding: '11px 13px', borderRadius: 8, border: '1.5px solid #c0c0c0', background: '#f7f7f7', color: '#111', fontSize: 13, fontFamily: 'monospace', outline: 'none', resize: 'vertical', boxSizing: 'border-box', marginBottom: 16 }} />
              {parsed && (
                <>
                  <div style={{ padding: '9px 13px', borderRadius: 7, marginBottom: 16, fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid', borderColor: parseStatus === 'ok' ? '#a3d47a' : parseStatus === 'partial' ? '#e6b96a' : '#e89a8a', background: parseStatus === 'ok' ? '#EAF3DE' : parseStatus === 'partial' ? '#FAEEDA' : '#FAECE7', color: parseStatus === 'ok' ? '#3B6D11' : parseStatus === 'partial' ? '#854F0B' : '#993C1D' }}>
                    <span>{parseStatus === 'ok' ? '✓' : '⚠'}</span>
                    {parseStatus === 'ok' ? 'Parsed successfully — review and confirm below' : parseStatus === 'partial' ? 'Partially parsed — fill in missing fields' : 'Could not parse — please fill in manually'}
                  </div>
                  <div style={{ background: '#f2f2f2', borderRadius: 8, padding: 16, border: '1px solid #d8d8d8', marginBottom: 16 }}>
                    {[['Error Code', 'code', 'e.g. MV-007'], ['File', 'file', 'filename.sv'], ['Line', 'line', '42'], ['Description', 'description', 'Error description']].map(([label, key, ph]) => (
                      <div key={key} style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#888', width: 88, minWidth: 88, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
                        <input value={editP[key] || ''} onChange={e => setEditP(p => ({ ...p, [key]: e.target.value }))} placeholder={ph}
                          style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid #c8c8c8', background: '#fff', color: '#111', fontSize: 13, fontFamily: key === 'code' || key === 'file' || key === 'line' ? 'monospace' : 'inherit', outline: 'none' }} />
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#888', width: 88, minWidth: 88, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Severity</span>
                      <select value={editP.severity || 'Error'} onChange={e => setEditP(p => ({ ...p, severity: e.target.value }))}
                        style={{ padding: '5px 8px', borderRadius: 5, border: '1px solid #c8c8c8', background: '#fff', color: '#111', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}>
                        {['Error', 'Warning', 'Critical', 'Info'].map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <CustomSelect label="Tool" value={editP.tool || ''} options={toolList} modalStyle
                      onChange={v => setEditP(p => ({ ...p, tool: v }))}
                      onAddOption={v => setToolList(l => l.includes(v) ? l : [...l.filter(x => x !== 'Other'), v, 'Other'])}
                      onDeleteOption={v => setToolList(l => l.filter(x => x !== v))} />
                    <CustomSelect label="Language" value={editP.lang || ''} options={langList} modalStyle
                      onChange={v => setEditP(p => ({ ...p, lang: v }))}
                      onAddOption={v => setLangList(l => l.includes(v) ? l : [...l.filter(x => x !== 'Other'), v, 'Other'])}
                      onDeleteOption={v => setLangList(l => l.filter(x => x !== v))} />
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 2 }}>
                      <span style={{ fontSize: 11, color: '#888', width: 88, minWidth: 88, textTransform: 'uppercase', letterSpacing: '0.06em', paddingTop: 4 }}>Tags</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {ALL_TAGS.map(t => {
                          const active = (editP.tags || []).includes(t);
                          return (
                            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', padding: '3px 8px', borderRadius: 5, border: '0.5px solid', borderColor: active ? '#185FA5' : '#d0d0d0', background: active ? '#E6F1FB' : 'transparent', color: active ? '#185FA5' : '#666' }}>
                              <input type="checkbox" checked={active} onChange={e => setEditP(p => ({ ...p, tags: e.target.checked ? [...(p.tags || []), t] : (p.tags || []).filter(x => x !== t) }))} style={{ margin: 0, accentColor: '#185FA5' }} />
                              {t}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <label style={{ fontSize: 13, color: '#111', fontWeight: 600, display: 'block', marginBottom: 6 }}>Notes (optional)</label>
                  <textarea value={editP.notes || ''} onChange={e => setEditP(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Any extra context..."
                    style={{ width: '100%', minHeight: 60, padding: '8px 10px', borderRadius: 6, border: '1.5px solid #c0c0c0', background: '#f7f7f7', color: '#111', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
                </>
              )}
            </div>
            <div style={{ padding: '16px 26px', borderTop: '1px solid #e8e8e8', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowLog(false)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d0d0d0', background: 'transparent', color: '#555', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>Cancel</button>
              {parsed && <button onClick={submitError} style={{ padding: '9px 20px', borderRadius: 8, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Save error</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── NEW PROJECT MODAL ── */}
      {showNewProj && (
        <div onClick={e => e.target === e.currentTarget && setShowNewProj(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, border: '2px solid #d0d0d0', width: '100%', maxWidth: 380, boxShadow: '0 24px 64px rgba(0,0,0,0.22)' }}>
            <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>New project</span>
              <button onClick={() => setShowNewProj(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#999', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: 22 }}>
              <label style={{ fontSize: 13, color: '#333', fontWeight: 600, display: 'block', marginBottom: 6 }}>Project name</label>
              <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="e.g. AXI Interconnect v2"
                onKeyDown={e => e.key === 'Enter' && createProject()}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #ccc', background: '#f7f7f7', color: '#111', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 14 }} autoFocus />
              <label style={{ fontSize: 13, color: '#333', fontWeight: 600, display: 'block', marginBottom: 6 }}>Design phase</label>
              <select value={newProjPhase} onChange={e => setNewProjPhase(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #ccc', background: '#f7f7f7', color: '#111', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 14 }}>
                {PHASES.map(p => <option key={p}>{p}</option>)}
              </select>
              <label style={{ fontSize: 13, color: '#333', fontWeight: 600, display: 'block', marginBottom: 8 }}>Color</label>
              <div style={{ display: 'flex', gap: 10 }}>
                {PROJ_COLORS.map(c => (
                  <div key={c} onClick={() => setNewProjColor(c)}
                    style={{ width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer', outline: newProjColor === c ? `3px solid ${c}` : 'none', outlineOffset: 2, border: newProjColor === c ? '2px solid #fff' : '2px solid transparent', boxSizing: 'border-box' }} />
                ))}
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e8e8e8', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowNewProj(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #ccc', background: 'transparent', color: '#555', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>Cancel</button>
              <button onClick={createProject} style={{ padding: '8px 18px', borderRadius: 8, background: '#E24B4A', color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── EXPORT MODAL ── */}
      {showExport && <ExportModal projects={projects} errors={errors} onClose={() => setShowExport(false)} />}

      {/* ── IMPORT LOG MODAL ── */}
      {showImport && <ImportLogModal projects={projects} activeProj={activeProj} onClose={() => setShowImport(false)} onImport={importErrors} />}

      {/* ── PROFILE MODAL ── */}
      {showProfile && <ProfileModal user={user} errors={errors} onClose={() => setShowProfile(false)} />}

      {/* ── TOAST ── */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 8, padding: '9px 16px', fontSize: 13, zIndex: 200, whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,0.12)' }}>
          {toast}
        </div>
      )}
      </div>{/* end inner flex row */}
    </div>
  );
}
