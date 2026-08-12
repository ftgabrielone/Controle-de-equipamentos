/**
 * WHIZZ VÍDEO — Controle de Equipamentos · Backend v4 (com autenticação)
 * ======================================================================
 *
 * PRIMEIRO USO — faça uma vez, no editor do Apps Script:
 *   1. Selecione a função  primeiroAcesso  no menu de funções e clique em Executar.
 *   2. Autorize quando o Google pedir.
 *   3. Abra Execuções (menu lateral) e leia o PIN provisório que apareceu no log.
 *   4. Entre no app com o usuário  gabriel  e esse PIN, e troque na hora.
 *
 * Implantar: Implantar > Nova implantação > Aplicativo da Web
 *   Executar como .............. Eu
 *   Quem pode acessar .......... Qualquer pessoa
 *   (o endereço deixa de ser segredo: sem PIN válido, ninguém passa da porta)
 *
 * Onde cada coisa mora:
 *   Planilha ................. equipamentos, saídas e log de auditoria
 *   Propriedades do Script ... usuários, hashes de PIN, tokens e a chave secreta
 *   Cache .................... saída em andamento (para responder rápido)
 */

var ABA_EQUIP  = 'Equipamentos';
var ABA_SAIDAS = 'Saidas';
var ABA_LOG    = 'Log';
var COLS_EQUIP = ['nome', 'serie', 'categoria', 'estado'];
var COLS_SAIDA = ['id','criadaEm','fechadaEm','status','producao','cliente','projeto','local','responsavel','dataSaida','dataEntrada','itens','json'];
var COLS_LOG   = ['quando','usuario','acao','detalhe'];
var ESTADOS    = ['Ótimo', 'Bom', 'Regular', 'Avariado'];

var CACHE_TTL     = 21600;   // 6h
var SESSAO_HORAS  = 12;      // validade do token
var MAX_TENTATIVAS = 5;
var BLOQUEIO_MIN  = 15;
var PINS_PROIBIDOS = ['000000','111111','222222','333333','444444','555555','666666','777777','888888','999999','123456','654321','012345','123123','121212','696969','000001'];

/* ===================================================================
   ROTAS
   =================================================================== */

function doGet(e) {
  try { return _doGet(e); }
  catch (err) { return _json({ ok: false, erro: 'servidor' }); }
}

function _doGet(e) {
  var p = (e && e.parameter) || {};
  // Só o sal é público: ele é necessário antes do login e não revela nada.
  if (p.acao === 'sal') return _json({ ok: true, sal: _sal(p.usuario) });
  return _json({ ok: true, app: 'Whizz Equip', versao: 4 });
}

function doPost(e) {
  try { return _doPost(e); }
  catch (err) { return _json({ ok: false, erro: 'servidor', detalhe: String(err).slice(0, 200) }); }
}

function _doPost(e) {
  var b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return _json({ ok: false, erro: 'json' }); }
  if (JSON.stringify(b).length > 900000) return _json({ ok: false, erro: 'grande' });

  // --- rotas abertas ---
  if (b.acao === 'sal')   return _json({ ok: true, sal: _sal(b.usuario) });
  if (b.acao === 'login') return login(b.usuario, b.prova);
  if (b.acao === 'ativar') return ativar(b.usuario, b.pinProvisorio, b.provaNova);

  // --- daqui pra baixo, só com token válido ---
  var u = _autenticar(b.token);
  if (!u) return _json({ ok: false, erro: 'auth' });

  switch (b.acao) {

    case 'sessao':
      return _json({ ok: true, usuario: u.usuario, nome: u.nome, papel: u.papel });

    case 'sair':
      _apagarToken(b.token);
      return _json({ ok: true });

    case 'trocarPin':
      return trocarPin(u, b.provaAtual, b.provaNova);

    /* ---------- saídas ---------- */
    case 'saida': {
      var id = _cod(b.id);
      if (!id) return _json({ ok: false, erro: 'id' });
      return _json({ ok: true, saida: aplicarEventos(id, b.eventos || [], u) });
    }

    case 'fechar': {
      var idf = _cod(b.id);
      var s = _lerSaida(idf);
      s.status = 'fechada';
      s.fechadaEm = new Date().toISOString();
      s.fechadaPor = u.usuario;
      s.v = (s.v || 0) + 1;
      _gravarSaida(idf, s, true);
      _log(u, 'fechar-saida', idf + ' · ' + ((s.items || []).length) + ' itens');
      return _json({ ok: true, saida: s });
    }

    case 'historico':
      return _json({ ok: true, saidas: lerHistorico(b.limite || 60) });

    /* ---------- inventário ---------- */
    case 'inventario':
      return _json({ ok: true, equipamentos: lerEquipamentos() });

    case 'invAdd':
      return invAdd(u, b.equipamento);

    case 'invEditar':
      return invEditar(u, b.serie, b.equipamento);

    case 'invRemover':
      return invRemover(u, b.serie);

    case 'invSubstituir':   // importação em massa: só admin, e com cópia de segurança antes
      if (u.papel !== 'admin') return _json({ ok: false, erro: 'permissao' });
      if (!Array.isArray(b.equipamentos)) return _json({ ok: false, erro: 'lista' });
      return invSubstituir(u, b.equipamentos);

    /* ---------- usuários ---------- */
    case 'usuarios':
      if (u.papel !== 'admin') return _json({ ok: false, erro: 'permissao' });
      return _json({ ok: true, usuarios: listarUsuarios() });

    case 'criarUsuario':
      if (u.papel !== 'admin') return _json({ ok: false, erro: 'permissao' });
      return criarUsuario(u, b.usuario, b.nome, b.papel);

    case 'removerUsuario':
      if (u.papel !== 'admin') return _json({ ok: false, erro: 'permissao' });
      return removerUsuario(u, b.usuario);

    case 'resetarPin':
      if (u.papel !== 'admin') return _json({ ok: false, erro: 'permissao' });
      return resetarPin(u, b.usuario);
  }

  return _json({ ok: false, erro: 'acao' });
}

/* ===================================================================
   AUTENTICAÇÃO
   ===================================================================
   O PIN nunca sai do aparelho: o navegador aplica PBKDF2 (300 mil voltas)
   e manda só o resultado, a "prova". O servidor guarda HMAC(pimenta, prova).
   A pimenta mora nas Propriedades do Script, fora da planilha — então uma
   planilha vazada não permite quebrar PIN nenhum.
*/

function _props() { return PropertiesService.getScriptProperties(); }

function _pimenta() {
  var p = _props().getProperty('WZ_PIMENTA');
  if (!p) {
    p = _aleatorio();
    _props().setProperty('WZ_PIMENTA', p);
  }
  return p;
}

function _aleatorio() {
  var semente = Utilities.getUuid() + Utilities.getUuid() + new Date().getTime() + Math.random();
  return _hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, semente));
}

function _hex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function _hmac(valor) {
  return _hex(Utilities.computeHmacSha256Signature(String(valor), _pimenta()));
}

/** Sal por usuário: único, imprevisível, e não precisa ser guardado. */
function _sal(usuario) {
  return _hmac('sal:' + _usr(usuario)).slice(0, 32);
}

function _usr(u) {
  return String(u || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24);
}

