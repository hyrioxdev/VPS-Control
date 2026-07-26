const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let nginxEditPath = '';
let fileEditPath = '';

const pageMeta = {
  dashboard: { title: 'Dashboard', subtitle: 'System overview and statistics' },
  vps: { title: 'VPS Manager', subtitle: 'Services, firewall, users, ports, and crontab' },
  pm2: { title: 'PM2 Processes', subtitle: 'Manage Node.js processes with PM2' },
  nginx: { title: 'Nginx Configuration', subtitle: 'Edit and manage Nginx server blocks' },
  ssl: { title: 'SSL Certificates', subtitle: 'Manage Certbot SSL certificates' },
  files: { title: 'File Browser', subtitle: 'Navigate and edit server files' },
  logs: { title: 'System Logs', subtitle: 'View journalctl and syslog output' },
  terminal: { title: 'Terminal', subtitle: 'Execute shell commands remotely' }
};

function navigateTo(page) {
  $$('.nav-links li').forEach(l => l.classList.remove('active'));
  $$('.page').forEach(p => p.classList.remove('active'));
  const li = $(`.nav-links li[data-page="${page}"]`);
  if (li) li.classList.add('active');
  const pageEl = $(`#page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  const meta = pageMeta[page] || {};
  $('#page-title').textContent = meta.title || page;
  $('#page-subtitle').textContent = meta.subtitle || '';
  loadPage(page);
}

$$('.nav-links li').forEach(li => {
  li.addEventListener('click', () => navigateTo(li.dataset.page));
});

function loadPage(page) {
  const loaders = {
    dashboard: loadDashboard,
    vps: vpsRefresh,
    pm2: pm2Refresh,
    nginx: nginxRefresh,
    ssl: sslRefresh,
    files: fileBrowse,
    logs: logsRefresh
  };
  if (loaders[page]) loaders[page]();
}

async function api(url, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(url, opts);
  return res.json();
}

function toast(msg, type = 'success') {
  const el = $('#toast');
  el.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${type === 'success' ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}</svg> ${msg}`;
  el.className = `toast show ${type}`;
  setTimeout(() => el.className = 'toast', 3500);
}

function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtBytes(mb) {
  if (mb > 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb + ' MB';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function emptyState(icon, title, desc) {
  return `<div class="empty-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${icon}</svg>
    <h3>${title}</h3>
    <p>${desc}</p>
  </div>`;
}

function openModal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal-overlay').classList.add('open');
}

function closeModal() {
  $('#modal-overlay').classList.remove('open');
}

// ─── AUTH ───
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return false;
    }
    const user = data.user;
    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || user.id) % 5}.png`;
    const sidebarFooter = document.querySelector('.sidebar-footer');
    if (sidebarFooter) {
      sidebarFooter.innerHTML = `
        <div class="user-info">
          <img src="${avatarUrl}" alt="" class="user-avatar" referrerpolicy="no-referrer">
          <div class="user-details">
            <div class="user-name">${user.globalName || user.username}</div>
            <div class="user-handle">@${user.username}</div>
          </div>
          <a href="/auth/logout" class="btn btn-ghost btn-sm" title="Logout" style="margin-left:auto;padding:6px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </a>
        </div>`;
    }
    return true;
  } catch {
    return true;
  }
}

// ─── DASHBOARD ───
async function loadDashboard() {
  const [sys, pm2Data] = await Promise.all([api('/api/system'), api('/api/pm2/list')]);
  const procs = pm2Data.processes || [];
  const online = procs.filter(p => p.pm2_env?.status === 'online').length;
  const stopped = procs.length - online;

  const memPct = sys.memory ? Math.round((sys.memory.used / sys.memory.total) * 100) : 0;
  const loadPct = sys.load ? Math.min(Math.round((sys.load[0] / (sys.cpu?.cores || 1)) * 100), 100) : 0;

  $('#stats-grid').innerHTML = `
    <div class="stat-card accent">
      <div class="label">CPU Cores</div>
      <div class="value">${sys.cpu?.cores || '?'}</div>
      <div class="sub">${sys.cpu?.model?.substring(0, 40) || 'Unknown'}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${loadPct}%;background:var(--blue)"></div></div>
    </div>
    <div class="stat-card green">
      <div class="label">Memory</div>
      <div class="value">${fmtBytes(sys.memory?.used || 0)}</div>
      <div class="sub">of ${fmtBytes(sys.memory?.total || 0)} (${memPct}%)</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${memPct}%;background:var(--green)"></div></div>
    </div>
    <div class="stat-card yellow">
      <div class="label">Disk Usage</div>
      <div class="value">${sys.disk?.percent || '?'}</div>
      <div class="sub">${sys.disk?.used || '?'} / ${sys.disk?.total || '?'}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${parseInt(sys.disk?.percent) || 0}%;background:var(--yellow)"></div></div>
    </div>
    <div class="stat-card blue">
      <div class="label">Load Average</div>
      <div class="value">${sys.load ? sys.load[0].toFixed(2) : '?'}</div>
      <div class="sub">${sys.load ? sys.load.map(l => l.toFixed(2)).join(' / ') : ''}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${loadPct}%;background:var(--blue)"></div></div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value">${sys.uptime ? fmtUptime(sys.uptime) : '?'}</div>
      <div class="sub">${sys.hostname || 'Unknown Host'}</div>
    </div>
    <div class="stat-card accent">
      <div class="label">PM2 Processes</div>
      <div class="value">${procs.length}</div>
      <div class="sub"><span class="status-badge status-online">${online} running</span> <span class="status-badge status-stopped">${stopped} stopped</span></div>
    </div>
  `;

  const topProcs = procs.slice(0, 5);
  if (topProcs.length === 0) {
    $('#pm2-quick').innerHTML = '<div class="empty-padding">No PM2 processes running</div>';
  } else {
    $('#pm2-quick').innerHTML = '<div class="process-list">' + topProcs.map(p => `
      <div class="process-item">
        <div class="process-info">
          <div class="name">${escHtml(p.name)}</div>
          <div class="meta">${escHtml(p.pm2_env?.pm_exec_path || '')} &middot; PID ${p.pid} &middot; ${(p.monit?.cpu || 0).toFixed(1)}% CPU &middot; ${fmtBytes((p.monit?.memory || 0) / 1024 / 1024)}</div>
        </div>
        <span class="status-badge status-${p.pm2_env?.status === 'online' ? 'online' : 'stopped'}">${p.pm2_env?.status || '?'}</span>
      </div>
    `).join('') + '</div>';
  }

  const [sysInfo, netInfo] = await Promise.all([
    api('/api/vps/network'),
    api('/api/vps/logs?lines=8')
  ]);

  $('#sys-info').innerHTML = `
    <div class="info-grid">
      <div class="info-row"><span class="info-label">Hostname</span><span class="info-value">${escHtml(sys.hostname || '?')}</span></div>
      <div class="info-row"><span class="info-label">OS</span><span class="info-value">${escHtml(sys.os || '?')}</span></div>
      <div class="info-row"><span class="info-label">Kernel</span><span class="info-value">${escHtml(sys.kernel || '?')}</span></div>
      <div class="info-row"><span class="info-label">IP</span><span class="info-value">${escHtml(sys.ip || sysInfo.ip || '?')}</span></div>
    </div>
  `;

  $('#net-info').innerHTML = `
    <div class="info-grid">
      <div class="info-row"><span class="info-label">IP</span><span class="info-value">${escHtml(sysInfo.ip || '?')}</span></div>
      <div class="info-row"><span class="info-label">Gateway</span><span class="info-value">${escHtml(sysInfo.gateway || '?')}</span></div>
      <div class="info-row"><span class="info-label">DNS</span><span class="info-value">${escHtml(sysInfo.dns || '?')}</span></div>
    </div>
  `;
}

// ─── PM2 ───
async function pm2Refresh() {
  const data = await api('/api/pm2/list');
  const procs = data.processes || [];
  if (procs.length === 0) {
    $('#pm2-list').innerHTML = emptyState('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', 'No Processes', 'Start a new process below to get started.');
    return;
  }
  $('#pm2-list').innerHTML = procs.map(p => `
    <div class="process-item">
      <div class="process-info">
        <div class="name">${escHtml(p.name)} <span class="status-badge status-${p.pm2_env?.status === 'online' ? 'online' : 'stopped'}">${p.pm2_env?.status || '?'}</span></div>
        <div class="meta">
          ${escHtml(p.pm2_env?.pm_exec_path || 'N/A')} &middot; PID ${p.pid} &middot; Restarts: ${p.pm2_env?.restart_time || 0} &middot; CPU: ${(p.monit?.cpu || 0).toFixed(1)}% &middot; Mem: ${fmtBytes((p.monit?.memory || 0) / 1024 / 1024)}
        </div>
      </div>
      <div class="process-actions">
        <button onclick="pm2Action('restart','${escHtml(p.name)}')" class="btn btn-sm btn-warning">Restart</button>
        <button onclick="pm2Action('stop','${escHtml(p.name)}')" class="btn btn-sm btn-danger">Stop</button>
        <button onclick="pm2Action('delete','${escHtml(p.name)}')" class="btn btn-sm btn-ghost">Delete</button>
      </div>
    </div>
  `).join('');
}

async function pm2Action(action, name) {
  await api(`/api/pm2/${action}`, { name });
  toast(`Process ${action}ed: ${name}`);
  pm2Refresh();
}

async function pm2StartNew() {
  const name = $('#pm2-name').value.trim();
  const script = $('#pm2-script').value.trim();
  const cwd = $('#pm2-cwd').value.trim();
  const args = $('#pm2-args').value.trim();
  if (!name || !script) return toast('Name and script required', 'error');
  await api('/api/pm2/start', { name, script, cwd, args });
  toast('Process started');
  $('#pm2-name').value = '';
  $('#pm2-script').value = '';
  $('#pm2-cwd').value = '';
  $('#pm2-args').value = '';
  pm2Refresh();
}

async function pm2LoadLogs() {
  const name = $('#pm2-log-name').value.trim();
  if (!name) return toast('Enter process name', 'error');
  const data = await api('/api/pm2/logs', { name, lines: 200 });
  $('#pm2-logs').textContent = data.stdout || data.stderr || data.error || 'No logs available';
}

async function pm2Save() {
  await api('/api/pm2/save');
  toast('PM2 process list saved');
}

async function pm2Startup() {
  const res = await api('/api/pm2/startup');
  toast(res.stdout || res.stderr || res.error || 'Startup enabled');
}

// ─── VPS MANAGER ───
async function vpsRefresh() {
  const [services, firewall, ports, users, crontab, network] = await Promise.all([
    api('/api/vps/services'),
    api('/api/vps/firewall'),
    api('/api/vps/ports'),
    api('/api/vps/users'),
    api('/api/vps/crontab'),
    api('/api/vps/network')
  ]);

  const svcList = services.services || [];
  if (svcList.length === 0) {
    $('#vps-services').innerHTML = '<div class="empty-padding">No services found</div>';
  } else {
    $('#vps-services').innerHTML = '<div class="service-list">' + svcList.map(s => `
      <div class="process-item">
        <div class="process-info">
          <div class="name">${escHtml(s.name)} <span class="status-badge status-${s.active === 'loaded' ? 'online' : 'stopped'}">${escHtml(s.active)} / ${escHtml(s.sub)}</span></div>
          <div class="meta">${escHtml(s.description)}</div>
        </div>
        <div class="process-actions">
          <button onclick="serviceAction('${escHtml(s.name)}','start')" class="btn btn-sm btn-success">Start</button>
          <button onclick="serviceAction('${escHtml(s.name)}','stop')" class="btn btn-sm btn-danger">Stop</button>
          <button onclick="serviceAction('${escHtml(s.name)}','restart')" class="btn btn-sm btn-warning">Restart</button>
        </div>
      </div>
    `).join('') + '</div>';
  }

  $('#vps-firewall').textContent = firewall.ufw || firewall.iptables || 'No firewall data';
  $('#vps-ports').textContent = ports.output || 'No port data';

  const userList = users.users || [];
  if (userList.length === 0) {
    $('#vps-users').innerHTML = '<div class="empty-padding">No users found</div>';
  } else {
    $('#vps-users').innerHTML = '<div class="process-list">' + userList.map(u => `
      <div class="process-item">
        <div class="process-info">
          <div class="name">${escHtml(u.name)}</div>
          <div class="meta">UID: ${escHtml(u.uid)} &middot; Home: ${escHtml(u.home)} &middot; Shell: ${escHtml(u.shell)}</div>
        </div>
        ${u.name !== 'root' ? `<button onclick="deleteUser('${escHtml(u.name)}')" class="btn btn-sm btn-danger">Delete</button>` : ''}
      </div>
    `).join('') + '</div>';
  }

  $('#vps-crontab').textContent = crontab.crontab || 'No crontab entries';

  $('#vps-network').innerHTML = `
    <div class="info-grid">
      <div class="info-row"><span class="info-label">IP</span><span class="info-value">${escHtml(network.ip || '?')}</span></div>
      <div class="info-row"><span class="info-label">Gateway</span><span class="info-value">${escHtml(network.gateway || '?')}</span></div>
      <div class="info-row"><span class="info-label">DNS</span><span class="info-value">${escHtml(network.dns || '?')}</span></div>
    </div>
  `;
}

async function serviceAction(name, action) {
  await api('/api/vps/service/action', { name, action });
  toast(`Service ${action}: ${name}`);
  vpsRefresh();
}

async function ufwAction(action) {
  if (!confirm(`UFW ${action}?`)) return;
  const res = await api('/api/vps/firewall/ufw', { action });
  toast(res.stdout || res.stderr || res.error || `UFW ${action} completed`);
  vpsRefresh();
}

async function addUfwRule() {
  const rule = $('#ufw-rule').value.trim();
  if (!rule) return toast('Enter a UFW rule', 'error');
  const res = await api('/api/vps/firewall/rule', { rule });
  toast(res.stdout || res.stderr || res.error || 'Rule added');
  $('#ufw-rule').value = '';
  vpsRefresh();
}

function showAddUserModal() {
  openModal(`
    <h2>Add System User</h2>
    <div class="form-group" style="margin-bottom:20px">
      <label>Username</label>
      <input id="new-username" class="input" placeholder="newuser">
    </div>
    <button onclick="addUser()" class="btn btn-primary" style="width:100%">Add User</button>
  `);
}

async function addUser() {
  const username = $('#new-username').value.trim();
  if (!username) return toast('Username required', 'error');
  const res = await api('/api/vps/user/add', { username });
  closeModal();
  toast(res.stdout || res.stderr || res.error || 'User added');
  vpsRefresh();
}

async function deleteUser(username) {
  if (!confirm(`Delete user ${username}?`)) return;
  const res = await api('/api/vps/user/delete', { username });
  toast(res.stdout || res.stderr || res.error || 'User deleted');
  vpsRefresh();
}

async function addCron() {
  const line = $('#cron-rule').value.trim();
  if (!line) return toast('Enter a cron line', 'error');
  const res = await api('/api/vps/crontab', { line });
  toast(res.stdout || res.stderr || res.error || 'Cron entry added');
  $('#cron-rule').value = '';
  vpsRefresh();
}

// ─── NGINX ───
let nginxEnabled = [];

async function nginxRefresh() {
  const [sites, enabled] = await Promise.all([
    api('/api/nginx/sites'),
    api('/api/nginx/enabled')
  ]);
  nginxEnabled = enabled.enabled || [];
  const allSites = sites.sites || [];

  if (allSites.length === 0) {
    $('#nginx-sites').innerHTML = emptyState('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 'No Nginx Configs', 'Create a new config or check Nginx installation.');
    return;
  }

  $('#nginx-sites').innerHTML = allSites.map(s => {
    const isEnabled = nginxEnabled.includes(s.name);
    return `
      <div class="item-card">
        <h4>${escHtml(s.name)} <span class="status-badge ${isEnabled ? 'status-online' : 'status-stopped'}">${isEnabled ? 'Enabled' : 'Disabled'}</span></h4>
        <div class="detail"><strong>Path</strong> <span class="mono-sm">${escHtml(s.path)}</span></div>
        <div class="code-preview">${escHtml(s.content.substring(0, 200))}</div>
        <div class="card-actions">
          <button onclick="nginxEdit('${escHtml(s.path)}','${escHtml(s.name)}')" class="btn btn-sm btn-primary">Edit</button>
          ${isEnabled
            ? `<button onclick="nginxToggle('${escHtml(s.name)}',false)" class="btn btn-sm btn-warning">Disable</button>`
            : `<button onclick="nginxToggle('${escHtml(s.name)}',true)" class="btn btn-sm btn-success">Enable</button>`}
          <button onclick="nginxDelete('${escHtml(s.name)}')" class="btn btn-sm btn-ghost">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function nginxEdit(filePath, name) {
  nginxEditPath = filePath;
  $('#nginx-edit-name').textContent = name;
  $('#nginx-editor-card').style.display = 'block';
  api('/api/nginx/read', { path: filePath }).then(data => {
    $('#nginx-editor').value = data.content || data.error || '';
  });
}

