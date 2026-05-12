// ---------- Variáveis globais ----------
let socket = null;
let username = null;
let pubKey = null;          // chave pública PEM
let privKey = null;         // chave privada PEM
let destinatarioAtual = null;
let chavesAmigos = {};      // { username: publicKeyPEM }
let todosContatos = [];
let typingTimer = null;

// ---------- Inicialização ----------
window.onload = function() {
  socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
  setupSocketListeners();
  setupUI();
  checkServerStatus();
  setInterval(checkServerStatus, 15000);

  // Solicitar permissão de notificação
  if (window.Notification && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
};

// ---------- UI ----------
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
  // Checkbox de configurações
  document.getElementById('notificacoes-check').addEventListener('change', saveConfig);
  document.getElementById('confirmacao-check').addEventListener('change', saveConfig);
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}
function showRegister() { showScreen('register-screen'); }
function showLogin() { showScreen('login-screen'); }
function showChat() { showScreen('chat-screen'); }

function showError(msg, isReg = false) {
  const el = isReg ? document.getElementById('reg-error') : document.getElementById('login-error');
  el.textContent = msg;
}

// ---------- Servidor status ----------
function checkServerStatus() {
  fetch('/').then(res => res.json()).then(data => {
    document.getElementById('server-status').textContent = data.status === 'online' ? 'Servidor online' : 'Servidor offline';
    document.getElementById('server-status').style.color = data.status === 'online' ? '#0f0' : '#f00';
  }).catch(() => {
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

function criptografar(texto, publicKeyPEM) {
  const crypt = new JSEncrypt();
  crypt.setPublicKey(publicKeyPEM);
  return crypt.encrypt(texto);
}

function descriptografar(textoCifrado, privateKeyPEM) {
  const crypt = new JSEncrypt();
  crypt.setPrivateKey(privateKeyPEM);
  return crypt.decrypt(textoCifrado);
}

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
  if (!u || !p || !c) { showError('Preencha todos os campos!', true); return; }
  if (p !== c) { showError('Senhas não coincidem!', true); return; }
  const hash = await sha256(p);
  socket.emit('registrar_usuario_credencial', { username: u, password_hash: hash });
}

// ---------- SocketIO Listeners ----------
function setupSocketListeners() {
  socket.on('connect', () => {
    document.getElementById('status-led').className = 'led online';
    document.getElementById('status-text').textContent = 'Online';
  });

  socket.on('disconnect', () => {
    document.getElementById('status-led').className = 'led offline';
    document.getElementById('status-text').textContent = 'Offline';
  });

  socket.on('login_response', async (data) => {
    if (data.success) {
      username = data.username;
      const keys = gerarParChaves();
      pubKey = keys.publicKey;
      privKey = keys.privateKey;
      socket.emit('registrar_usuario', { username: username, public_key: pubKey });
      socket.emit('solicitar_contatos');
      showChat();
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

  socket.on('lista_contatos', (contatos) => {
    todosContatos = contatos;
    // Atualizar chaves dos amigos
    contatos.forEach(c => {
      if (c.public_key && c.username !== username) {
        chavesAmigos[c.username] = c.public_key;
      }
    });
    // Atualizar badge no botão de contatos (não implementado visualmente aqui, mas pode ser feito)
  });

  socket.on('message', (data) => {
    let from = data.from;
    let content = data.content;
    let offline = data.offline || false;
    // Descriptografar
    let texto = content;
    if (privKey && content) {
      try {
        const dec = descriptografar(content, privKey);
        if (dec) texto = dec;
      } catch(e) {}
    }
    if (from === destinatarioAtual) {
      addMessage(from + ': ' + texto, 'left');
      socket.emit('marcar_lida', { contato: from });
    } else {
      // Notificação visual
      if (document.getElementById('notificacoes-check').checked && window.Notification && Notification.permission === 'granted') {
        new Notification(from, { body: texto.substring(0, 100), icon: '/static/icon.png' });
      }
    }
  });

  socket.on('historico_mensagens', (data) => {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    data.mensagens.forEach(msg => {
      let texto = msg.content;
      if (privKey && texto) {
        try {
          const dec = descriptografar(texto, privKey);
          if (dec) texto = dec;
        } catch(e) {}
      }
      if (msg.from === username) {
        addMessage('Você: ' + texto, 'right');
      } else {
        addMessage(msg.from + ': ' + texto, 'left');
      }
    });
  });

  socket.on('digitando', (data) => {
    if (data.from === destinatarioAtual) {
      document.getElementById('typing-indicator').textContent = data.from + ' está digitando...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        document.getElementById('typing-indicator').textContent = '';
      }, 2000);
    }
  });

  socket.on('delivery_confirmation', (data) => {
  });
}

// ---------- Funções da UI ----------
function addMessage(texto, lado) {
  const div = document.createElement('div');
  div.className = 'message ' + lado;
  div.textContent = texto;
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
  addMessage('Você: ' + texto, 'right');
  input.value = '';
}

function emitTyping() {
  if (destinatarioAtual) {
    socket.emit('digitando', { to: destinatarioAtual, from: username });
  }
}

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
      // Solicitar histórico
      socket.emit('solicitar_historico', { contato: c.username });
    });
    listDiv.appendChild(item);
  });
  document.getElementById('contacts-overlay').classList.add('active');
}

function atualizarContatos() {
  socket.emit('solicitar_contatos');
  closeMenu();
}

function logout() {
  socket.disconnect();
  username = null;
  pubKey = null;
  privKey = null;
  destinatarioAtual = null;
  chavesAmigos = {};
  todosContatos = [];
  showScreen('login-screen');
  // Reconectar
  socket.connect();
}

function saveConfig() {
  // Salvar configurações localmente
  localStorage.setItem('hermes_config', JSON.stringify({
    notificacoes: document.getElementById('notificacoes-check').checked,
    confirmacao: document.getElementById('confirmacao-check').checked
  }));
}