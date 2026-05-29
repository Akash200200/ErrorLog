import { useState, useEffect, useRef } from "react";
import { supabase } from './src/supabase.js';

const DEFAULT_TOOLS = ['Vivado', 'Synopsys DC', 'Cadence Innovus', 'ModelSim', 'VCS', 'Quartus', 'Design Compiler', 'Genus', 'Xcelium', 'Other'];
const DEFAULT_LANGS = ['SystemVerilog', 'Verilog', 'VHDL', 'C', 'Python', 'TCL', 'Other'];
const PHASES = ['RTL Design', 'Synthesis', 'Place & Route', 'Simulation', 'Lint', 'Other'];
const ALL_TAGS = ['timing', 'CDC', 'lint', 'synthesis', 'power', 'area', 'simulation', 'DRC'];
const PROJ_COLORS = ['#E24B4A', '#185FA5', '#1D9E75', '#BA7517', '#7F77DD', '#D4537E'];

function parseError(raw) {
  const r = raw.trim();
  const result = { code: '', tool: '', lang: '', file: '', line: '', severity: 'Error', description: '', tags: [] };
  const codeMatch = r.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/);
  if (codeMatch) result.code = codeMatch[1];
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
  else if (/\bvcs\b/i.test(r)) result.tool = 'VCS';
  else if (/quartus/i.test(r)) result.tool = 'Quartus';
  let desc = r.replace(/^\s*[\[\(]?[A-Z][A-Z0-9_]+\-\d+[\]\)]?\s*[:\-]?\s*/, '').replace(/["']?[\w\/]+\.(sv|v|vhd|vhdl|c|h)["']?/gi, '').replace(/line[:\s]*\d+/gi, '').replace(/\s{2,}/g, ' ').trim();
  const sentences = desc.split(/[.\n]+/).map(s => s.trim()).filter(s => s.length > 8);
  result.description = sentences[0] || desc.slice(0, 140);
  if (/timing|slack|setup|hold/i.test(r)) result.tags.push('timing');
  if (/cdc|clock.domain|synchroniz/i.test(r)) result.tags.push('CDC');
  if (/loop|latch|combinator/i.test(r)) result.tags.push('synthesis');
  if (/width|port|connect|mismatch/i.test(r)) result.tags.push('lint');
  const filled = [result.code, result.file, result.description].filter(Boolean).length;
  return { result, parseStatus: filled >= 3 ? 'ok' : filled >= 1 ? 'partial' : 'fail' };
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

// ── Reset Password Screen (shown after clicking email reset link) ──
function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  async function handleReset(e) {
    e.preventDefault();
    if (password !== confirm) { setMsg({ type: 'error', text: 'Passwords do not match.' }); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setMsg({ type: 'error', text: error.message });
    else { setMsg({ type: 'success', text: 'Password updated! Signing you in...' }); setTimeout(onDone, 1200); }
    setLoading(false);
  }

  const inp = { padding: '9px 11px', borderRadius: 7, border: '1px solid #d0d0d0', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', color: '#111', marginBottom: 12 };

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e0e0e0', width: '100%', maxWidth: 360, padding: '32px 28px 24px', boxShadow: '0 8px 40px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E24B4A', display: 'inline-block' }} />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: '#111' }}>ErrorLog</span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 4 }}>Set new password</div>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 22 }}>Choose a new password for your account.</div>
        <form onSubmit={handleReset}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>New password</div>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} autoFocus style={inp} />
          <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Confirm password</div>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={6} style={{ ...inp, marginBottom: 18 }} />
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
function AuthScreen() {
  const [mode, setMode] = useState('login');
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
      const { error } = await supabase.auth.signUp({ email, password });
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

  const inp = { padding: '9px 11px', borderRadius: 7, border: '1px solid #d0d0d0', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', color: '#111', marginBottom: 12 };

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e0e0e0', width: '100%', maxWidth: 360, padding: '32px 28px 24px', boxShadow: '0 8px 40px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E24B4A', display: 'inline-block' }} />
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: '#111' }}>ErrorLog</span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 4 }}>
          {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
        </div>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 22 }}>
          {mode === 'login' ? 'Welcome back.' : mode === 'signup' ? 'Start logging your EDA errors.' : 'Enter your email and we\'ll send a reset link.'}
        </div>
        <form onSubmit={mode === 'forgot' ? handleForgot : handleSubmit}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email</div>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={inp} />
          {mode !== 'forgot' && <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Password</div>
              {mode === 'login' && (
                <button type="button" onClick={() => { setMode('forgot'); setMsg({ type: '', text: '' }); }}
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 12, padding: 0, fontFamily: 'inherit' }}>
                  Forgot password?
                </button>
              )}
            </div>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} style={{ ...inp, marginBottom: 18 }} />
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
        <div style={{ marginTop: 16, fontSize: 13, color: '#999', textAlign: 'center' }}>
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
      </div>
    </div>
  );
}

