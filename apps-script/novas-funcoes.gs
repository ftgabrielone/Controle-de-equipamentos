/**
 * WHIZZ EQUIP — funções novas para o Apps Script
 *
 * Isto NÃO é o arquivo inteiro: são funções para ACRESCENTAR ao código
 * que já está publicado na sua planilha. Não apague nada do que existe.
 *
 * Cobre duas das três ações que o aplicativo passou a chamar:
 *
 *   agenda            → lista as gravações do Google Agenda
 *   enviarRelatorio   → manda o termo em PDF anexado por email
 *
 * Falta a terceira, saidaDetalhe, que devolve uma saída fechada inteira
 * para o aplicativo remontar o termo. Essa depende de como a sua planilha
 * guarda as saídas, e por isso vai ser escrita junto com você.
 *
 * DEPOIS DE COLAR: Implantar → Gerenciar implantações → editar a
 * implantação atual → Versão: Nova versão → Implantar. Sem esse passo o
 * link continua servindo o código antigo.
 *
 * Na primeira execução o Google vai pedir autorização para a Agenda e
 * para o Gmail, porque o script passou a usar serviços novos. É normal:
 * autorize com a conta da Whizz.
 */


/* ============================================================
   1. LIGAR AS AÇÕES NOVAS NO ROTEADOR
   ------------------------------------------------------------
   O seu doPost já decide o que fazer olhando o campo "acao". Ache
   esse ponto e acrescente os dois casos abaixo, no mesmo formato
   que os outros já usam. Se for um switch:

       case 'agenda':           return responder(acaoAgenda(dados));
       case 'enviarRelatorio':  return responder(acaoEnviarRelatorio(dados));

   Se for uma sequência de if:

       if (dados.acao === 'agenda')          return responder(acaoAgenda(dados));
       if (dados.acao === 'enviarRelatorio') return responder(acaoEnviarRelatorio(dados));

   Troque "responder" pelo nome que o seu código usa para devolver o
   JSON — costuma ser algo como ContentService.createTextOutput(...).

   IMPORTANTE — sessão: as duas ações recebem dados.token, igual às
   outras. Chame aqui a mesma verificação de sessão que as ações
   existentes usam, para ninguém ler a agenda nem disparar email sem
   estar logado. É a última coisa que falta e sai junto com a
   saidaDetalhe.
   ============================================================ */


/* ============================================================
   2. AGENDA
   Lê a agenda principal da conta que publicou este script.
   Recebe: { de: 'AAAA-MM-DD', ate: 'AAAA-MM-DD' }
   Devolve: { ok:true, eventos:[{id, titulo, inicio, fim, local, diaInteiro}] }
   ============================================================ */
function acaoAgenda(dados) {
  var agenda = CalendarApp.getDefaultCalendar();
  if (!agenda) return { ok: false, erro: 'semAgenda' };

  var de  = dataDoTexto(dados.de,  -7);
  var ate = dataDoTexto(dados.ate,  30);

  // o fim do intervalo entra até o último minuto do dia
  ate.setHours(23, 59, 59, 999);

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
  eventos.sort(function (a, b) {
    return new Date(a.inicio) - new Date(b.inicio);
  });

  return { ok: true, eventos: eventos };
}

// aceita 'AAAA-MM-DD'; sem isso, cai em hoje mais o número de dias indicado
function dataDoTexto(texto, diasPadrao) {
  var partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || ''));
  if (partes) {
    return new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
  }
  var d = new Date();
  d.setDate(d.getDate() + (diasPadrao || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}


/* ============================================================
   3. ENVIAR O RELATÓRIO POR EMAIL
   O PDF é montado no navegador, com o mesmo layout de sempre, e
   chega aqui em base64. Este trecho só o remonta e anexa.
   Recebe: { para, assunto, mensagem, nomeArquivo, pdf }
   Devolve: { ok:true } ou { ok:false, erro:'...' }
   ============================================================ */
function acaoEnviarRelatorio(dados) {
  var para = String(dados.para || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(para)) {
    return { ok: false, erro: 'emailInvalido' };
  }
  if (!dados.pdf) {
    return { ok: false, erro: 'semAnexo' };
  }

  // a conta tem um teto diário; avisar antes é melhor do que falhar no meio
  var sobrando = MailApp.getRemainingDailyQuota();
  if (sobrando < 1) {
    return { ok: false, erro: 'cota' };
  }

  var nome = String(dados.nomeArquivo || 'termo-de-saida.pdf');
  if (nome.slice(-4).toLowerCase() !== '.pdf') nome += '.pdf';

  var anexo;
  try {
    anexo = Utilities.newBlob(Utilities.base64Decode(dados.pdf), 'application/pdf', nome);
  } catch (e) {
    return { ok: false, erro: 'anexoInvalido' };
  }

  var assunto  = String(dados.assunto || 'Termo de saída de equipamentos — Whizz Vídeo');
  var mensagem = String(dados.mensagem || 'Segue em anexo o termo de saída de equipamentos da Whizz Vídeo.');

  try {
    MailApp.sendEmail({
      to: para,
      subject: assunto,
      body: mensagem,
      name: 'Whizz Vídeo — Controle de Equipamentos',
      attachments: [anexo]
    });
  } catch (e) {
    return { ok: false, erro: 'falhaEnvio', detalhe: String(e) };
  }

  return { ok: true, restam: MailApp.getRemainingDailyQuota() };
}


/* ============================================================
   4. CONFERÊNCIA RÁPIDA
   Rode esta função uma vez pelo editor do Apps Script, antes de
   implantar. Ela força o pedido de autorização e mostra no registro
   se a agenda e o email estão de pé. Não envia nada.
   ============================================================ */
function conferirAgendaEEmail() {
  var agenda = CalendarApp.getDefaultCalendar();
  Logger.log('Agenda principal: %s', agenda ? agenda.getName() : '(nenhuma)');

  var r = acaoAgenda({});
  Logger.log('Eventos nos próximos 30 dias: %s', r.eventos ? r.eventos.length : 0);
  (r.eventos || []).slice(0, 5).forEach(function (ev) {
    Logger.log('  · %s — %s', ev.inicio, ev.titulo);
  });

  Logger.log('Emails que ainda posso enviar hoje: %s', MailApp.getRemainingDailyQuota());
}
