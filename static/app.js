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

window.onload = function() {
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
  setupSocketListeners();
  setupUI();
  checkServerStatus();
  setInterval(checkServerStatus, 15000);
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
  document.getElementById('twofa-cancel-btn').addEventListener('click', () => showLogin());
  document.getElementById('notificacoes-check').addEventListener('change', saveConfig);
  document.getElementById('confirmacao-check').addEventListener('change', saveConfig);

  const saved = JSON.parse(localStorage.getItem('hermes_config') || '{}');
  if (saved.notificacoes !== undefined) document.getElementById('notificacoes-check').checked = saved.notificacoes;
  if (saved.confirmacao !== undefined) document.getElementById('confirmacao-check').checked = saved.confirmacao;
}

// funções de tela
function showScreen(id) { document.querySelectorAll('.screen').forEach(el => el.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function showRegister() { showScreen('register-screen'); }
function showLogin() { showScreen('login-screen'); }
function showChat() { showScreen('chat-screen'); }
function showTwoFA() { showScreen('twofa-screen'); }

function showError(msg, isReg = false) {
  const el = isReg ? document.getElementById('reg-error') : document.getElementById('login-error');
  el.textContent = msg;
}

function checkServerStatus() {
  fetch('/status')
    .then(r => r.json())
    .then(d => {
      document.getElementById('server-status').textContent = d.status === 'online' ? 'Servidor online' : 'Servidor offline';
      document.getElementById('server-status').style.color = d.status === 'online' ? '#0f0' : '#f00';
    })
    .catch(() => {
      document.getElementById('server-status').textContent = 'Servidor offline';
      document.getElementById('server-status').style.color = '#f00';
    });
}

// ---------- Criptografia ----------
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function gerarParChaves() {
  const crypt = new JSEncrypt({ default_key_size: 1024 });
  return { publicKey: crypt.getPublicKey(), privateKey: crypt.getPrivateKey() };
}

function criptografar(texto, pub) {
  const crypt = new JSEncrypt();
  crypt.setPublicKey(pub);
  return crypt.encrypt(texto);
}

function descriptografar(texto, priv) {
  const crypt = new JSEncrypt();
  crypt.setPrivateKey(priv);
  return crypt.decrypt(texto);
}

// ---------- Badge ----------
function atualizarBadgeNaoLidas() {
  const total = Object.values(naoLidas).reduce((a, b) => a + b, 0);
  const btn = document.getElementById('contacts-btn');
  if (total > 0) {
    btn.textContent = `SELECIONAR (${total})`;
    btn.style.background = '#c80';
  } else {
    btn.textContent = 'SELECIONAR';
    btn.style.background = '#36c';
  }
}

// ---------- Autenticação com try/catch ----------
async function login() {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value.trim();
  if (!u || !p) { showError('Preencha todos os campos!'); return; }
  try {
    const hash = await sha256(p);
    socket.emit('login_usuario', { username: u, password_hash: hash });
  } catch (e) {
    showError('Erro ao processar senha.');
    console.error(e);
  }
}

async function register() {
  const u = document.getElementById('reg-username').value.trim();
  const p = document.getElementById('reg-password').value.trim();
  const c = document.getElementById('reg-confirm').value.trim();
  const e = document.getElementById('reg-email').value.trim();
  if (!u || !p || !c || !e) { showError('Preencha todos os campos!', true); return; }
  if (p !== c) { showError('Senhas não coincidem!', true); return; }
  if (!e.includes('@') || !e.includes('.')) { showError('E-mail inválido', true); return; }
  try {
    const hash = await sha256(p);
    socket.emit('registrar_usuario_credencial', { username: u, password_hash: hash, email: e });
  } catch (e) {
    showError('Erro ao processar senha.', true);
    console.error(e);
  }
}

function verify2FA() {
  const code = document.getElementById('twofa-code').value.trim();
  if (code.length !== 6) {
    document.getElementById('twofa-error').textContent = 'Código deve ter 6 dígitos';
    return;
  }
  socket.emit('verify_2fa', { code: code });
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
  // (demais listeners para message, historico, digitando, delivery_confirmation, lista_contatos – manter os já existentes)
  socket.on('lista_contatos', (contatos) => {
    todosContatos = contatos;
    contatos.forEach(c => { if (c.public_key && c.username !== username) chavesAmigos[c.username] = c.public_key; });
    atualizarBadgeNaoLidas();
  });
  socket.on('message', (data) => {
    let from = data.from, content = data.content, texto = content;
    if (privKey && content) { try { const dec = descriptografar(content, privKey); if (dec) texto = dec; } catch(e) {} }
    if (from === destinatarioAtual) {
      addMessage(from + ': ' + texto, 'left');
      socket.emit('marcar_lida', { contato: from });
    } else {
      if (!naoLidas[from]) naoLidas[from] = 0;
      naoLidas[from]++;
      atualizarBadgeNaoLidas();
      if (document.getElementById('notificacoes-check').checked && Notification.permission === 'granted') {
        new Notification(from, { body: texto.substring(0, 100), icon: '/static/Logo.png' });
      }
    }
  });
  socket.on('historico_mensagens', (data) => {
    document.getElementById('chat-messages').innerHTML = '';
    data.mensagens.forEach(msg => {
      let texto = msg.content;
      if (privKey && texto) { try { const dec = descriptografar(texto, privKey); if (dec) texto = dec; } catch(e) {} }
      addMessage((msg.from === username ? 'Você' : msg.from) + ': ' + texto, msg.from === username ? 'right' : 'left');
    });
  });
  socket.on('digitando', (data) => {
    if (data.from === destinatarioAtual) {
      document.getElementById('typing-indicator').textContent = data.from + ' está digitando...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { document.getElementById('typing-indicator').textContent = ''; }, 2000);
    }
  });
  socket.on('delivery_confirmation', (data) => {
    const { to, from, status } = data;
    if (from === username && pendingConfirmations[to]) {
      const el = pendingConfirmations[to];
      switch (status) {
        case 'delivered': el.textContent = ' ✓'; el.style.color = '#0f0'; break;
        case 'stored_offline': el.textContent = ' ⏳'; el.style.color = '#ff0'; break;
        case 'failed': el.textContent = ' ✗'; el.style.color = '#f00'; break;
      }
      delete pendingConfirmations[to];
    }
  });
}

// ---------- UI mensagens ----------
function addMessage(texto, lado, isTemp = false) {
  const div = document.createElement('div');
  div.className = 'message ' + lado;
  if (lado === 'right' && isTemp) {
    const textSpan = document.createElement('span');
    textSpan.textContent = texto;
    const statusSpan = document.createElement('span');
    statusSpan.className = 'msg-status';
    statusSpan.textContent = ' ⌛';
    statusSpan.style.marginLeft = '5px';
    statusSpan.style.fontSize = '0.8em';
    div.appendChild(textSpan);
    div.appendChild(statusSpan);
    if (destinatarioAtual) pendingConfirmations[destinatarioAtual] = statusSpan;
    setTimeout(() => {
      if (statusSpan.textContent === ' ⌛' && pendingConfirmations[destinatarioAtual] === statusSpan) {
        statusSpan.textContent = ' ⚠️';
        statusSpan.style.color = '#f80';
        delete pendingConfirmations[destinatarioAtual];
      }
    }, 30000);
  } else {
    div.textContent = texto;
  }
  document.getElementById('chat-messages').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth' });
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const texto = input.value.trim();
  if (!texto || !destinatarioAtual) return;
  const chaveDest = chavesAmigos[destinatarioAtual];
  const conteudo = chaveDest ? criptografar(texto, chaveDest) : texto;
  socket.emit('message', { to: destinatarioAtual, from: username, content: conteudo });
  addMessage('Você: ' + texto, 'right', true);
  input.value = '';
}

function emitTyping() { if (destinatarioAtual) socket.emit('digitando', { to: destinatarioAtual, from: username }); }

// ---------- Menu e Contatos ----------
function openMenu() {
  document.getElementById('menu-overlay').classList.add('active');
  document.getElementById('menu-status').textContent = `Online: ${todosContatos.filter(c => c.online).length} contato(s)`;
}
function closeMenu() { document.getElementById('menu-overlay').classList.remove('active'); }
function openConfig() { document.getElementById('config-overlay').classList.add('active'); }
function closeConfig() { document.getElementById('config-overlay').classList.remove('active'); }

function showContacts() {
  const listDiv = document.getElementById('contacts-list');
  listDiv.innerHTML = '';
  todosContatos.forEach(c => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.textContent = (c.online ? '[ON] ' : '[OFF] ') + c.username;
    item.addEventListener('click', () => {
      destinatarioAtual = c.username;
      document.getElementById('destinatario-label').textContent = 'Para: ' + c.username;
      document.getElementById('contacts-overlay').classList.remove('active');
      if (naoLidas[c.username]) { delete naoLidas[c.username]; atualizarBadgeNaoLidas(); }
      socket.emit('solicitar_historico', { contato: c.username });
    });
    listDiv.appendChild(item);
  });
  document.getElementById('contacts-overlay').classList.add('active');
}

function atualizarContatos() { socket.emit('solicitar_contatos'); closeMenu(); }

function logout() {
  socket.disconnect();
  username = null; pubKey = null; privKey = null; destinatarioAtual = null;
  chavesAmigos = {}; todosContatos = []; naoLidas = {}; pendingConfirmations = {};
  showScreen('login-screen');
  socket.connect();
}

function saveConfig() {
  localStorage.setItem('hermes_config', JSON.stringify({
    notificacoes: document.getElementById('notificacoes-check').checked,
    confirmacao: document.getElementById('confirmacao-check').checked
  }));
}