export default function App() {
  // ── Auth ──
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);

  // ── App state ──
  const [projects, setProjects] = useState([]);
  const [errors, setErrors] = useState([]);
  const [activeProj, setActiveProj] = useState(null);
  const [filter, setFilter] = useState('all');
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

  const filtered = projErrors
    .filter(e => { if (filter === 'open') return !e.resolved; if (filter === 'resolved') return e.resolved; return true; })
    .filter(e => {
      if (!search) return true;
      const q = search.toLowerCase();
      return e.code.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) ||
        e.file.toLowerCase().includes(q) || e.tool.toLowerCase().includes(q) ||
        e.tags.some(t => t.includes(q));
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const detail = detailId ? errors.find(e => e.id === detailId) : null;

  // ── Auth gates ──
  if (authLoading) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background-tertiary, #f5f5f5)', color: '#999', fontSize: 14, fontFamily: 'system-ui' }}>
      Loading...
    </div>
  );
  if (!user) return <AuthScreen />;
  if (isRecovery) return <ResetPasswordScreen onDone={() => setIsRecovery(false)} />;

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'var(--font-sans, system-ui)', background: 'var(--color-background-tertiary)', color: 'var(--color-text-primary)', overflow: 'hidden' }}>

      {/* ── SIDEBAR ── */}
      <div style={{ width: sidebarCollapsed ? 44 : 220, minWidth: sidebarCollapsed ? 44 : 220, background: 'var(--color-background-primary)', borderRight: '0.5px solid var(--color-border-tertiary)', display: 'flex', flexDirection: 'column', overflowY: 'auto', transition: 'width 0.2s, min-width 0.2s', overflow: 'hidden' }}>

        {/* Logo + collapse */}
        <div style={{ padding: sidebarCollapsed ? '16px 0' : '18px 16px 10px', display: 'flex', alignItems: 'center', gap: 8, justifyContent: sidebarCollapsed ? 'center' : 'space-between' }}>
          {!sidebarCollapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#E24B4A', display: 'inline-block' }} />
              <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em' }}>ErrorLog</span>
            </div>
          )}
          <button onClick={() => setSidebarCollapsed(v => !v)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--color-text-tertiary)', padding: '2px 4px', borderRadius: 5, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>

        {/* Collapsed */}
        {sidebarCollapsed ? (
          <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
            {projects.map(p => (
              <div key={p.id} onClick={() => { setActiveProj(p.id); setDetailId(null); setFilter('all'); setSearch(''); }}
                title={p.name}
                style={{ width: 10, height: 10, borderRadius: '50%', background: p.color, cursor: 'pointer', border: p.id === activeProj ? '2px solid var(--color-text-primary)' : '2px solid transparent', boxSizing: 'border-box' }} />
            ))}
            <div onClick={() => { setSidebarCollapsed(false); setShowNewProj(true); setNewProjName(''); setNewProjColor(PROJ_COLORS[0]); }}
              title="New project"
              style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed var(--color-border-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14, color: 'var(--color-text-tertiary)', marginTop: 2 }}>+</div>
            <div style={{ marginTop: 'auto', paddingBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <button onClick={exportData} title="Export backup" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>↑</button>
              <button onClick={clearAllData} title="Clear all data" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#c44', lineHeight: 1 }}>✕</button>
              <button onClick={logout} title="Sign out" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1 }}>⏻</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: '8px 6px 4px' }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '4px 10px 6px' }}>Projects</div>
              {projects.map(p => {
                const pOpen = errors.filter(e => e.projId === p.id && !e.resolved).length;
                return (
                  <div key={p.id} onClick={() => { setActiveProj(p.id); setDetailId(null); setFilter('all'); setSearch(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, margin: '1px 4px', cursor: 'pointer', fontSize: 13, background: p.id === activeProj ? 'var(--color-background-secondary)' : 'transparent', color: p.id === activeProj ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: p.id === activeProj ? 500 : 400 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, minWidth: 8 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {pOpen > 0
                      ? <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: '#FAECE7', color: '#993C1D', fontWeight: 600 }}>{pOpen}</span>
                      : <span style={{ fontSize: 11, color: '#639922' }}>✓</span>}
                  </div>
                );
              })}
              <div onClick={() => { setShowNewProj(true); setNewProjName(''); setNewProjColor(PROJ_COLORS[0]); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, margin: '2px 4px', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New project
              </div>
            </div>
            <div style={{ marginTop: 'auto', padding: '14px 14px 18px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Total logged</div>
              <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.1 }}>{errors.length}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>across {projects.length} projects</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button onClick={exportData} title="Export backup JSON"
                  style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '0.5px solid var(--color-border-secondary)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                  ↑ Export
                </button>
                <button onClick={clearAllData} title="Clear all data"
                  style={{ padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--color-border-tertiary)', background: 'transparent', color: '#c44', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                  ✕
                </button>
              </div>
              <button onClick={logout}
                style={{ width: '100%', marginTop: 8, padding: '5px 0', borderRadius: 6, border: '0.5px solid var(--color-border-tertiary)', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                Sign out — {user.email}
              </button>
              <div style={{ marginTop: 14, fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
                Built by{' '}
                <a href="https://www.linkedin.com/in/akash-biyani" target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--color-text-tertiary)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
                  Akash Biyani
                </a>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── MAIN ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginRight: detail ? 390 : 0, transition: 'margin-right 0.2s' }}>
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
          <div style={{ background: 'var(--color-background-primary)', borderBottom: '0.5px solid var(--color-border-tertiary)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: activeP?.color }} />
            <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{activeP?.name}</span>
            <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: '#FAECE7', color: '#993C1D', fontWeight: 500 }}>{openCount} open</span>
            <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: '#EAF3DE', color: '#3B6D11', fontWeight: 500 }}>{resolvedCount} resolved</span>
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
            {['timing', 'CDC', 'lint', 'synthesis'].map(t => (
              <button key={t} onClick={() => setSearch(search === t ? '' : t)}
                style={{ padding: '5px 11px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: '0.5px solid', borderColor: search === t ? '#185FA5' : 'var(--color-border-tertiary)', background: search === t ? '#E6F1FB' : 'transparent', color: search === t ? '#185FA5' : 'var(--color-text-tertiary)', fontFamily: 'inherit' }}>
                {t}
              </button>
            ))}
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
        <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 390, background: 'var(--color-background-primary)', borderLeft: '0.5px solid var(--color-border-tertiary)', zIndex: 40, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
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

      {/* ── TOAST ── */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 8, padding: '9px 16px', fontSize: 13, zIndex: 200, whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,0.12)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