function _lerUsuarios() {
  try { return JSON.parse(_props().getProperty('WZ_USUARIOS') || '{}'); }
  catch (e) { return {}; }
}

function _gravarUsuarios(m) {
  _props().setProperty('WZ_USUARIOS', JSON.stringify(m));
}

/** Comparação que não entrega informação pelo tempo de resposta. */
function _iguais(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var dif = 0;
  for (var i = 0; i < a.length; i++) dif |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return dif === 0;
}

function login(usuario, prova) {
  var nome = _usr(usuario);
  var mapa = _lerUsuarios();
  var reg = mapa[nome];
  var agora = new Date().getTime();

  // Usuário inexistente responde igual a PIN errado, para não revelar quem existe
  if (!reg) {
    Utilities.sleep(400);
    return _json({ ok: false, erro: 'credencial' });
  }

  if (!reg.hash) return _json({ ok: false, erro: 'ativar' });

  if (reg.bloqueadoAte && agora < reg.bloqueadoAte) {
    var faltam = Math.ceil((reg.bloqueadoAte - agora) / 60000);
    return _json({ ok: false, erro: 'bloqueado', minutos: faltam });
  }

  if (!_iguais(reg.hash, _hmac('pin:' + nome + ':' + prova))) {
    reg.tentativas = (reg.tentativas || 0) + 1;
    if (reg.tentativas >= MAX_TENTATIVAS) {
      reg.bloqueadoAte = agora + BLOQUEIO_MIN * 60000;
      reg.tentativas = 0;
      mapa[nome] = reg;
      _gravarUsuarios(mapa);
      _log({ usuario: nome }, 'bloqueio', 'PIN errado ' + MAX_TENTATIVAS + ' vezes');
      return _json({ ok: false, erro: 'bloqueado', minutos: BLOQUEIO_MIN });
    }
    mapa[nome] = reg;
    _gravarUsuarios(mapa);
    Utilities.sleep(400);
    return _json({ ok: false, erro: 'credencial', restam: MAX_TENTATIVAS - reg.tentativas });
  }

  reg.tentativas = 0;
  reg.bloqueadoAte = 0;
  reg.ultimoAcesso = new Date().toISOString();
  mapa[nome] = reg;
  _gravarUsuarios(mapa);

  var token = _criarToken(nome);
  _log({ usuario: nome }, 'login', '');
  return _json({
    ok: true,
    token: token,
    usuario: nome,
    nome: reg.nome,
    papel: reg.papel,
    trocarPin: !!reg.provisorio,
    expiraEm: new Date(new Date().getTime() + SESSAO_HORAS * 3600000).toISOString()
  });
}

/**
 * Primeiro acesso: a pessoa digita o PIN provisório e já escolhe o definitivo.
 * O provisório vale uma única vez e nunca vira senha de verdade.
 */
function ativar(usuario, pinProvisorio, provaNova) {
  var nome = _usr(usuario);
  var mapa = _lerUsuarios();
  var reg = mapa[nome];

  if (!reg || !reg.provisorio || reg.hash) {
    Utilities.sleep(400);
    return _json({ ok: false, erro: 'credencial' });
  }

  var agora = new Date().getTime();
  if (reg.bloqueadoAte && agora < reg.bloqueadoAte) {
    return _json({ ok: false, erro: 'bloqueado', minutos: Math.ceil((reg.bloqueadoAte - agora) / 60000) });
  }

  if (!_iguais(reg.provHash, _hmac('prov:' + nome + ':' + String(pinProvisorio || '')))) {
    reg.tentativas = (reg.tentativas || 0) + 1;
    if (reg.tentativas >= MAX_TENTATIVAS) {
      reg.bloqueadoAte = agora + BLOQUEIO_MIN * 60000;
      reg.tentativas = 0;
    }
    mapa[nome] = reg;
    _gravarUsuarios(mapa);
    Utilities.sleep(400);
    return _json({ ok: false, erro: 'credencial' });
  }

  if (!provaNova || String(provaNova).length < 32) return _json({ ok: false, erro: 'fraco' });

  reg.hash = _hmac('pin:' + nome + ':' + provaNova);
  reg.provisorio = false;
  reg.provHash = '';
  reg.tentativas = 0;
  reg.bloqueadoAte = 0;
  reg.ativadoEm = new Date().toISOString();
  mapa[nome] = reg;
  _gravarUsuarios(mapa);

  _log({ usuario: nome }, 'ativar-conta', '');
  return _json({ ok: true, token: _criarToken(nome), usuario: nome, nome: reg.nome, papel: reg.papel });
}

function _criarToken(usuario) {
  var token = _aleatorio();
  var dados = { usuario: usuario, expira: new Date().getTime() + SESSAO_HORAS * 3600000 };
  _props().setProperty('WZ_T_' + _hmac(token), JSON.stringify(dados));
  CacheService.getScriptCache().put('WZ_T_' + _hmac(token), JSON.stringify(dados), CACHE_TTL);
  return token;
}

function _autenticar(token) {
  if (!token || String(token).length < 32) return null;
  var chave = 'WZ_T_' + _hmac(token);

  var bruto = CacheService.getScriptCache().get(chave) || _props().getProperty(chave);
  if (!bruto) return null;

  var dados;
  try { dados = JSON.parse(bruto); } catch (e) { return null; }
  if (!dados.expira || new Date().getTime() > dados.expira) {
    _props().deleteProperty(chave);
    return null;
  }

  var reg = _lerUsuarios()[dados.usuario];
  if (!reg) return null;

  CacheService.getScriptCache().put(chave, bruto, 3600);
  return { usuario: dados.usuario, nome: reg.nome, papel: reg.papel };
}

function _apagarToken(token) {
  var chave = 'WZ_T_' + _hmac(token);
  _props().deleteProperty(chave);
  CacheService.getScriptCache().remove(chave);
}

function trocarPin(u, provaAtual, provaNova) {
  var mapa = _lerUsuarios();
  var reg = mapa[u.usuario];
  if (!reg) return _json({ ok: false, erro: 'auth' });
  if (!_iguais(reg.hash, _hmac('pin:' + u.usuario + ':' + provaAtual))) {
    Utilities.sleep(400);
    return _json({ ok: false, erro: 'credencial' });
  }
  if (!provaNova || String(provaNova).length < 32) return _json({ ok: false, erro: 'fraco' });

  reg.hash = _hmac('pin:' + u.usuario + ':' + provaNova);
  reg.provisorio = false;
  reg.trocadoEm = new Date().toISOString();
  mapa[u.usuario] = reg;
  _gravarUsuarios(mapa);
  _log(u, 'trocar-pin', '');
  return _json({ ok: true });
}

/* ---------------- usuários ---------------- */

function listarUsuarios() {
  var mapa = _lerUsuarios();
  var lista = [];
  for (var k in mapa) {
    lista.push({
      usuario: k,
      nome: mapa[k].nome,
      papel: mapa[k].papel,
      ultimoAcesso: mapa[k].ultimoAcesso || '',
      bloqueado: !!(mapa[k].bloqueadoAte && new Date().getTime() < mapa[k].bloqueadoAte),
      provisorio: !!mapa[k].provisorio
    });
  }
  return lista;
}

