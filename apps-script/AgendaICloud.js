/**
 * WHIZZ EQUIP — leitura da agenda do iCloud
 * =========================================
 *
 * A Apple não tem API pública de calendário. O acesso oficial é CalDAV,
 * que exige os métodos PROPFIND e REPORT — e o UrlFetchApp do Apps Script
 * só faz get, delete, patch, post e put. Por isso CalDAV está fora.
 *
 * O que funciona é o calendário publicado: o iCloud entrega um .ics por
 * HTTPS comum. Um GET resolve, sem senha nem credencial guardada.
 *
 * Como ligar (uma vez):
 *   1. No Mac, app Calendário: clique com o botão direito no calendário
 *      → Compartilhar Calendário → marque "Calendário Público".
 *      No iPhone: Calendários → (i) ao lado do calendário → Calendário
 *      Público.
 *   2. Copie o endereço webcal://…
 *   3. Cole na função definirAgendaICloud() abaixo e execute uma vez.
 *
 * Para desligar, execute removerAgendaICloud().
 */

var PROP_ICLOUD = 'WZ_ICLOUD_URL';

/* ===================================================================
   CONFIGURAÇÃO
   =================================================================== */

function definirAgendaICloud() {

  var URL = 'webcal://p00-caldav.icloud.com/published/2/COLE_O_SEU_AQUI';

  var limpa = _normalizarUrlICS(URL);
  if (!limpa) {
    Logger.log('Endereço inválido. Ele precisa ser o webcal:// ou https:// do calendário publicado.');
    return;
  }

  // só grava depois de provar que responde e que é mesmo um .ics
  var teste = _baixarICS(limpa);
  if (!teste.ok) {
    Logger.log('Não consegui ler esse endereço: %s', teste.erro);
    return;
  }

  PropertiesService.getScriptProperties().setProperty(PROP_ICLOUD, limpa);

  var eventos = _eventosDoICS(teste.texto, _dataDoTexto(null, -7), _dataDoTexto(null, 30));
  Logger.log('Agenda do iCloud ligada.');
  Logger.log('Gravações encontradas na janela de 7 dias atrás a 30 à frente: %s', eventos.length);
  eventos.slice(0, 8).forEach(function (ev) {
    Logger.log('   %s — %s', ev.inicio.slice(0, 16).replace('T', ' '), ev.titulo);
  });
}

function removerAgendaICloud() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_ICLOUD);
  Logger.log('Agenda do iCloud desligada. Volta a valer só a agenda do Google.');
}

function _urlICloud() {
  return PropertiesService.getScriptProperties().getProperty(PROP_ICLOUD) || '';
}

function _normalizarUrlICS(url) {
  var u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(u)) return '';
  if (/COLE_O_SEU_AQUI/.test(u)) return '';
  return u;
}

function _baixarICS(url) {
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var codigo = r.getResponseCode();
    if (codigo !== 200) return { ok: false, erro: 'HTTP ' + codigo };
    var texto = r.getContentText();
    if (texto.indexOf('BEGIN:VCALENDAR') < 0) {
      return { ok: false, erro: 'a resposta não é um calendário .ics' };
    }
    return { ok: true, texto: texto };
  } catch (err) {
    return { ok: false, erro: String(err).slice(0, 160) };
  }
}

/* ===================================================================
   LEITURA DO .ICS
   O formato é linha a linha, mas com duas armadilhas: linhas longas
   vêm quebradas e continuadas com espaço, e a data aparece em três
   formatos diferentes. As duas coisas são tratadas aqui.
   =================================================================== */

