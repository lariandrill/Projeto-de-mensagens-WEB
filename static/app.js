// ---------- Variáveis ----------
let socket = null;
let username = null;
let pubKey = null;
let privKey = null;
let destinatarioAtual = null;
let chavesAmigos = {};
let todosContatos = [];
let typingTimer = null;
let naoLidas = {};
let pendingConfirmations = {};

// ---------- Inicialização ----------
window.onload = function() {
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
  setupSocketListeners();
  setupUI();
  checkServerStatus();
  setInterval(checkServerStatus, 15000);

  if (window.Notification && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
};

function setupUI() {
  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('show-register-btn').addEventListener('click', showRegister);
  document.getElementById('register-btn').addEventListener('click', register);
  document.getElementById('show-login-btn').addEventListener('click', showLogin);
  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keyup', emitTyping);
  document.getElementById('menu-btn').addEventListener('click', openMenu);
  document.getElementById('menu-close-btn').addEventListener('click', closeMenu);
  document.getElementById('menu-contacts-btn').addEventListener('click', showContacts);
  document.getElementById('menu-update-btn').addEventListener('click', atualizarContatos);
  document.getElementById('menu-config-btn').addEventListener('click', openConfig);
  document.getElementById('menu-logout-btn').addEventListener('click', logout);
  document.getElementById('config-close-btn').addEventListener('click', closeConfig);
  document.getElementById('contacts-btn').addEventListener('click', showContacts);
  document.getElementById('contacts-close-btn').addEventListener('click', () => {
    document.getElementById('contacts-overlay').classList.remove('active');
  });
  document.getElementById('twofa-btn').addEventListener('click', verify2FA);
  document.getElementById('twofa-cancel-btn').addEventListener('click', () => {
    showLogin();
  });
  document.getElementById('notificacoes-check').addEventListener('change', saveConfig);
  document.getElementById('confirmacao-check').addEventListener('change', saveConfig);

  const saved = JSON.parse(localStorage.getItem('hermes_config') || '{}');
  if (saved.notificacoes !== undefined) document.getElementById('notificacoes-check').checked = saved.notificacoes;
  if (saved.confirmacao !== undefined) document.getElementById('confirmacao-check').checked = saved.confirmacao;
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}
function showRegister() { showScreen('register-screen'); }
function showLogin() { showScreen('login-screen'); }
function showChat() { showScreen('chat-screen'); }
function showTwoFA() { showScreen('twofa-screen'); }

function showError(msg, isReg = false) {
  (isReg ? document.getElementById('reg-error') : document.getElementById('login-error')).textContent = msg;
}

// ---------- Servidor ----------
function checkServerStatus() {
  fetch('/status').then(r => r.json()).then(d => {
    document.getElementById('server-status').textContent = d.status === 'online' ? 'Servidor online' : 'Servidor offline';
    document.getElementById('server-status').style.color = d.status === 'online' ? '#0f0' : '#f00';
  });
}

// ---------- Criptografia ----------
async function sha256(msg) { /* igual */ }
function gerarParChaves() { /* igual */ }
function criptografar(txt, pub) { /* igual */ }
function descriptografar(txt, priv) { /* igual */ }

function atualizarBadgeNaoLidas() { /* igual ao anterior */ }

// ---------- Autenticação ----------
async function login() {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value.trim();
  if (!u || !p) { showError('Preencha todos os campos!'); return; }
  const hash = await sha256(p);
  socket.emit('login_usuario', { username: u, password_hash: hash });
}

async function register() {
  const u = document.getElementById('reg-username').value.trim();
  const p = document.getElementById('reg-password').value.trim();
  const c = document.getElementById('reg-confirm').value.trim();
  const e = document.getElementById('reg-email').value.trim();
  if (!u || !p || !c || !e) { showError('Preencha todos os campos!', true); return; }
  if (p !== c) { showError('Senhas não coincidem!', true); return; }
  if (!e.includes('@') || !e.includes('.')) { showError('E-mail inválido', true); return; }
  const hash = await sha256(p);
  socket.emit('registrar_usuario_credencial', { username: u, password_hash: hash, email: e });
}

function verify2FA() {
  const code = document.getElementById('twofa-code').value.trim();
  if (code.length !== 6) {
    document.getElementById('twofa-error').textContent = 'Código deve ter 6 dígitos';
    return;
  }
  socket.emit('verify_2fa', { code: code });
}

// ---------- Socket Listeners ----------
function setupSocketListeners() {
  socket.on('connect', () => {
    document.getElementById('status-led').className = 'led online';
    document.getElementById('status-text').textContent = 'Online';
  });

  socket.on('disconnect', () => {
    document.getElementById('status-led').className = 'led offline';
    document.getElementById('status-text').textContent = 'Offline';
  });

  socket.on('login_response', (data) => {
    if (data.success) {
      if (data.awaiting_2fa) {
        showTwoFA();
        document.getElementById('twofa-error').textContent = '';
      } else {

        finalizarLogin(data.username);
      }
    } else {
      showError(data.message || 'Erro no login');
    }
  });

  socket.on('registro_response', (data) => {
    if (data.success) {
      showLogin();
      alert('Conta criada! Faça login.');
    } else {
      showError(data.message || 'Erro no registro', true);
    }
  });

  socket.on('verify_2fa_response', (data) => {
    if (data.success) {
      finalizarLogin(data.username);
    } else {
      document.getElementById('twofa-error').textContent = data.message || 'Código inválido';
    }
  });

}

function finalizarLogin(user) {
  username = user;
  const keys = gerarParChaves();
  pubKey = keys.publicKey;
  privKey = keys.privateKey;
  socket.emit('registrar_usuario', { username: username, public_key: pubKey });
  socket.emit('solicitar_contatos');
  showChat();
}