function criarUsuario(admin, usuario, nome, papel) {
  var nomeUsr = _usr(usuario);
  if (nomeUsr.length < 3) return _json({ ok: false, erro: 'usuario-curto' });

  var mapa = _lerUsuarios();
  if (mapa[nomeUsr]) return _json({ ok: false, erro: 'existe' });

  var pin = _pinProvisorio();
  mapa[nomeUsr] = {
    nome: String(nome || nomeUsr).slice(0, 40),
    papel: (papel === 'admin') ? 'admin' : 'operador',
    hash: '',
    provisorio: true,
    provHash: _hmac('prov:' + nomeUsr + ':' + pin),   // o PIN em si nunca é guardado
    criadoEm: new Date().toISOString()
  };
  _gravarUsuarios(mapa);
  _log(admin, 'criar-usuario', nomeUsr + ' (' + mapa[nomeUsr].papel + ')');
  return _json({ ok: true, usuario: nomeUsr, pinProvisorio: pin });
}

function removerUsuario(admin, usuario) {
  var alvo = _usr(usuario);
  if (alvo === admin.usuario) return _json({ ok: false, erro: 'proprio' });
  var mapa = _lerUsuarios();
  if (!mapa[alvo]) return _json({ ok: false, erro: 'inexistente' });
  delete mapa[alvo];
  _gravarUsuarios(mapa);
  _log(admin, 'remover-usuario', alvo);
  return _json({ ok: true });
}

function resetarPin(admin, usuario) {
  var alvo = _usr(usuario);
  var mapa = _lerUsuarios();
  if (!mapa[alvo]) return _json({ ok: false, erro: 'inexistente' });
  var pin = _pinProvisorio();
  mapa[alvo].hash = '';
  mapa[alvo].provisorio = true;
  mapa[alvo].provHash = _hmac('prov:' + alvo + ':' + pin);
  mapa[alvo].tentativas = 0;
  mapa[alvo].bloqueadoAte = 0;
  _gravarUsuarios(mapa);
  _log(admin, 'resetar-pin', alvo);
  return _json({ ok: true, pinProvisorio: pin });
}

function _pinProvisorio() {
  var n = '';
  for (var i = 0; i < 6; i++) n += Math.floor(Math.random() * 10);
  return (PINS_PROIBIDOS.indexOf(n) >= 0) ? _pinProvisorio() : n;
}

/* ===================================================================
   INVENTÁRIO — nada de apagar tudo de uma vez
   =================================================================== */

function invAdd(u, eq) {
  eq = eq || {};
  var nome = String(eq.nome || '').trim();
  var serie = String(eq.serie || '').trim();
  if (!nome || !serie) return _json({ ok: false, erro: 'campos' });

  var sh = _abaEquip();
  if (_linhaDoEquip(sh, serie)) return _json({ ok: false, erro: 'duplicado' });

  sh.appendRow([nome, serie, String(eq.categoria || '').trim(), _estado(eq.estado)]);
  _log(u, 'inv-add', serie + ' · ' + nome);
  return _json({ ok: true, equipamentos: lerEquipamentos() });
}

function invEditar(u, serie, eq) {
  var sh = _abaEquip();
  var linha = _linhaDoEquip(sh, serie);
  if (!linha) return _json({ ok: false, erro: 'inexistente' });

  eq = eq || {};
  sh.getRange(linha, 1, 1, COLS_EQUIP.length).setValues([[
    String(eq.nome || '').trim(),
    String(eq.serie || serie).trim(),
    String(eq.categoria || '').trim(),
    _estado(eq.estado)
  ]]);
  _log(u, 'inv-editar', serie);
  return _json({ ok: true, equipamentos: lerEquipamentos() });
}

function invRemover(u, serie) {
  var sh = _abaEquip();
  var linha = _linhaDoEquip(sh, serie);
  if (!linha) return _json({ ok: false, erro: 'inexistente' });
  sh.deleteRow(linha);
  _log(u, 'inv-remover', String(serie));
  return _json({ ok: true, equipamentos: lerEquipamentos() });
}

function invSubstituir(u, equipamentos) {
  var antes = lerEquipamentos();

  // Cópia de segurança antes de qualquer operação em massa
  if (antes.length) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var carimbo = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
    var copia = ss.insertSheet('Backup_' + carimbo);
    copia.getRange(1, 1, 1, COLS_EQUIP.length).setValues([COLS_EQUIP]);
    copia.getRange(2, 1, antes.length, COLS_EQUIP.length).setValues(
      antes.map(function (e) { return [e.nome, e.serie, e.categoria, e.estado]; })
    );
  }

  var total = gravarEquipamentos(equipamentos);
  _log(u, 'inv-substituir', antes.length + ' → ' + total + ' (cópia guardada)');
  return _json({ ok: true, total: total, anterior: antes.length, equipamentos: lerEquipamentos() });
}

function _linhaDoEquip(sh, serie) {
  var ultima = sh.getLastRow();
  if (ultima < 2) return 0;
  var v = sh.getRange(2, 2, ultima - 1, 1).getValues();
  var alvo = String(serie || '').trim().toLowerCase();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim().toLowerCase() === alvo) return i + 2;
  }
  return 0;
}

/* ===================================================================
   SAÍDA COMPARTILHADA
   =================================================================== */

function _saidaVazia(id) {
  return { id: id, v: 0, status: 'aberta', criadaEm: new Date().toISOString(),
           fechadaEm: '', campos: {}, items: [], rented: [] };
}

function _lerSaida(id) {
  var bruto = CacheService.getScriptCache().get('WZ_S_' + id);
  if (bruto) { try { return JSON.parse(bruto); } catch (e) {} }
  var daPlanilha = _buscarSaidaNaPlanilha(id);
  if (daPlanilha) {
    CacheService.getScriptCache().put('WZ_S_' + id, JSON.stringify(daPlanilha), CACHE_TTL);
    return daPlanilha;
  }
  return _saidaVazia(id);
}

function _gravarSaida(id, saida, naPlanilha) {
  CacheService.getScriptCache().put('WZ_S_' + id, JSON.stringify(saida), CACHE_TTL);
  if (naPlanilha) _salvarSaidaNaPlanilha(id, saida);
}

function aplicarEventos(id, eventos, u) {
  if (!eventos.length) return _lerSaida(id);
  if (eventos.length > 300) eventos = eventos.slice(0, 300);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err) { return _lerSaida(id); }

  try {
    var s = _lerSaida(id);
    if (s.status === 'fechada') return s;      // saída fechada não aceita mais mudança
    var mudou = false;

    for (var i = 0; i < eventos.length; i++) {
      var ev = eventos[i] || {};

      if (ev.t === 'campo' && ev.k) {
        s.campos[String(ev.k).slice(0, 40)] = String(ev.v == null ? '' : ev.v).slice(0, 300);
        mudou = true;

      } else if (ev.t === 'add' && ev.item && ev.item.serie) {
        if (!_temSerie(s.items, ev.item.serie) && s.items.length < 500) {
          var novo = _limparItem(ev.item);
          novo.por = u.usuario;
          s.items.push(novo);
          mudou = true;
        }

      } else if (ev.t === 'del' && ev.serie) {
        var antes = s.items.length;
        s.items = s.items.filter(function (it) { return !_mesmaSerie(it.serie, ev.serie); });
        if (s.items.length !== antes) mudou = true;

      } else if (ev.t === 'addAlugado' && ev.item && ev.item.serie) {
        if (s.rented.length < 200) { s.rented.push(_limparAlugado(ev.item)); mudou = true; }

      } else if (ev.t === 'delAlugado' && ev.serie) {
        var antesR = s.rented.length;
        s.rented = s.rented.filter(function (it) { return !_mesmaSerie(it.serie, ev.serie); });
        if (s.rented.length !== antesR) mudou = true;

      } else if (ev.t === 'limpar') {
        s = _saidaVazia(id);
        mudou = true;
      }
    }

    if (mudou) {
      s.v = (s.v || 0) + 1;
      s.porUltimo = u.usuario;
      _gravarSaida(id, s, true);
    }
    return s;

  } finally {
    lock.releaseLock();
  }
}

