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
