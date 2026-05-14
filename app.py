import eventlet
eventlet.monkey_patch()

from flask import Flask, jsonify, request, render_template
from flask_socketio import SocketIO, emit
from datetime import datetime, timedelta
import os
import logging
import random
import requests
import threading

import psycopg2
from psycopg2 import IntegrityError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet',
                    logger=False, engineio_logger=False)

# --------------- Configuração de e-mail (Mailjet) ---------------
MAILJET_API_KEY = os.environ.get('MAILJET_API_KEY')
MAILJET_SECRET_KEY = os.environ.get('MAILJET_SECRET_KEY')
FROM_EMAIL = os.environ.get('FROM_EMAIL')

def enviar_email(destinatario, assunto, corpo):
    if not MAILJET_API_KEY or not MAILJET_SECRET_KEY or not FROM_EMAIL:
        logger.error("Credenciais do Mailjet não configuradas.")
        return False
    try:
        response = requests.post(
            'https://api.mailjet.com/v3.1/send',
            auth=(MAILJET_API_KEY, MAILJET_SECRET_KEY),
            json={
                'Messages': [{
                    "From": {"Email": FROM_EMAIL, "Name": "HERMES"},
                    "To": [{"Email": destinatario}],
                    "Subject": assunto,
                    "HTMLPart": corpo.replace('\n', '<br>')
                }]
            }
        )
        if response.status_code == 200:
            logger.info(f"E-mail enviado para {destinatario}")
            return True
        else:
            logger.error(f"Erro ao enviar e-mail: {response.status_code} {response.text}")
            return False
    except Exception as e:
        logger.error(f"Erro ao enviar e-mail: {e}")
        return False

# --------------- Banco de dados ---------------
def get_db_connection():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise RuntimeError("DATABASE_URL não configurada")
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    return psycopg2.connect(database_url)