function _temSerie(lista, serie) {
  for (var i = 0; i < lista.length; i++) if (_mesmaSerie(lista[i].serie, serie)) return true;
  return false;
}

function _mesmaSerie(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function _limparItem(it) {
  return { nome: String(it.nome || 'Equipamento').slice(0, 120),
           serie: String(it.serie).trim().slice(0, 40),
           qtd: Math.max(1, Math.min(999, parseInt(it.qtd, 10) || 1)),
           estado: _estado(it.estado) };
}

function _limparAlugado(it) {
  return { locadora: String(it.locadora || '').slice(0, 80),
           nome: String(it.nome || 'Equipamento').slice(0, 120),
           serie: String(it.serie).trim().slice(0, 40),
           estado: _estado(it.estado) };
}

/* ===================================================================
   PLANILHA
   =================================================================== */

function _aba(nome, colunas) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.getRange(1, 1, 1, colunas.length).setValues([colunas]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function _abaEquip()  { return _aba(ABA_EQUIP, COLS_EQUIP); }
function _abaSaidas() { return _aba(ABA_SAIDAS, COLS_SAIDA); }
function _abaLog()    { return _aba(ABA_LOG, COLS_LOG); }

function _log(u, acao, detalhe) {
  try {
    _abaLog().appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      (u && u.usuario) || '?',
      acao,
      String(detalhe || '').slice(0, 300)
    ]);
  } catch (e) { /* o log nunca pode derrubar a operação */ }
}

function _linhaDaSaida(sh, id) {
  var ultima = sh.getLastRow();
  if (ultima < 2) return 0;
  var ids = sh.getRange(2, 1, ultima - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().toUpperCase() === id) return i + 2;
  }
  return 0;
}

function _salvarSaidaNaPlanilha(id, s) {
  try {
    var sh = _abaSaidas();
    var linha = _linhaDaSaida(sh, id) || (sh.getLastRow() + 1);
    var c = s.campos || {};
    sh.getRange(linha, 1, 1, COLS_SAIDA.length).setValues([[
      id, s.criadaEm || '', s.fechadaEm || '', s.status || 'aberta',
      c.producao || '', c.cliente || '', c.projeto || '', c.localGravacao || c.local || '',
      c.responsavel || '', c.dataSaida || '', c.dataEntrada || '',
      (s.items || []).length + (s.rented || []).length,
      JSON.stringify(s)
    ]]);
  } catch (err) {}
}

function _buscarSaidaNaPlanilha(id) {
  try {
    var sh = _abaSaidas();
    var linha = _linhaDaSaida(sh, id);
    if (!linha) return null;
    var bruto = sh.getRange(linha, COLS_SAIDA.indexOf('json') + 1).getValue();
    return bruto ? JSON.parse(bruto) : null;
  } catch (err) { return null; }
}

function lerHistorico(limite) {
  var sh = _abaSaidas();
  var ultima = sh.getLastRow();
  if (ultima < 2) return [];

  var quantas = Math.min(limite || 60, ultima - 1);
  var v = sh.getRange(ultima - quantas + 1, 1, quantas, COLS_SAIDA.length - 1).getValues();

  var lista = [];
  for (var i = v.length - 1; i >= 0; i--) {
    if (!v[i][0]) continue;
    lista.push({ id: String(v[i][0]), criadaEm: String(v[i][1]), fechadaEm: String(v[i][2]),
                 status: String(v[i][3]), producao: String(v[i][4]), cliente: String(v[i][5]),
                 projeto: String(v[i][6]), local: String(v[i][7]), responsavel: String(v[i][8]),
                 dataSaida: String(v[i][9]), dataEntrada: String(v[i][10]), itens: Number(v[i][11]) || 0 });
  }
  return lista;
}

function lerEquipamentos() {
  var sh = _abaEquip();
  var ultima = sh.getLastRow();
  if (ultima < 2) return [];

  var v = sh.getRange(2, 1, ultima - 1, COLS_EQUIP.length).getValues();
  var lista = [];
  for (var i = 0; i < v.length; i++) {
    var nome = String(v[i][0] || '').trim();
    var serie = String(v[i][1] || '').trim();
    if (!nome || !serie) continue;
    lista.push({ nome: nome, serie: serie, categoria: String(v[i][2] || '').trim(), estado: _estado(v[i][3]) });
  }
  return lista;
}

function gravarEquipamentos(equipamentos) {
  var sh = _abaEquip();
  var linhas = [];
  for (var i = 0; i < equipamentos.length; i++) {
    var d = equipamentos[i] || {};
    var nome = String(d.nome || '').trim();
    var serie = String(d.serie || '').trim();
    if (!nome || !serie) continue;
    linhas.push([nome, serie, String(d.categoria || '').trim(), _estado(d.estado)]);
  }
  var ultima = sh.getLastRow();
  if (ultima > 1) sh.getRange(2, 1, ultima - 1, COLS_EQUIP.length).clearContent();
  if (linhas.length) sh.getRange(2, 1, linhas.length, COLS_EQUIP.length).setValues(linhas);
  return linhas.length;
}

/* ===================================================================
   APOIO
   =================================================================== */

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _cod(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); }

function _estado(v) {
  var e = String(v || '').trim();
  return ESTADOS.indexOf(e) >= 0 ? e : 'Bom';
}

/* ===================================================================
   PRIMEIRO USO — rode esta função uma vez, no editor
   =================================================================== */

function primeiroAcesso() {
  _pimenta();                       // cria a chave secreta se ainda não existir
  var mapa = _lerUsuarios();

  if (Object.keys(mapa).length) {
    Logger.log('Já existem usuários: ' + Object.keys(mapa).join(', '));
    Logger.log('Para zerar tudo e recomeçar, rode apagarTudoEComecarDeNovo().');
    return;
  }

  var pin = _pinProvisorio();
  mapa['gabriel'] = {
    nome: 'Gabriel',
    papel: 'admin',
    hash: '',
    provisorio: true,
    provHash: _hmac('prov:gabriel:' + pin),
    criadoEm: new Date().toISOString()
  };
  _gravarUsuarios(mapa);

  Logger.log('=======================================');
  Logger.log('  Usuário: gabriel');
  Logger.log('  PIN provisório: ' + pin);
  Logger.log('  Troque assim que entrar.');
  Logger.log('=======================================');
}