async function nginxSave() {
  await api('/api/nginx/save', { path: nginxEditPath, content: $('#nginx-editor').value });
  toast('Config saved');
}

function closeNginxEditor() {
  $('#nginx-editor-card').style.display = 'none';
}

async function nginxTest() {
  const res = await api('/api/nginx/test');
  openModal(`<h2>Nginx Config Test</h2><pre class="logs">${escHtml(res.stdout || res.stderr || res.error || 'OK')}</pre><div style="margin-top:16px"><button onclick="closeModal()" class="btn btn-primary">Close</button></div>`);
}

async function nginxReload() {
  const res = await api('/api/nginx/reload');
  toast(res.stdout || res.stderr || 'Nginx reloaded');
}

async function nginxToggle(name, enable) {
  if (enable) await api('/api/nginx/enable', { name });
  else await api('/api/nginx/disable', { name });
  toast(`Config ${enable ? 'enabled' : 'disabled'}`);
  nginxRefresh();
}

async function nginxDelete(name) {
  if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
  await api('/api/nginx/delete', { name });
  toast('Config deleted');
  nginxRefresh();
}

function showNginxCreateModal() {
  openModal(`
    <h2>New Nginx Config</h2>
    <div class="form-group" style="margin-bottom:14px">
      <label>Filename</label>
      <input id="nginx-new-name" class="input" placeholder="mysite.conf">
    </div>
    <div class="form-group" style="margin-bottom:20px">
      <label>Config Content</label>
      <textarea id="nginx-new-content" class="code-editor" rows="14" placeholder="server {\n  listen 80;\n  server_name example.com;\n  location / {\n    proxy_pass http://localhost:3000;\n  }\n}"></textarea>
    </div>
    <button onclick="nginxCreate()" class="btn btn-primary" style="width:100%">Create Config</button>
  `);
}