def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS usuarios (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            public_key TEXT,
            last_ip TEXT,
            device_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Adiciona colunas que podem não existir em migrações anteriores
    for col in ['email', 'last_ip', 'device_id']:
        try:
            cur.execute(f'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS {col} TEXT')
        except Exception as e:
            logger.warning(f"Não foi possível adicionar a coluna {col}: {e}")
    conn.commit()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS mensagens (
            id SERIAL PRIMARY KEY,
            de TEXT NOT NULL,
            para TEXT NOT NULL,
            conteudo TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            lida BOOLEAN DEFAULT FALSE,
            entregue BOOLEAN DEFAULT FALSE
        )
    ''')
    conn.commit()
    cur.close()
    conn.close()
    logger.info("Banco de dados inicializado/atualizado.")

init_db()

usuarios_online = {}
sid_to_username = {}
mensagens_offline = {}

# Códigos 2FA vinculados ao username
pending_2fa = {}

def gerar_codigo_2fa():
    return str(random.randint(100000, 999999))

# --------------- Rotas ---------------
@app.route('/status')
def status():
    return jsonify({'status': 'online', 'usuarios_online': len(usuarios_online)})

@app.route('/')
def index():
    return render_template('index.html')

# --------------- Lógica do chat (inalterada) ---------------
def broadcast_lista_contatos():
    for username, data in usuarios_online.items():
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT username, public_key FROM usuarios')
        todos = cur.fetchall()
        cur.close()
        conn.close()
        contatos = []
        for user, pub_key in todos:
            if user == username:
                continue
            online = user in usuarios_online
            contato = {'username': user, 'online': online}
            if online:
                contato['public_key'] = usuarios_online[user]['public_key']
            else:
                contato['public_key'] = pub_key
            contatos.append(contato)
        socketio.emit('lista_contatos', contatos, room=data['sid'])

@socketio.on('connect')
def handle_connect():
    logger.info(f'[CONNECT] {request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    username = sid_to_username.pop(request.sid, None)
    if username:
        usuarios_online.pop(username, None)
        logger.info(f'[DISCONNECT] {username}')
        broadcast_lista_contatos()

@socketio.on('registrar_usuario')
def handle_registrar_usuario(data):
    username = data.get('username')
    public_key = data.get('public_key')
    if not username or not public_key:
        return
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('UPDATE usuarios SET public_key = %s WHERE username = %s', (public_key, username))
    if cur.rowcount == 0:
        conn.rollback()
    else:
        conn.commit()
    cur.close()
    conn.close()

    usuarios_online[username] = {'sid': request.sid, 'public_key': public_key}
    sid_to_username[request.sid] = username
    logger.info(f'[ONLINE] {username}')

    if username in mensagens_offline:
        for msg in mensagens_offline[username]:
            emit('message', msg, room=request.sid)
        del mensagens_offline[username]

    broadcast_lista_contatos()

@socketio.on('solicitar_contatos')
def handle_solicitar_contatos():
    current_user = sid_to_username.get(request.sid)
    if not current_user:
        return
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT username, public_key FROM usuarios')
    todos = cur.fetchall()
    cur.close()
    conn.close()
    contatos = []
    for user, pub_key in todos:
        if user == current_user:
            continue
        online = user in usuarios_online
        contato = {'username': user, 'online': online}
        if online:
            contato['public_key'] = usuarios_online[user]['public_key']
        else:
            contato['public_key'] = pub_key
        contatos.append(contato)
    emit('lista_contatos', contatos, room=request.sid)

@socketio.on('message')
def handle_message(data):
    de = data.get('from')
    para = data.get('to')
    conteudo = data.get('content')
    if not de or not para or not conteudo:
        return

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('INSERT INTO mensagens (de, para, conteudo, timestamp) VALUES (%s, %s, %s, %s)',
                    (de, para, conteudo, datetime.now()))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f'Erro ao salvar mensagem: {e}')
        emit('delivery_confirmation', {'to': para, 'from': de, 'status': 'failed'}, room=request.sid)
        return

    msg_pacote = {
        'from': de,
        'content': conteudo,
        'offline': False,
        'timestamp': datetime.now().isoformat()
    }
    dest = usuarios_online.get(para)
    if dest:
        emit('message', msg_pacote, room=dest['sid'])
        emit('delivery_confirmation', {'to': para, 'from': de, 'status': 'delivered'}, room=request.sid)
    else:
        msg_pacote['offline'] = True
        mensagens_offline.setdefault(para, []).append(msg_pacote)
        emit('delivery_confirmation', {'to': para, 'from': de, 'status': 'stored_offline'}, room=request.sid)

@socketio.on('digitando')
def handle_digitando(data):
    to = data.get('to')
    from_user = data.get('from')
    if to and from_user:
        dest = usuarios_online.get(to)
        if dest:
            emit('digitando', {'from': from_user}, room=dest['sid'])

@socketio.on('solicitar_historico')
def handle_solicitar_historico(data):
    usuario = sid_to_username.get(request.sid)
    contato = data.get('contato')
    if not usuario or not contato:
        return
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('''
        SELECT de, conteudo, timestamp, lida, entregue
        FROM mensagens
        WHERE (de = %s AND para = %s) OR (de = %s AND para = %s)
        ORDER BY timestamp ASC LIMIT 100
    ''', (usuario, contato, contato, usuario))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    historico = []
    for de, conteudo, ts, lida, entregue in rows:
        historico.append({
            'from': de,
            'content': conteudo,
            'timestamp': ts.isoformat(),
            'lida': lida,
            'entregue': entregue
        })
    emit('historico_mensagens', {'contato': contato, 'mensagens': historico}, room=request.sid)

@socketio.on('marcar_lida')
def handle_marcar_lida(data):
    usuario = sid_to_username.get(request.sid)
    contato = data.get('contato')
    if not usuario or not contato:
        return
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('UPDATE mensagens SET lida = TRUE WHERE para = %s AND de = %s AND lida = FALSE',
                (usuario, contato))
    conn.commit()
    cur.close()
    conn.close()

# --------------- Registro com e-mail (inalterado) ---------------
@socketio.on('registrar_usuario_credencial')
def handle_registro_credencial(data):
    username = data.get('username')
    password_hash = data.get('password_hash')
    email = data.get('email')
    if not username or not password_hash or not email:
        emit('registro_response', {'success': False, 'message': 'Dados incompletos'}, room=request.sid)
        return
    if '@' not in email or '.' not in email:
        emit('registro_response', {'success': False, 'message': 'E-mail inválido'}, room=request.sid)
        return

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute('INSERT INTO usuarios (username, password_hash, email) VALUES (%s, %s, %s)',
                    (username, password_hash, email))
        conn.commit()
        emit('registro_response', {'success': True, 'message': 'Usuário criado'}, room=request.sid)
    except IntegrityError as e:
        conn.rollback()
        if 'usuarios_username_key' in str(e):
            emit('registro_response', {'success': False, 'message': 'Usuário já existe'}, room=request.sid)
        elif 'usuarios_email_key' in str(e):
            emit('registro_response', {'success': False, 'message': 'E-mail já cadastrado'}, room=request.sid)
        else:
            emit('registro_response', {'success': False, 'message': 'Erro ao criar conta'}, room=request.sid)
    finally:
        cur.close()
        conn.close()

# --------------- Login com device_id ---------------
@socketio.on('login_usuario')
def handle_login_credencial(data):
    username = data.get('username')
    password_hash = data.get('password_hash')
    device_id = data.get('device_id')  # identificador do dispositivo

    if not username or not password_hash:
        emit('login_response', {'success': False, 'message': 'Dados incompletos'}, room=request.sid)
        return

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT password_hash, email, device_id FROM usuarios WHERE username = %s', (username,))
    row = cur.fetchone()
    cur.close()
    conn.close()

    if not row or row[0] != password_hash:
        emit('login_response', {'success': False, 'message': 'Usuário ou senha incorretos'}, room=request.sid)
        return

    email = row[1]
    stored_device = row[2]

    # Se o device_id enviado for igual ao armazenado, login direto (mesmo dispositivo)
    if device_id and stored_device and device_id == stored_device:
        emit('login_response', {
            'success': True,
            'awaiting_2fa': False,
            'username': username,
            'message': 'Login direto'
        }, room=request.sid)
        return

    # Dispositivo novo ou primeiro login → 2FA
    if not email:
        emit('login_response', {'success': False, 'message': 'E-mail não cadastrado'}, room=request.sid)
        return

    codigo = gerar_codigo_2fa()
    pending_2fa[username] = {
        'code': codigo,
        'expires': datetime.now() + timedelta(minutes=10)
    }

    assunto = "HERMES - Código de Verificação"
    corpo = f"Seu código de verificação é: {codigo}\nEle expira em 10 minutos."
    threading.Thread(target=enviar_email, args=(email, assunto, corpo)).start()

    emit('login_response', {
        'success': True,
        'awaiting_2fa': True,
        'message': 'Código enviado'
    }, room=request.sid)

# --------------- Verificação 2FA (atualiza device_id) ---------------
@socketio.on('verify_2fa')
def handle_verify_2fa(data):
    code = data.get('code')
    username = data.get('username')
    device_id = data.get('device_id')  # enviado pelo cliente no momento da verificação

    if not username:
        emit('verify_2fa_response', {'success': False, 'message': 'Usuário não identificado'}, room=request.sid)
        return

    pending = pending_2fa.pop(username, None)
    if not pending:
        emit('verify_2fa_response', {'success': False, 'message': 'Nenhuma solicitação pendente'}, room=request.sid)
        return
    if datetime.now() > pending['expires']:
        emit('verify_2fa_response', {'success': False, 'message': 'Código expirado'}, room=request.sid)
        return
    if code != pending['code']:
        emit('verify_2fa_response', {'success': False, 'message': 'Código incorreto'}, room=request.sid)
        return

    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    if ip and ',' in ip:
        ip = ip.split(',')[0].strip()

    # Atualiza IP, device_id e envia alerta de novo login
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT email, last_ip FROM usuarios WHERE username = %s', (username,))
        user_info = cur.fetchone()
        if user_info:
            email, last_ip = user_info
            if last_ip and last_ip != ip:
                alerta_assunto = "HERMES - Novo login detectado"
                alerta_corpo = f"Um novo login foi realizado na sua conta a partir do IP {ip}.\nSe não foi você, altere sua senha imediatamente."
                threading.Thread(target=enviar_email, args=(email, alerta_assunto, alerta_corpo)).start()
            # Registra o novo dispositivo
            cur.execute('UPDATE usuarios SET last_ip = %s, device_id = %s WHERE username = %s',
                        (ip, device_id, username))
            conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Erro ao atualizar IP/device: {e}")

    emit('verify_2fa_response', {'success': True, 'username': username, 'message': 'OK'}, room=request.sid)

# --------------- Execução ---------------
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print('=' * 60)
    print('SERVIDOR CHAT - HERMES WEB (com 2FA por dispositivo)')
    print('=' * 60)
    socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False)