function apagarTudoEComecarDeNovo() {
  _props().deleteAllProperties();
  Logger.log('Usuários, tokens e chave secreta apagados. Rode primeiroAcesso() de novo.');
}
/* ===================================================================
   AJUDANTES — rode direto no editor do Apps Script
   Selecione a função no menu ao lado do botão Executar, clique em
   Executar e leia o resultado em "Execuções", no menu lateral.
   =================================================================== */

/**
 * Cria uma conta nova para alguém da equipe.
 * Edite as três linhas abaixo, salve e execute.
 */
function novoUsuario() {

  var USUARIO = 'joao';        // sem espaços nem acentos: é o que a pessoa digita
  var NOME    = 'João Silva';  // como aparece no topo do app
  var PAPEL   = 'operador';    // 'operador' ou 'admin'

  var r = JSON.parse(criarUsuario({ usuario: 'editor', papel: 'admin' }, USUARIO, NOME, PAPEL).getContent());

  if (!r.ok) {
    Logger.log('Não deu certo: ' + r.erro + (r.erro === 'existe' ? ' (esse usuário já foi criado)' : ''));
    return;
  }

  Logger.log('=========================================');
  Logger.log('  Conta criada');
  Logger.log('  Usuário .......... ' + r.usuario);
  Logger.log('  PIN provisório ... ' + r.pinProvisorio);
  Logger.log('');
  Logger.log('  Passe esses dados para a pessoa.');
  Logger.log('  Na primeira entrada ela escolhe o PIN dela');
  Logger.log('  e este provisório deixa de valer.');
  Logger.log('=========================================');
}

/**
 * Sorteia um novo PIN provisório para alguém que esqueceu o dele
 * (inclusive você). Também destrava conta bloqueada por tentativas.
 */
function resetarPinDeAlguem() {

  var USUARIO = 'gabriel';     // quem perdeu o PIN

  var r = JSON.parse(resetarPin({ usuario: 'editor', papel: 'admin' }, USUARIO).getContent());

  if (!r.ok) {
    Logger.log('Não deu certo: ' + r.erro);
    return;
  }

  Logger.log('=========================================');
  Logger.log('  PIN provisório de ' + USUARIO + ': ' + r.pinProvisorio);
  Logger.log('  Vale uma vez só. Na entrada, o app pede o definitivo.');
  Logger.log('=========================================');
}

/** Mostra quem tem conta, o papel de cada um e o último acesso. */
function verUsuarios() {
  var lista = listarUsuarios();
  if (!lista.length) {
    Logger.log('Nenhuma conta ainda. Rode primeiroAcesso().');
    return;
  }
  Logger.log('Contas cadastradas:');
  for (var i = 0; i < lista.length; i++) {
    var u = lista[i];
    Logger.log('  ' + u.usuario +
               ' · ' + u.papel +
               (u.provisorio ? ' · AGUARDANDO ATIVAÇÃO' : '') +
               (u.bloqueado ? ' · BLOQUEADO' : '') +
               (u.ultimoAcesso ? ' · último acesso ' + u.ultimoAcesso.slice(0, 16).replace('T', ' ') : ' · nunca entrou'));
  }
}

/** Apaga uma conta. Use quando alguém sair da equipe. */
function apagarUsuario() {

  var USUARIO = 'joao';

  var r = JSON.parse(removerUsuario({ usuario: 'editor', papel: 'admin' }, USUARIO).getContent());
  Logger.log(r.ok ? 'Conta ' + USUARIO + ' apagada.' : 'Não deu certo: ' + r.erro);
}

/**
 * WHIZZ EQUIP — acréscimos ao Backend v4
 * ======================================
 *
 * Isto NÃO é o arquivo inteiro. São alterações no código que já está
 * publicado na sua planilha. Nada aqui apaga dado nem muda a estrutura
 * das abas: as colunas continuam exatamente as mesmas.
 *
 * São 5 pontos. Os três primeiros são obrigatórios para as funções
 * novas; os dois últimos consertam problemas que encontrei lendo o v4.
 *
 *   PONTO 1  trocar uma linha no _doPost (limite de tamanho)
 *   PONTO 2  acrescentar 3 casos no switch do _doPost
 *   PONTO 3  colar as funções novas no fim do arquivo
 *   PONTO 4  substituir lerHistorico  (mostra a gravação no histórico)
 *   PONTO 5  substituir invSubstituir (conserta o acúmulo de abas Backup_)
 *
 * DEPOIS DE COLAR: Implantar → Gerenciar implantações → editar a
 * implantação atual → Versão: Nova versão → Implantar. Sem esse passo o
 * link continua servindo o código antigo.
 *
 * Na primeira execução o Google vai pedir autorização para a Agenda e
 * para o Gmail, porque o script passou a usar serviços novos. Rode a
 * função conferirAgendaEEmail() no editor para disparar esse pedido
 * antes de implantar.
 */


/* ===================================================================
   PONTO 1 — limite de tamanho do pedido
   -------------------------------------------------------------------
   No _doPost existe hoje esta linha:

       if (JSON.stringify(b).length > 900000) return _json({ ok: false, erro: 'grande' });

   Troque pelas três linhas abaixo. Dois motivos:

   - o relatório vai com o PDF anexado em base64, e um termo de duas ou
     três páginas passa dos 900 mil caracteres. Com o limite antigo o
     envio falharia justamente nas saídas grandes;
   - JSON.stringify(b) refaz o texto inteiro só para medi-lo. O tamanho
     que chegou já está em e.postData.contents, de graça.

   var limite = (b.acao === 'enviarRelatorio') ? 8000000 : 900000;
   var tamanho = (e.postData && e.postData.contents) ? e.postData.contents.length : 0;
   if (tamanho > limite) return _json({ ok: false, erro: 'grande' });
   =================================================================== */


/* ===================================================================
   PONTO 2 — casos novos no switch do _doPost
   -------------------------------------------------------------------
   Dentro do switch (b.acao), depois do case 'historico', acrescente os
   três casos abaixo. Eles ficam DEPOIS da linha

       var u = _autenticar(b.token);

   de propósito: assim a agenda e o disparo de email só funcionam para
   quem está logado. Sem isso, qualquer um com o link /exec leria a sua
   agenda e mandaria email pela conta da Whizz.

    case 'agenda':
      return _json(acaoAgenda(b));

    case 'enviarRelatorio':
      return _json(acaoEnviarRelatorio(b, u));

    case 'saidaDetalhe': {
      var idd = _cod(b.id);
      if (!idd) return _json({ ok: false, erro: 'id' });
      var sd = _buscarSaidaNaPlanilha(idd);
      if (!sd) {
        var emCache = CacheService.getScriptCache().get('WZ_S_' + idd);
        if (emCache) { try { sd = JSON.parse(emCache); } catch (e2) {} }
      }
      if (!sd) return _json({ ok: false, erro: 'naoEncontrada' });
      return _json({ ok: true, saida: sd });
    }
   =================================================================== */


/* ===================================================================
   PONTO 3 — funções novas
   Cole tudo daqui até o fim do bloco no final do seu arquivo.
   =================================================================== */

/**
 * AGENDA — lê a agenda principal da conta que publicou este script.
 * Recebe: { de: 'AAAA-MM-DD', ate: 'AAAA-MM-DD' }
 * Devolve: { ok:true, eventos:[{id, titulo, inicio, fim, local, diaInteiro}] }
 */