async function nginxCreate() {
  const name = $('#nginx-new-name').value.trim();
  const content = $('#nginx-new-content').value;
  if (!name) return toast('Filename is required', 'error');
  await api('/api/nginx/create', { name, content });
  closeModal();
  toast('Config created');
  nginxRefresh();
}

// ─── SSL CERTIFICATES ───
async function sslRefresh() {
  const data = await api('/api/ssl/certs');
  const certs = data.certs || [];

  if (certs.length === 0) {
    $('#ssl-certs').innerHTML = emptyState('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 'No SSL Certificates', 'Request a new certificate for your domain.');
    return;
  }

  $('#ssl-certs').innerHTML = certs.map(c => `
    <div class="item-card">
      <h4>${escHtml(c.name)}</h4>
      <div class="detail"><strong>Domains</strong> ${escHtml(c.domains)}</div>
      <div class="detail"><strong>Expiry</strong> ${escHtml(c.expiry)}</div>
      <div class="card-actions">
        <button onclick="sslDelete('${escHtml(c.name)}')" class="btn btn-sm btn-danger">Delete</button>
      </div>
    </div>
  `).join('');
}

function showSSLRequestModal() {
  openModal(`
    <h2>Request SSL Certificate</h2>
    <div class="form-group" style="margin-bottom:14px">
      <label>Domain</label>
      <input id="ssl-domain" class="input" placeholder="example.com">
    </div>
    <div class="form-group" style="margin-bottom:20px">
      <label>Email</label>
      <input id="ssl-email" class="input" placeholder="admin@example.com">
    </div>
    <button onclick="sslRequest()" class="btn btn-primary" style="width:100%">Request Certificate</button>
  `);
}

async function sslRequest() {
  const domain = $('#ssl-domain').value.trim();
  const email = $('#ssl-email').value.trim();
  if (!domain) return toast('Domain required', 'error');
  closeModal();
  openModal(`<h2>Requesting Certificate...</h2><pre id="ssl-output" class="logs">Requesting SSL certificate for ${escHtml(domain)} via Certbot...</pre><div style="margin-top:16px"><button onclick="closeModal()" class="btn btn-secondary">Close</button></div>`);
  const res = await api('/api/ssl/request', { domain, email });
  $('#ssl-output').textContent = res.stdout || res.stderr || res.error || 'Certificate request completed';
  sslRefresh();
}

async function sslRenew() {
  openModal(`<h2>Renewing All Certificates...</h2><pre id="ssl-output" class="logs">Renewing...</pre><div style="margin-top:16px"><button onclick="closeModal()" class="btn btn-secondary">Close</button></div>`);
  const res = await api('/api/ssl/renew');
  $('#ssl-output').textContent = res.stdout || res.stderr || res.error || 'Renewal completed';
  sslRefresh();
}

async function sslDelete(name) {
  if (!confirm(`Delete certificate ${name}?`)) return;
  const res = await api('/api/ssl/delete', { name });
  toast(res.stdout || res.stderr || res.error || 'Certificate deleted');
  sslRefresh();
}

// ─── FILE BROWSER ───
async function fileBrowse(dir) {
  const filePath = dir || $('#file-path').value.trim() || '/home';
  $('#file-path').value = filePath;
  const data = await api('/api/files/list', { path: filePath });
  if (data.error) {
    $('#file-list').innerHTML = `<div class="section"><p style="color:var(--red);text-align:center;padding:40px">${escHtml(data.error)}</p></div>`;
    return;
  }

  const items = data.items || [];
  items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));

  if (items.length === 0) {
    $('#file-list').innerHTML = '<div class="section"><p class="empty-padding">Empty directory</p></div>';
    return;
  }

  const rows = items.map(i => {
    const size = i.isDir ? '-' : formatSize(i.size);
    const cls = i.isDir ? 'file-dir' : 'file-name';
    const action = i.isDir
      ? `onclick="fileBrowse('${escHtml(i.path).replace(/'/g, "\\'")}')"`
      : `onclick="fileEdit('${escHtml(i.path).replace(/'/g, "\\'")}','${escHtml(i.name)}')"`
    return `<tr>
      <td><span class="${cls}" ${action}>${i.isDir ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'} ${escHtml(i.name)}</span></td>
      <td>${size}</td>
      <td>${i.modified ? new Date(i.modified).toLocaleDateString() + ' ' + new Date(i.modified).toLocaleTimeString() : '-'}</td>
      <td class="file-actions">
        <button onclick="event.stopPropagation();showRenameModal('${escHtml(i.path).replace(/'/g, "\\'")}','${escHtml(i.name)}')" class="btn btn-sm btn-ghost">Rename</button>
        <button onclick="event.stopPropagation();deleteFile('${escHtml(i.path).replace(/'/g, "\\'")}','${escHtml(i.name)}')" class="btn btn-sm btn-danger">Delete</button>
        ${!i.isDir ? `<a href="/api/files/download?path=${encodeURIComponent(i.path)}" class="btn btn-sm btn-secondary">Download</a>` : ''}
      </td>
    </tr>`;
  }).join('');

  const parent = filePath.split('/').slice(0, -1).join('/') || '/';
  $('#file-list').innerHTML = `
    <table class="file-table">
      <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead>
      <tbody>
        <tr><td colspan="4"><span class="file-dir" onclick="fileBrowse('${escHtml(parent).replace(/'/g, "\\'")}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Back</span></td></tr>
        ${rows}
      </tbody>
    </table>
  `;
}