function _desdobrarLinhas(texto) {
  // RFC 5545: continuação de linha começa com espaço ou tab
  return String(texto).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function _destextar(v) {
  return String(v || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Converte a data do ICS para Date.
 * Três formatos aparecem na prática:
 *   DTSTART;VALUE=DATE:20260812                  → dia inteiro
 *   DTSTART:20260812T120000Z                     → UTC
 *   DTSTART;TZID=America/Sao_Paulo:20260812T090000 → hora local
 * Sem biblioteca de fuso, a forma com TZID é lida como hora local do
 * script — que é o mesmo fuso da Whizz, então bate.
 */
function _dataDoICS(parametros, valor) {
  var v = String(valor || '').trim();
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;

  var ano = Number(m[1]), mes = Number(m[2]) - 1, dia = Number(m[3]);
  var h = Number(m[4] || 0), min = Number(m[5] || 0), seg = Number(m[6] || 0);

  var ehDiaInteiro = !m[4] || /VALUE=DATE(?!-TIME)/i.test(parametros || '');
  if (ehDiaInteiro) return { data: new Date(ano, mes, dia, 0, 0, 0), diaInteiro: true };

  if (m[7] === 'Z') return { data: new Date(Date.UTC(ano, mes, dia, h, min, seg)), diaInteiro: false };
  return { data: new Date(ano, mes, dia, h, min, seg), diaInteiro: false };
}

/** Repetição: cobre o que aparece de verdade numa agenda de produtora. */
function _expandirRepeticao(rrule, inicio, fim, limiteInicio, limiteFim, exclusoes) {
  var ocorrencias = [];
  var regras = {};
  String(rrule).split(';').forEach(function (par) {
    var p = par.split('=');
    if (p.length === 2) regras[p[0].toUpperCase()] = p[1].toUpperCase();
  });

  var freq = regras.FREQ;
  if (!freq) return ocorrencias;

  var intervalo = Math.max(1, Number(regras.INTERVAL || 1));
  var conta = regras.COUNT ? Number(regras.COUNT) : 0;
  var ate = null;
  if (regras.UNTIL) {
    var u = _dataDoICS('', regras.UNTIL);
    if (u) ate = u.data;
  }

  var duracao = fim.getTime() - inicio.getTime();
  var atual = new Date(inicio.getTime());
  var geradas = 0;
  var teto = 400;   // trava de segurança contra regra infinita

  while (teto-- > 0) {
    if (ate && atual.getTime() > ate.getTime()) break;
    if (conta && geradas >= conta) break;

    if (atual.getTime() >= limiteInicio.getTime() && atual.getTime() <= limiteFim.getTime()) {
      var chave = _chaveDoDia(atual);
      if (exclusoes.indexOf(chave) < 0) {
        ocorrencias.push({ inicio: new Date(atual.getTime()), fim: new Date(atual.getTime() + duracao) });
      }
    }
    geradas++;
    if (atual.getTime() > limiteFim.getTime()) break;

    if (freq === 'DAILY')        atual.setDate(atual.getDate() + intervalo);
    else if (freq === 'WEEKLY')  atual.setDate(atual.getDate() + 7 * intervalo);
    else if (freq === 'MONTHLY') atual.setMonth(atual.getMonth() + intervalo);
    else if (freq === 'YEARLY')  atual.setFullYear(atual.getFullYear() + intervalo);
    else break;
  }
  return ocorrencias;
}

function _chaveDoDia(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/**
 * Devolve os eventos do .ics dentro da janela pedida, já no mesmo
 * formato que o app espera da agenda do Google.
 */
function _eventosDoICS(texto, de, ate) {
  var linhas = _desdobrarLinhas(texto).split('\n');
  var eventos = [];
  var atual = null;

  for (var i = 0; i < linhas.length; i++) {
    var linha = linhas[i];

    if (linha.indexOf('BEGIN:VEVENT') === 0) { atual = { exdate: [] }; continue; }

    if (linha.indexOf('END:VEVENT') === 0) {
      if (atual && atual.inicio) _acumularEvento(eventos, atual, de, ate);
      atual = null;
      continue;
    }
    if (!atual) continue;

    var corte = linha.indexOf(':');
    if (corte < 0) continue;
    var cabeca = linha.slice(0, corte);
    var valor  = linha.slice(corte + 1);
    var nome   = cabeca.split(';')[0].toUpperCase();
    var params = cabeca.slice(nome.length);

    if (nome === 'SUMMARY')       atual.titulo = _destextar(valor);
    else if (nome === 'LOCATION') atual.local = _destextar(valor);
    else if (nome === 'UID')      atual.uid = String(valor).trim();
    else if (nome === 'RRULE')    atual.rrule = String(valor).trim();
    else if (nome === 'DTSTART')  { var a = _dataDoICS(params, valor); if (a) { atual.inicio = a.data; atual.diaInteiro = a.diaInteiro; } }
    else if (nome === 'DTEND')    { var b = _dataDoICS(params, valor); if (b) atual.fim = b.data; }
    else if (nome === 'EXDATE')   {
      String(valor).split(',').forEach(function (parte) {
        var x = _dataDoICS(params, parte.trim());
        if (x) atual.exdate.push(_chaveDoDia(x.data));
      });
    }
  }

  eventos.sort(function (x, y) { return new Date(x.inicio) - new Date(y.inicio); });
  return eventos;
}

function _acumularEvento(eventos, ev, de, ate) {
  var fim = ev.fim || new Date(ev.inicio.getTime() + 3600000);
  var titulo = ev.titulo || '(sem título)';
  var uid = ev.uid || (titulo + ev.inicio.getTime());

  function empilhar(inicio, termino, sufixo) {
    eventos.push({
      id:         'icloud:' + uid + (sufixo || ''),
      titulo:     titulo,
      inicio:     inicio.toISOString(),
      fim:        termino.toISOString(),
      local:      ev.local || '',
      diaInteiro: !!ev.diaInteiro,
      origem:     'iCloud'
    });
  }

  if (ev.rrule) {
    var repeticoes = _expandirRepeticao(ev.rrule, ev.inicio, fim, de, ate, ev.exdate);
    for (var i = 0; i < repeticoes.length; i++) {
      empilhar(repeticoes[i].inicio, repeticoes[i].fim, ':' + _chaveDoDia(repeticoes[i].inicio));
    }
    return;
  }

  if (ev.inicio.getTime() >= de.getTime() && ev.inicio.getTime() <= ate.getTime()) {
    empilhar(ev.inicio, fim, '');
  }
}

/* ===================================================================
   ENTRADA USADA PELO APP
   Junta o que houver: agenda do Google e agenda do iCloud.
   =================================================================== */

function eventosDoICloud(de, ate) {
  var url = _urlICloud();
  if (!url) return [];
  var r = _baixarICS(url);
  if (!r.ok) return [];
  try {
    return _eventosDoICS(r.texto, de, ate);
  } catch (err) {
    return [];
  }
}