function acaoAgenda(dados) {
  var agenda = CalendarApp.getDefaultCalendar();
  if (!agenda) return { ok: false, erro: 'semAgenda' };

  var de  = _dataDoTexto(dados.de,  -7);
  var ate = _dataDoTexto(dados.ate,  30);
  ate.setHours(23, 59, 59, 999);   // o último dia entra inteiro

  var eventos = agenda.getEvents(de, ate).map(function (ev) {
    return {
      id:         ev.getId(),
      titulo:     ev.getTitle(),
      inicio:     ev.getStartTime().toISOString(),
      fim:        ev.getEndTime().toISOString(),
      local:      ev.getLocation() || '',
      diaInteiro: ev.isAllDayEvent()
    };
  });

  // mais próximos primeiro: é o que a pessoa procura no galpão
  eventos.sort(function (a, b) { return new Date(a.inicio) - new Date(b.inicio); });

  return { ok: true, eventos: eventos };
}

/** Aceita 'AAAA-MM-DD'. Sem isso, cai em hoje mais o número de dias indicado. */
function _dataDoTexto(texto, diasPadrao) {
  var partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || ''));
  if (partes) {
    return new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
  }
  var d = new Date();
  d.setDate(d.getDate() + (diasPadrao || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * ENVIAR RELATÓRIO — o PDF é montado no navegador, com o mesmo layout
 * de sempre, e chega aqui em base64. Aqui só remontamos e anexamos.
 * Recebe: { para, assunto, mensagem, nomeArquivo, pdf }
 */
function acaoEnviarRelatorio(dados, u) {
  var para = String(dados.para || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(para)) return { ok: false, erro: 'emailInvalido' };
  if (!dados.pdf) return { ok: false, erro: 'semAnexo' };

  // a conta tem teto diário; avisar antes é melhor do que falhar no meio
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, erro: 'cota' };

  var nome = String(dados.nomeArquivo || 'termo-de-saida.pdf');
  if (nome.slice(-4).toLowerCase() !== '.pdf') nome += '.pdf';

  var anexo;
  try {
    anexo = Utilities.newBlob(Utilities.base64Decode(dados.pdf), 'application/pdf', nome);
  } catch (err) {
    return { ok: false, erro: 'anexoInvalido' };
  }

  try {
    MailApp.sendEmail({
      to: para,
      subject: String(dados.assunto || 'Termo de saída de equipamentos — Whizz Vídeo'),
      body: String(dados.mensagem || 'Segue em anexo o termo de saída de equipamentos da Whizz Vídeo.'),
      name: 'Whizz Vídeo — Controle de Equipamentos',
      attachments: [anexo]
    });
  } catch (err) {
    return { ok: false, erro: 'falhaEnvio', detalhe: String(err).slice(0, 200) };
  }

  _log(u, 'enviar-relatorio', para + ' · ' + nome);
  return { ok: true, restam: MailApp.getRemainingDailyQuota() };
}

/**
 * CONFERÊNCIA — rode esta função uma vez pelo editor, antes de implantar.
 * Ela força o pedido de autorização da Agenda e do Gmail e mostra no log
 * se as duas estão de pé. Não envia email nenhum.
 */
function conferirAgendaEEmail() {
  var agenda = CalendarApp.getDefaultCalendar();
  Logger.log('Agenda principal: %s', agenda ? agenda.getName() : '(nenhuma)');

  var r = acaoAgenda({});
  Logger.log('Gravações nos próximos 30 dias: %s', r.eventos ? r.eventos.length : 0);
  (r.eventos || []).slice(0, 5).forEach(function (ev) {
    Logger.log('   %s — %s', ev.inicio.slice(0, 16).replace('T', ' '), ev.titulo);
  });

  Logger.log('Emails que ainda posso enviar hoje: %s', MailApp.getRemainingDailyQuota());
}


/* ===================================================================
   PONTO 4 — substituir lerHistorico
   -------------------------------------------------------------------
   Apague a lerHistorico que está lá e cole esta no lugar.

   O que muda: a coluna json já guarda a saída inteira, inclusive os
   campos da agenda. Em vez de acrescentar colunas novas na planilha,
   esta versão lê o json e tira de lá o título e a data da gravação.
   Nenhuma aba muda de formato, e as saídas antigas continuam válidas —
   simplesmente aparecem sem gravação vinculada, que é o correto.
   =================================================================== */

function lerHistorico(limite) {
  var sh = _abaSaidas();
  var ultima = sh.getLastRow();
  if (ultima < 2) return [];

  var quantas = Math.min(limite || 60, ultima - 1);
  var v = sh.getRange(ultima - quantas + 1, 1, quantas, COLS_SAIDA.length).getValues();
  var colJson = COLS_SAIDA.indexOf('json');

  var lista = [];
  for (var i = v.length - 1; i >= 0; i--) {
    if (!v[i][0]) continue;

    var linha = {
      id: String(v[i][0]), criadaEm: String(v[i][1]), fechadaEm: String(v[i][2]),
      status: String(v[i][3]), producao: String(v[i][4]), cliente: String(v[i][5]),
      projeto: String(v[i][6]), local: String(v[i][7]), responsavel: String(v[i][8]),
      dataSaida: String(v[i][9]), dataEntrada: String(v[i][10]), itens: Number(v[i][11]) || 0,
      agendaTitulo: '', agendaInicio: ''
    };

    // a gravação vinculada mora dentro do json, junto dos outros campos
    try {
      var s = JSON.parse(v[i][colJson]);
      var c = (s && s.campos) || {};
      linha.agendaTitulo = String(c.agendaTitulo || '');
      linha.agendaInicio = String(c.agendaInicio || '');
    } catch (err) { /* saída antiga ou json truncado: segue sem agenda */ }

    lista.push(linha);
  }
  return lista;
}


/* ===================================================================
   PONTO 5 — substituir invSubstituir
   -------------------------------------------------------------------
   Apague a invSubstituir que está lá e cole esta no lugar.

   O problema: o aplicativo chama invSubstituir a cada alteração no
   acervo, 1,2 segundo depois de você mexer em qualquer item. A versão
   atual cria uma aba nova "Backup_data_hora" a cada chamada, com o
   carimbo em minutos. Isso dá dois estragos:

     1. a planilha vai enchendo de abas Backup_ — uma por minuto em que
        alguém encostar no acervo;
     2. duas alterações dentro do mesmo minuto tentam criar duas abas
        com o mesmo nome. A segunda estoura, o erro sobe até o _doPost e
        volta como {ok:false, erro:'servidor'} — ou seja, a segunda
        edição rápida simplesmente não salva.

   Esta versão mantém uma única aba, "Backup_Equipamentos", sempre
   reescrita com o estado anterior à última gravação. A rede de proteção
   continua lá (dá para recuperar de um apagão acidental), sem entulhar
   a planilha e sem falhar em edições seguidas.
   =================================================================== */

function invSubstituir(u, equipamentos) {
  var antes = lerEquipamentos();

  if (antes.length) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var copia = ss.getSheetByName('Backup_Equipamentos');
      if (!copia) copia = ss.insertSheet('Backup_Equipamentos');
      copia.clear();
      copia.getRange(1, 1, 1, COLS_EQUIP.length).setValues([COLS_EQUIP]).setFontWeight('bold');
      copia.getRange(2, 1, antes.length, COLS_EQUIP.length).setValues(
        antes.map(function (e) { return [e.nome, e.serie, e.categoria, e.estado]; })
      );
      copia.getRange(1, COLS_EQUIP.length + 2).setValue(
        'Estado anterior a ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm')
      );
    } catch (err) {
      // a cópia é rede de proteção, não pode impedir a gravação em si
    }
  }

  var total = gravarEquipamentos(equipamentos);
  _log(u, 'inv-substituir', antes.length + ' → ' + total);
  return _json({ ok: true, total: total, anterior: antes.length, equipamentos: lerEquipamentos() });
}