async function fileEdit(filePath, name) {
  fileEditPath = filePath;
  $('#file-edit-name').textContent = name;
  $('#file-editor-card').style.display = 'block';
  const data = await api('/api/files/read', { path: filePath });
  $('#file-editor').value = data.content || data.error || '';
}

async function fileSave() {
  await api('/api/files/write', { path: fileEditPath, content: $('#file-editor').value });
  toast('File saved');
}

function closeFileEditor() {
  $('#file-editor-card').style.display = 'none';
}

function showMkdirModal() {
  openModal(`
    <h2>New Folder</h2>
    <div class="form-group" style="margin-bottom:20px">
      <label>Folder Name</label>
      <input id="mkdir-name" class="input" placeholder="new-folder">
    </div>
    <button onclick="mkdir()" class="btn btn-primary" style="width:100%">Create</button>
  `);
}

async function mkdir() {
  const name = $('#mkdir-name').value.trim();
  if (!name) return toast('Name required', 'error');
  const currentPath = $('#file-path').value.trim();
  const fullPath = currentPath + '/' + name;
  const res = await api('/api/files/mkdir', { path: fullPath });
  closeModal();
  if (res.error) return toast(res.error, 'error');
  toast('Folder created');
  fileBrowse(currentPath);
}

function showRenameModal(filePath, name) {
  openModal(`
    <h2>Rename</h2>
    <div class="form-group" style="margin-bottom:20px">
      <label>New Name</label>
      <input id="rename-name" class="input" value="${escHtml(name)}">
    </div>
    <button onclick="renameFile('${escHtml(filePath).replace(/'/g, "\\'")}')" class="btn btn-primary" style="width:100%">Rename</button>
  `);
}

