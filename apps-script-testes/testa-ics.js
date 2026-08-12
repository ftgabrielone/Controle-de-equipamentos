const fs = require('fs');
const path = 'G:/Controle de equipamento/Controle-de-equipamentos/apps-script/AgendaICloud.js';

// carrega o arquivo num contexto com os servicos do Google fingidos
const fonte = fs.readFileSync(path, 'utf8');
const contexto = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => '', setProperty(){}, deleteProperty(){} }) },
  UrlFetchApp: { fetch: () => { throw new Error('sem rede no teste'); } },
  Logger: { log: () => {} }
};
const nomes = Object.keys(contexto);
const fn = new Function(...nomes, fonte + '\n; return { _eventosDoICS, _dataDoICS, _desdobrarLinhas, _destextar, _normalizarUrlICS };');
const M = fn(...nomes.map(n => contexto[n]));

// ---- calendario de teste, com as armadilhas reais do formato ----
const ICS = [
'BEGIN:VCALENDAR',
'VERSION:2.0',
'PRODID:-//Apple Inc.//iCloud Calendar//EN',

// 1. dia inteiro
'BEGIN:VEVENT',
'UID:evento-dia-inteiro',
'DTSTART;VALUE=DATE:20260820',
'DTEND;VALUE=DATE:20260821',
'SUMMARY:Podcast o dia todo',
'END:VEVENT',

// 2. horario em UTC
'BEGIN:VEVENT',
'UID:evento-utc',
'DTSTART:20260812T120000Z',
'DTEND:20260812T210000Z',
'SUMMARY:Gravacao em UTC',
'LOCATION:Estudio B',
'END:VEVENT',

// 3. horario com fuso nomeado + linha dobrada + caracteres escapados
'BEGIN:VEVENT',
'UID:evento-tzid',
'DTSTART;TZID=America/Sao_Paulo:20260812T090000',
'DTEND;TZID=America/Sao_Paulo:20260812T180000',
// a RFC manda remover o CRLF E o espaco de continuacao: quem dobra a
// linha deixa o espaco ANTES da quebra, senao as palavras se juntam
'SUMMARY:Gravacao Cliente A\\, institucional\\; segunda ',
' parte do titulo que veio quebrada',
'LOCATION:Rua Ana Pereira Melo\\, 253',
'END:VEVENT',

// 4. semanal com COUNT e uma data excluida
'BEGIN:VEVENT',
'UID:evento-semanal',
'DTSTART;TZID=America/Sao_Paulo:20260813T140000',
'DTEND;TZID=America/Sao_Paulo:20260813T160000',
'RRULE:FREQ=WEEKLY;COUNT=4',
'EXDATE;TZID=America/Sao_Paulo:20260827T140000',
'SUMMARY:Podcast semanal',
'END:VEVENT',

// 5. fora da janela pedida
'BEGIN:VEVENT',
'UID:evento-antigo',
'DTSTART:20250101T120000Z',
'DTEND:20250101T130000Z',
'SUMMARY:Ano passado',
'END:VEVENT',

'END:VCALENDAR'
].join('\r\n');

const de  = new Date(2026, 7, 5);    // 05/08/2026
const ate = new Date(2026, 8, 11, 23, 59, 59);

const eventos = M._eventosDoICS(ICS, de, ate);

console.log('--- eventos lidos: ' + eventos.length + ' ---');
eventos.forEach(e => {
  const d = new Date(e.inicio);
  console.log('  ' + e.inicio.slice(0,16).replace('T',' ') +
              (e.diaInteiro ? ' [dia inteiro]' : '') +
              '  ' + e.titulo + (e.local ? '  @ ' + e.local : ''));
});

// ---- verificacoes ----
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

ok(eventos.length === 6, 'esperava 6 eventos (1 dia inteiro + 1 utc + 1 tzid + 3 do semanal), veio ' + eventos.length);
ok(!eventos.some(e => e.titulo === 'Ano passado'), 'evento fora da janela nao pode entrar');

const diaInteiro = eventos.find(e => e.titulo === 'Podcast o dia todo');
ok(diaInteiro && diaInteiro.diaInteiro === true, 'evento de dia inteiro precisa vir marcado');

const dobrado = eventos.find(e => e.titulo.indexOf('Cliente A') >= 0);
ok(dobrado, 'evento com linha dobrada nao foi lido');
ok(dobrado && dobrado.titulo.indexOf('segunda parte do titulo') >= 0, 'linha dobrada nao foi remontada: "' + (dobrado && dobrado.titulo) + '"');
ok(dobrado && dobrado.titulo.indexOf('\\,') < 0 && dobrado.titulo.indexOf('A, institucional; ') >= 0, 'escapes nao foram desfeitos: "' + (dobrado && dobrado.titulo) + '"');
ok(dobrado && dobrado.local === 'Rua Ana Pereira Melo, 253', 'local com escape errado: "' + (dobrado && dobrado.local) + '"');

const utc = eventos.find(e => e.titulo === 'Gravacao em UTC');
ok(utc && new Date(utc.inicio).getUTCHours() === 12, 'evento UTC deslocou a hora');

const semanais = eventos.filter(e => e.titulo === 'Podcast semanal');
ok(semanais.length === 3, 'semanal com COUNT=4 e 1 EXDATE deveria dar 3 na janela, deu ' + semanais.length);
const dias = semanais.map(e => e.inicio.slice(0,10));
ok(dias.indexOf('2026-08-27') < 0, 'a data em EXDATE nao pode aparecer: ' + JSON.stringify(dias));
ok(new Set(eventos.map(e => e.id)).size === eventos.length, 'ids repetidos entre ocorrencias');

// url
ok(M._normalizarUrlICS('webcal://p00-caldav.icloud.com/published/2/abc') === 'https://p00-caldav.icloud.com/published/2/abc', 'webcal:// deveria virar https://');
ok(M._normalizarUrlICS('http://exemplo.com/a.ics') === '', 'http comum deveria ser recusado');
ok(M._normalizarUrlICS('webcal://x/COLE_O_SEU_AQUI') === '', 'placeholder deveria ser recusado');

console.log('');
if (falhas.length) {
  console.log('FALHAS (' + falhas.length + '):');
  falhas.forEach(f => console.log('  x ' + f));
  process.exit(1);
} else {
  console.log('todas as verificacoes passaram');
}