/**
 * WHIZZ EQUIP — acréscimos ao Backend v4
 * ======================================
 *
 * Isto NÃO é o arquivo inteiro. São alterações no código que já está
 * publicado na sua planilha. Nada aqui apaga dado nem muda a estrutura
 * das abas: as colunas continuam exatamente as mesmas.
 *
 * São 5 pontos. Os três primeiros são obrigatórios para as funções
 * novas; os dois últimos consertam problemas que encontrei lendo o v4.
 *
 *   PONTO 1  trocar uma linha no _doPost (limite de tamanho)
 *   PONTO 2  acrescentar 4 casos no switch do _doPost
 *   PONTO 3  colar as funções novas no fim do arquivo
 *   PONTO 4  substituir lerHistorico  (mostra a gravação no histórico)
 *   PONTO 5  substituir invSubstituir (conserta o acúmulo de abas Backup_)
 *
 * DEPOIS DE COLAR: Implantar → Gerenciar implantações → editar a
 * implantação atual → Versão: Nova versão → Implantar. Sem esse passo o
 * link continua servindo o código antigo.
 *
 * Na primeira execução o Google vai pedir autorização para a Agenda e
 * para o Gmail, porque o script passou a usar serviços novos. Rode a
 * função conferirAgendaEEmail() no editor para disparar esse pedido
 * antes de implantar.
 */


/* ===================================================================
   PONTO 1 — limite de tamanho do pedido
   -------------------------------------------------------------------
   No _doPost existe hoje esta linha:

       if (JSON.stringify(b).length > 900000) return _json({ ok: false, erro: 'grande' });

   Troque pelas três linhas abaixo. Dois motivos:

   - o relatório vai com o PDF anexado em base64, e um termo de duas ou
     três páginas passa dos 900 mil caracteres. Com o limite antigo o
     envio falharia justamente nas saídas grandes;
   - JSON.stringify(b) refaz o texto inteiro só para medi-lo. O tamanho
     que chegou já está em e.postData.contents, de graça.

   var limite = (b.acao === 'enviarRelatorio') ? 8000000 : 900000;
   var tamanho = (e.postData && e.postData.contents) ? e.postData.contents.length : 0;
   if (tamanho > limite) return _json({ ok: false, erro: 'grande' });
   =================================================================== */


/* ===================================================================
   PONTO 2 — casos novos no switch do _doPost
   -------------------------------------------------------------------
   Dentro do switch (b.acao), depois do case 'historico', acrescente os
   quatro casos abaixo. Eles ficam DEPOIS da linha

       var u = _autenticar(b.token);

   de propósito: assim a agenda e o disparo de email só funcionam para
   quem está logado. Sem isso, qualquer um com o link /exec leria a sua
   agenda e mandaria email pela conta da Whizz.

    case 'agenda':
      return _json(acaoAgenda(b));

    case 'enviarRelatorio':
      return _json(acaoEnviarRelatorio(b, u));

    case 'saidaDetalhe': {
      var idd = _cod(b.id);
      if (!idd) return _json({ ok: false, erro: 'id' });
      var sd = _buscarSaidaNaPlanilha(idd);
      if (!sd) {
        var emCache = CacheService.getScriptCache().get('WZ_S_' + idd);
        if (emCache) { try { sd = JSON.parse(emCache); } catch (e2) {} }
      }
      if (!sd) return _json({ ok: false, erro: 'naoEncontrada' });
      return _json({ ok: true, saida: sd });
    }

    case 'equipamentosEmSaida':
      return _json({ ok: true, emSaida: seriesEmSaidasAbertas() });
   =================================================================== */


/* ===================================================================
   PONTO 3 — funções novas
   Cole tudo daqui até o fim do bloco no final do seu arquivo.
   =================================================================== */

/**
 * AGENDA — lê a agenda principal da conta que publicou este script.
 * Recebe: { de: 'AAAA-MM-DD', ate: 'AAAA-MM-DD' }
 * Devolve: { ok:true, eventos:[{id, titulo, inicio, fim, local, diaInteiro}] }
 */
function acaoAgenda(dados) {
  var agenda = CalendarApp.getDefaultCalendar();
  if (!agenda) return { ok: false, erro: 'semAgenda' };

  var de  = _dataDoTexto(dados.de,  -7);
  var ate = _dataDoTexto(dados.ate,  30);
  ate.setHours(23, 59, 59, 999);   // o último dia entra inteiro

  var eventos = agenda.getEvents(de, ate).map(function (ev) {
    return {
      id:         ev.getId(),
      titulo:     ev.getTitle(),
      inicio:     ev.getStartTime().toISOString(),
      fim:        ev.getEndTime().toISOString(),
      local:      ev.getLocation() || '',
      diaInteiro: ev.isAllDayEvent()
    };
  });

  // mais próximos primeiro: é o que a pessoa procura no galpão
  eventos.sort(function (a, b) { return new Date(a.inicio) - new Date(b.inicio); });

  return { ok: true, eventos: eventos };
}

