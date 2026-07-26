const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || config.port || 6000;
const { clientId, clientSecret, redirectUri, botToken, guildId, requiredRoleIds } = config.discord;
const allowedUserIds = config.allowedUserIds || [];
const sessions = new Map();

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function loadJSON(file, fallback) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return fallback;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}
function saveJSON(file, data) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }

function runCmd(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ error: err.message, stdout: stdout || '', stderr: stderr || '' });
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [key, ...val] = c.split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('=').trim());
  });
  return cookies;
}

function createSession(userId, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, user, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const token = parseCookies(req).vps_session;
  return token ? sessions.get(token) || null : null;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.user = session.user;
  next();
}

// ─── DISCORD OAUTH2 ───
app.get('/auth/login', (req, res) => {
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds%20guilds.members.read`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/login.html?error=no_code');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri })
    });
    const td = await tokenRes.json();
    if (td.error) return res.redirect('/login.html?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${td.access_token}` } });
    const user = await userRes.json();

    let authorized = allowedUserIds.length > 0 && allowedUserIds.includes(user.id);

    if (!authorized && botToken && guildId) {
      try {
        const mr = await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}`, { headers: { Authorization: `Bot ${botToken}` } });
        if (mr.ok) {
          const member = await mr.json();
          authorized = requiredRoleIds.length === 0 || requiredRoleIds.some(r => (member.roles || []).includes(r));
        }
      } catch {}
    }

    if (!authorized) return res.redirect('/login.html?error=unauthorized');

    const token = createSession(user.id, { id: user.id, username: user.username, discriminator: user.discriminator, avatar: user.avatar, globalName: user.global_name });
    res.setHeader('Set-Cookie', `vps_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*60*60}`);
    res.redirect('/');
  } catch { res.redirect('/login.html?error=auth_failed'); }
});

app.get('/auth/logout', (req, res) => {
  const token = parseCookies(req).vps_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'vps_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/login.html');
});

app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  res.json(s ? { authenticated: true, user: s.user } : { authenticated: false });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── PROTECT API ───
app.use('/api', requireAuth);

// ─── SYSTEM INFO ───
app.get('/api/system', async (req, res) => {
  try {
    const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
    const uptime = execSync('cat /proc/uptime 2>/dev/null || echo "0 0"', { encoding: 'utf8' }).trim();
    const memRaw = execSync('free -m | grep Mem', { encoding: 'utf8' }).trim();
    const diskRaw = execSync('df -h / | tail -1', { encoding: 'utf8' }).trim();
    const loadRaw = execSync('cat /proc/loadavg', { encoding: 'utf8' }).trim();
    const osRaw = execSync('cat /etc/os-release 2>/dev/null | head -2', { encoding: 'utf8' }).trim();
    const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf8' }).trim();
    const kernel = execSync('uname -r', { encoding: 'utf8' }).trim();
    const mem = memRaw.split(/\s+/);
    const disk = diskRaw.split(/\s+/);
    const load = loadRaw.split(/\s+/);
    res.json({ hostname, uptime: parseFloat(uptime.split(' ')[0]), os: osRaw.replace(/\n/g, ' | '), ip, kernel, cpu: { cores: require('os').cpus().length, model: require('os').cpus()[0]?.model || 'Unknown' }, memory: { total: parseInt(mem[1]), used: parseInt(mem[2]), free: parseInt(mem[3]) }, disk: { total: disk[1], used: disk[2], free: disk[3], percent: disk[4] }, load: [parseFloat(load[0]), parseFloat(load[1]), parseFloat(load[2])] });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── PM2 ───
app.get('/api/pm2/list', async (req, res) => {
  const r = await runCmd('pm2 jlist');
  try { res.json({ processes: JSON.parse(r.stdout) }); } catch { res.json({ processes: [] }); }
});
app.post('/api/pm2/start', async (req, res) => { const { name, script, cwd, args } = req.body; res.json(await runCmd(`pm2 start "${script}" --name "${name}" ${cwd ? `--cwd "${cwd}"` : ''} ${args ? `-- ${args}` : ''}`)); });
app.post('/api/pm2/stop', async (req, res) => { res.json(await runCmd(`pm2 stop ${req.body.name}`)); });
app.post('/api/pm2/restart', async (req, res) => { res.json(await runCmd(`pm2 restart ${req.body.name}`)); });
app.post('/api/pm2/delete', async (req, res) => { res.json(await runCmd(`pm2 delete ${req.body.name}`)); });
app.post('/api/pm2/logs', async (req, res) => { res.json(await runCmd(`pm2 logs ${req.body.name} --nostream --lines ${req.body.lines || 100}`)); });
app.get('/api/pm2/save', async (req, res) => { res.json(await runCmd('pm2 save')); });
app.get('/api/pm2/startup', async (req, res) => { res.json(await runCmd('pm2 startup')); });

// ─── NGINX ───
app.get('/api/nginx/sites', async (req, res) => {
  const dirs = ['/etc/nginx/sites-available', '/etc/nginx/conf.d'];
  let sites = [];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter(f => !f.startsWith('.')).forEach(f => {
        sites.push({ name: f, path: path.join(dir, f), content: fs.readFileSync(path.join(dir, f), 'utf8'), dir });
      });
    }
  }
  res.json({ sites });
});
app.get('/api/nginx/enabled', async (req, res) => {
  const dir = '/etc/nginx/sites-enabled';
  res.json({ enabled: fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.startsWith('.')) : [] });
});
app.post('/api/nginx/read', async (req, res) => { try { res.json({ content: fs.readFileSync(req.body.path, 'utf8') }); } catch (e) { res.json({ error: e.message }); } });
app.post('/api/nginx/save', async (req, res) => { try { fs.writeFileSync(req.body.path, req.body.content); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); } });
app.post('/api/nginx/test', async (req, res) => { res.json(await runCmd('nginx -t')); });
app.get('/api/nginx/reload', async (req, res) => { res.json(await runCmd('sudo nginx -s reload')); });
app.post('/api/nginx/create', async (req, res) => { try { fs.writeFileSync(path.join('/etc/nginx/sites-available', req.body.name), req.body.content); await runCmd(`sudo ln -sf /etc/nginx/sites-available/${req.body.name} /etc/nginx/sites-enabled/${req.body.name}`); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); } });
app.post('/api/nginx/delete', async (req, res) => { await runCmd(`sudo rm -f /etc/nginx/sites-enabled/${req.body.name} /etc/nginx/sites-available/${req.body.name}`); res.json({ success: true }); });
app.post('/api/nginx/enable', async (req, res) => { res.json(await runCmd(`sudo ln -sf /etc/nginx/sites-available/${req.body.name} /etc/nginx/sites-enabled/${req.body.name}`)); });
app.post('/api/nginx/disable', async (req, res) => { res.json(await runCmd(`sudo rm -f /etc/nginx/sites-enabled/${req.body.name}`)); });

// ─── SSL CERTIFICATES ───
app.get('/api/ssl/certs', async (req, res) => {
  const r = await runCmd('sudo certbot certificates 2>&1', 15000);
  const output = r.stdout || r.stderr || r.error || '';
  const certs = [];
  const regex = /Certificate Name:\s*(.+?)[\s\S]*?Domains:\s*(.+?)[\s\S]*?Expiry Date:\s*(.+?)[\s\S]*?(?:INVALID|Valid)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    certs.push({ name: match[1].trim(), domains: match[2].trim(), expiry: match[3].trim() });
  }
  res.json({ certs, raw: output });
});

app.post('/api/ssl/request', async (req, res) => {
  const { domain, email } = req.body;
  if (!domain) return res.json({ error: 'Domain required' });
  res.json(await runCmd(`sudo certbot certonly --nginx -d ${domain} --non-interactive --agree-tos -m ${email || 'admin@' + domain} 2>&1`, 120000));
});

app.post('/api/ssl/renew', async (req, res) => {
  res.json(await runCmd('sudo certbot renew --quiet 2>&1', 120000));
});

app.post('/api/ssl/delete', async (req, res) => {
  res.json(await runCmd(`sudo certbot delete --cert-name ${req.body.name} 2>&1`));
});

// ─── VPS MANAGEMENT ───
app.get('/api/vps/services', async (req, res) => {
  const r = await runCmd('systemctl list-units --type=service --all --no-pager --plain 2>/dev/null | head -50');
  const lines = (r.stdout || '').split('\n').slice(1).filter(l => l.trim());
  const services = lines.map(l => {
    const parts = l.split(/\s+/);
    return { name: parts[0], load: parts[1], active: parts[2], sub: parts[3], description: parts.slice(4).join(' ') };
  }).filter(s => s.name);
  res.json({ services });
});

app.post('/api/vps/service/action', async (req, res) => {
  const { name, action } = req.body;
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) return res.json({ error: 'Invalid action' });
  res.json(await runCmd(`sudo systemctl ${action} ${name}`));
});

app.get('/api/vps/ports', async (req, res) => {
  const r = await runCmd('sudo ss -tlnp 2>/dev/null || sudo netstat -tlnp 2>/dev/null');
  res.json({ output: r.stdout || r.error });
});

app.get('/api/vps/firewall', async (req, res) => {
  const ufw = await runCmd('sudo ufw status verbose 2>/dev/null');
  const iptables = await runCmd('sudo iptables -L -n --line-numbers 2>/dev/null | head -30');
  res.json({ ufw: ufw.stdout || ufw.error, iptables: iptables.stdout || iptables.error });
});

app.post('/api/vps/firewall/ufw', async (req, res) => {
  const { action } = req.body;
  if (!['enable', 'disable', 'reload', 'status'].includes(action)) return res.json({ error: 'Invalid' });
  res.json(await runCmd(`sudo ufw ${action}`));
});

app.post('/api/vps/firewall/rule', async (req, res) => {
  const { rule } = req.body;
  if (!rule) return res.json({ error: 'Rule required' });
  res.json(await runCmd(`sudo ufw ${rule}`));
});

app.get('/api/vps/users', async (req, res) => {
  const r = await runCmd('cat /etc/passwd | grep -v nologin | grep -v false | grep -v /bin/sync');
  const lines = (r.stdout || '').split('\n').filter(l => l.trim());
  const users = lines.map(l => {
    const p = l.split(':');
    return { name: p[0], uid: p[2], gid: p[3], home: p[5], shell: p[6] };
  }).filter(u => u.name && parseInt(u.uid) >= 1000 || u.name === 'root');
  res.json({ users });
});

app.post('/api/vps/user/add', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ error: 'Username required' });
  res.json(await runCmd(`sudo adduser ${username} --disabled-password --gecos "" 2>&1`));
});

app.post('/api/vps/user/delete', async (req, res) => {
  res.json(await runCmd(`sudo deluser ${req.body.username} 2>&1`));
});

app.get('/api/vps/packages', async (req, res) => {
  const r = await runCmd('dpkg -l 2>/dev/null | tail -n+6 | head -100');
  res.json({ output: r.stdout || r.error });
});

app.get('/api/vps/crontab', async (req, res) => {
  const r = await runCmd('sudo crontab -l 2>/dev/null');
  res.json({ crontab: r.stdout || '' });
});

app.post('/api/vps/crontab', async (req, res) => {
  const { line } = req.body;
  if (!line) return res.json({ error: 'Cron line required' });
  res.json(await runCmd(`(sudo crontab -l 2>/dev/null; echo "${line}") | sudo crontab -`));
});

app.post('/api/vps/crontab/delete', async (req, res) => {
  const { line } = req.body;
  if (!line) return res.json({ error: 'Cron line required' });
  res.json(await runCmd(`sudo crontab -l 2>/dev/null | grep -v -F '${line}' | sudo crontab -`));
});

app.get('/api/vps/logs', async (req, res) => {
  const lines = req.query.lines || 100;
  const r = await runCmd(`sudo journalctl --no-pager -n ${lines} 2>/dev/null || sudo tail -n ${lines} /var/log/syslog 2>/dev/null`);
  res.json({ logs: r.stdout || r.error });
});

app.get('/api/vps/network', async (req, res) => {
  const ip = execSync("hostname -I 2>/dev/null", { encoding: 'utf8' }).trim();
  const gateway = execSync("ip route | grep default | awk '{print $3}' 2>/dev/null", { encoding: 'utf8' }).trim();
  const dns = execSync("cat /etc/resolv.conf | grep nameserver | awk '{print $2}' 2>/dev/null", { encoding: 'utf8' }).trim();
  res.json({ ip, gateway, dns });
});

// ─── FILE BROWSER ───
app.post('/api/files/list', async (req, res) => {
  try {
    const dir = req.body.path || '/home';
    const items = fs.readdirSync(dir).map(name => {
      const fp = path.join(dir, name);
      let stat; try { stat = fs.statSync(fp); } catch { stat = null; }
      return { name, path: fp, isDir: stat?.isDirectory() || false, size: stat?.size || 0, modified: stat?.mtime || null };
    });
    res.json({ path: dir, items });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/read', async (req, res) => {
  try { res.json({ content: fs.readFileSync(req.body.path, 'utf8') }); } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/write', async (req, res) => {
  try { fs.writeFileSync(req.body.path, req.body.content); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/mkdir', async (req, res) => {
  try { fs.mkdirSync(req.body.path, { recursive: true }); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/delete', async (req, res) => {
  try { fs.rmSync(req.body.path, { recursive: true, force: true }); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/rename', async (req, res) => {
  try { fs.renameSync(req.body.old, req.body.new); res.json({ success: true }); } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: 'No file' });
  const dest = path.join(req.body.dest || '/home', req.file.originalname);
  try {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, path: dest });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/files/download', (req, res) => {
  const fp = req.query.path;
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('Not found');
  res.download(fp);
});

// ─── RAW EXEC ───
app.post('/api/exec', async (req, res) => { res.json(await runCmd(req.body.cmd)); });
app.get('/api/processes', async (req, res) => { res.json(await runCmd('ps aux --sort=-%cpu | head -20')); });

// ─── WEBSOCKET ───
wss.on('connection', (ws) => {
  let proc = null;
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'pm2-log' && data.name) {
        if (proc) proc.kill();
        proc = spawn('pm2', ['logs', data.name, '--nostream', '--lines', '50', '--raw']);
        proc.stdout.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', data: d.toString() })); });
        proc.stderr.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', data: d.toString() })); });
      }
    } catch {}
  });
  ws.on('close', () => { if (proc) proc.kill(); });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`VPS Manager running at http://localhost:${PORT}`));