async function renameFile(oldPath) {
  const newName = $('#rename-name').value.trim();
  if (!newName) return toast('Name required', 'error');
  const dir = oldPath.split('/').slice(0, -1).join('/');
  const newPath = dir + '/' + newName;
  const res = await api('/api/files/rename', { old: oldPath, new: newPath });
  closeModal();
  if (res.error) return toast(res.error, 'error');
  toast('Renamed');
  fileBrowse($('#file-path').value.trim());
}

async function deleteFile(filePath, name) {
  if (!confirm(`Delete ${name}?`)) return;
  const res = await api('/api/files/delete', { path: filePath });
  if (res.error) return toast(res.error, 'error');
  toast('Deleted');
  fileBrowse($('#file-path').value.trim());
}

async function fileUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const dest = $('#file-path').value.trim() || '/home';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('dest', dest);
  const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.error) return toast(data.error, 'error');
  toast('File uploaded');
  input.value = '';
  fileBrowse(dest);
}

// ─── SYSTEM LOGS ───
async function logsRefresh() {
  const lines = $('#log-lines').value;
  const data = await api(`/api/vps/logs?lines=${lines}`);
  $('#logs-output').textContent = data.logs || data.error || 'No logs available';
}

// ─── TERMINAL ───
async function termExec() {
  const cmd = $('#term-cmd').value.trim();
  if (!cmd) return;
  const data = await api('/api/exec', { cmd });
  const output = data.stdout || data.stderr || data.error || 'Command completed';
  $('#term-output').textContent += `\n$\ ${cmd}\n${output}\n`;
  $('#term-output').scrollTop = $('#term-output').scrollHeight;
  $('#term-cmd').value = '';
}

// ─── INIT ───
async function init() {
  const authed = await checkAuth();
  if (authed) loadDashboard();
}

init();