/** Aceita 'AAAA-MM-DD'. Sem isso, cai em hoje mais o número de dias indicado. */
function _dataDoTexto(texto, diasPadrao) {
  var partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || ''));
  if (partes) {
    return new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
  }
  var d = new Date();
  d.setDate(d.getDate() + (diasPadrao || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * ENVIAR RELATÓRIO — o PDF é montado no navegador, com o mesmo layout
 * de sempre, e chega aqui em base64. Aqui só remontamos e anexamos.
 * Recebe: { para, assunto, mensagem, nomeArquivo, pdf }
 */
function acaoEnviarRelatorio(dados, u) {
  var para = String(dados.para || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(para)) return { ok: false, erro: 'emailInvalido' };
  if (!dados.pdf) return { ok: false, erro: 'semAnexo' };

  // a conta tem teto diário; avisar antes é melhor do que falhar no meio
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, erro: 'cota' };

  var nome = String(dados.nomeArquivo || 'termo-de-saida.pdf');
  if (nome.slice(-4).toLowerCase() !== '.pdf') nome += '.pdf';

  var anexo;
  try {
    anexo = Utilities.newBlob(Utilities.base64Decode(dados.pdf), 'application/pdf', nome);
  } catch (err) {
    return { ok: false, erro: 'anexoInvalido' };
  }

  try {
    MailApp.sendEmail({
      to: para,
      subject: String(dados.assunto || 'Termo de saída de equipamentos — Whizz Vídeo'),
      body: String(dados.mensagem || 'Segue em anexo o termo de saída de equipamentos da Whizz Vídeo.'),
      name: 'Whizz Vídeo — Controle de Equipamentos',
      attachments: [anexo]
    });
  } catch (err) {
    return { ok: false, erro: 'falhaEnvio', detalhe: String(err).slice(0, 200) };
  }

  _log(u, 'enviar-relatorio', para + ' · ' + nome);
  return { ok: true, restam: MailApp.getRemainingDailyQuota() };
}

/**
 * EQUIPAMENTOS EM SAÍDA — quais séries estão presas a alguma saída ABERTA.
 *
 * É isto que faz o equipamento ficar vermelho no painel. Antes, o app só
 * sabia da saída aberta no próprio aparelho: se outra equipe tinha levado
 * o item, ele aparecia verde aqui e dava para levar o mesmo equipamento
 * duas vezes. Agora a verdade vem da planilha, que enxerga todas.
 *
 * Saída fechada não entra, então encerrar uma saída devolve os itens para
 * "na casa" sozinho, sem ninguém precisar marcar nada.
 *
 * Devolve: { ok:true, emSaida:[{serie, saida, projeto}] }
 */
function seriesEmSaidasAbertas() {
  var sh = _abaSaidas();
  var ultima = sh.getLastRow();
  if (ultima < 2) return [];

  var v = sh.getRange(2, 1, ultima - 1, COLS_SAIDA.length).getValues();
  var colStatus = COLS_SAIDA.indexOf('status');
  var colJson   = COLS_SAIDA.indexOf('json');

  var vistos = {};
  var lista = [];

  for (var i = 0; i < v.length; i++) {
    var id = String(v[i][0] || '').trim();
    if (!id) continue;
    if (String(v[i][colStatus] || '').trim().toLowerCase() === 'fechada') continue;

    var s;
    try { s = JSON.parse(v[i][colJson]); } catch (err) { continue; }
    if (!s || !s.items) continue;

    var projeto = (s.campos && (s.campos.projeto || s.campos.producao)) || '';
    for (var j = 0; j < s.items.length; j++) {
      var serie = String(s.items[j].serie || '').trim().toLowerCase();
      if (!serie || vistos[serie]) continue;
      vistos[serie] = true;
      lista.push({ serie: serie, saida: id, projeto: String(projeto).slice(0, 60) });
    }
  }
  return lista;
}

/**
 * CONFERÊNCIA — rode esta função uma vez pelo editor, antes de implantar.
 * Ela força o pedido de autorização da Agenda e do Gmail e mostra no log
 * se as duas estão de pé. Não envia email nenhum.
 */
function conferirAgendaEEmail() {
  var agenda = CalendarApp.getDefaultCalendar();
  Logger.log('Agenda principal: %s', agenda ? agenda.getName() : '(nenhuma)');

  var r = acaoAgenda({});
  Logger.log('Gravações nos próximos 30 dias: %s', r.eventos ? r.eventos.length : 0);
  (r.eventos || []).slice(0, 5).forEach(function (ev) {
    Logger.log('   %s — %s', ev.inicio.slice(0, 16).replace('T', ' '), ev.titulo);
  });

  Logger.log('Emails que ainda posso enviar hoje: %s', MailApp.getRemainingDailyQuota());
}


/* ===================================================================
   PONTO 4 — substituir lerHistorico
   -------------------------------------------------------------------
   Apague a lerHistorico que está lá e cole esta no lugar.

   O que muda: a coluna json já guarda a saída inteira, inclusive os
   campos da agenda. Em vez de acrescentar colunas novas na planilha,
   esta versão lê o json e tira de lá o título e a data da gravação.
   Nenhuma aba muda de formato, e as saídas antigas continuam válidas —
   simplesmente aparecem sem gravação vinculada, que é o correto.
   =================================================================== */

function lerHistorico(limite) {
  var sh = _abaSaidas();
  var ultima = sh.getLastRow();
  if (ultima < 2) return [];

  var quantas = Math.min(limite || 60, ultima - 1);
  var v = sh.getRange(ultima - quantas + 1, 1, quantas, COLS_SAIDA.length).getValues();
  var colJson = COLS_SAIDA.indexOf('json');

  var lista = [];
  for (var i = v.length - 1; i >= 0; i--) {
    if (!v[i][0]) continue;

    var linha = {
      id: String(v[i][0]), criadaEm: String(v[i][1]), fechadaEm: String(v[i][2]),
      status: String(v[i][3]), producao: String(v[i][4]), cliente: String(v[i][5]),
      projeto: String(v[i][6]), local: String(v[i][7]), responsavel: String(v[i][8]),
      dataSaida: String(v[i][9]), dataEntrada: String(v[i][10]), itens: Number(v[i][11]) || 0,
      agendaTitulo: '', agendaInicio: ''
    };

    // a gravação vinculada mora dentro do json, junto dos outros campos
    try {
      var s = JSON.parse(v[i][colJson]);
      var c = (s && s.campos) || {};
      linha.agendaTitulo = String(c.agendaTitulo || '');
      linha.agendaInicio = String(c.agendaInicio || '');
    } catch (err) { /* saída antiga ou json truncado: segue sem agenda */ }

    lista.push(linha);
  }
  return lista;
}


/* ===================================================================
   PONTO 5 — substituir invSubstituir
   -------------------------------------------------------------------
   Apague a invSubstituir que está lá e cole esta no lugar.

   O problema: o aplicativo chama invSubstituir a cada alteração no
   acervo, 1,2 segundo depois de você mexer em qualquer item. A versão
   atual cria uma aba nova "Backup_data_hora" a cada chamada, com o
   carimbo em minutos. Isso dá dois estragos:

     1. a planilha vai enchendo de abas Backup_ — uma por minuto em que
        alguém encostar no acervo;
     2. duas alterações dentro do mesmo minuto tentam criar duas abas
        com o mesmo nome. A segunda estoura, o erro sobe até o _doPost e
        volta como {ok:false, erro:'servidor'} — ou seja, a segunda
        edição rápida simplesmente não salva.

   Esta versão mantém uma única aba, "Backup_Equipamentos", sempre
   reescrita com o estado anterior à última gravação. A rede de proteção
   continua lá (dá para recuperar de um apagão acidental), sem entulhar
   a planilha e sem falhar em edições seguidas.
   =================================================================== */

function invSubstituir(u, equipamentos) {
  var antes = lerEquipamentos();

  if (antes.length) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var copia = ss.getSheetByName('Backup_Equipamentos');
      if (!copia) copia = ss.insertSheet('Backup_Equipamentos');
      copia.clear();
      copia.getRange(1, 1, 1, COLS_EQUIP.length).setValues([COLS_EQUIP]).setFontWeight('bold');
      copia.getRange(2, 1, antes.length, COLS_EQUIP.length).setValues(
        antes.map(function (e) { return [e.nome, e.serie, e.categoria, e.estado]; })
      );
      copia.getRange(1, COLS_EQUIP.length + 2).setValue(
        'Estado anterior a ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm')
      );
    } catch (err) {
      // a cópia é rede de proteção, não pode impedir a gravação em si
    }
  }

  var total = gravarEquipamentos(equipamentos);
  _log(u, 'inv-substituir', antes.length + ' → ' + total);
  return _json({ ok: true, total: total, anterior: antes.length, equipamentos: lerEquipamentos() });
}

