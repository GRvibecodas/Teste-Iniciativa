/*
 * EJ DATA KIT — módulo reutilizável de dados, consentimento e conversão.
 * ------------------------------------------------------------------------
 * Pensado pra ser colado em QUALQUER site que a EJ entregue — seja um site
 * institucional pra uma PME, seja um site de venda direta como este. A regra
 * é: a LÓGICA vive aqui (uma vez só); o que muda de cliente pra cliente é
 * só o objeto de configuração (window.EJ_CONFIG) declarado no HTML antes
 * deste arquivo ser carregado.
 *
 * Uso mínimo num novo projeto:
 *   <script>
 *     window.EJ_CONFIG = {
 *       project: 'nome-do-cliente',      // identifica o projeto no hub de leads
 *       webhookUrl: '',                  // Zapier/Make/n8n — opcional
 *       whatsapp: { phone: '5511999999999', message: 'Olá! Vim do site.' }
 *     };
 *   </script>
 *   <script src="assets/ej-data-kit.js"></script>
 *
 * Isso já entrega: consentimento LGPD, captura de UTM/indicação, eventos de
 * pixel padronizados e um método único pra salvar lead (db real quando
 * publicado como Artifact, localStorage como fallback local).
 */
(function(){
  var cfg = window.EJ_CONFIG || {};
  var PROJECT = cfg.project || 'sem-nome';
  var WEBHOOK_URL = cfg.webhookUrl || '';
  var STORAGE_PREFIX = 'ej_' + PROJECT + '_';

  var EJ = window.EJKit = { project: PROJECT };

  /* ── Consentimento (LGPD) ───────────────────────────────────────────
     Enquanto o visitante não decidir, nenhum evento de marketing dispara
     e nenhum dado de aquisição (UTM/indicação) é salvo — só a reserva/lead
     que a própria pessoa preenche voluntariamente, que é dado necessário
     pra cumprir o pedido, segue independente de consentimento. */
  EJ.getConsent = function(){
    try{ return localStorage.getItem(STORAGE_PREFIX + 'consent'); }catch(e){ return null; }
  };
  EJ.setConsent = function(value){
    try{ localStorage.setItem(STORAGE_PREFIX + 'consent', value); }catch(e){}
  };
  EJ.hasMarketingConsent = function(){ return EJ.getConsent() === 'accepted'; };

  /* ── Aquisição: UTM + indicação (?ref=) ─────────────────────────────
     Generaliza tanto campanha paga (UTM) quanto indicação boca-a-boca
     (?ref=codigo) — o mesmo mecanismo serve pra um e-commerce de produto
     ou pra um site institucional captando inscrição/orçamento. */
  function captureAcquisition(){
    if(!EJ.hasMarketingConsent()) return;
    var params = new URLSearchParams(window.location.search);
    var keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref'];
    var found = {};
    var hasAny = false;
    keys.forEach(function(k){
      var v = params.get(k);
      if(v){ found[k] = v; hasAny = true; }
    });
    if(hasAny){
      found._capturadoEm = Date.now();
      try{ localStorage.setItem(STORAGE_PREFIX + 'acquisition', JSON.stringify(found)); }catch(e){}
    }
  }
  EJ.getAcquisition = function(){
    try{
      var raw = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'acquisition') || 'null');
      if(raw && (Date.now() - raw._capturadoEm) < 30*24*60*60*1000){
        var out = {}; for(var k in raw){ if(k !== '_capturadoEm') out[k] = raw[k]; }
        return out;
      }
    }catch(e){}
    return {};
  };

  /* ── Eventos de pixel (Meta/GA4) — padronizados entre projetos ───── */
  EJ.track = function(fbEventName, gaEventName, params){
    if(!EJ.hasMarketingConsent()) return;
    try{ if(typeof fbq === 'function') fbq('track', fbEventName, params); }catch(e){}
    try{ if(typeof gtag === 'function') gtag('event', gaEventName, params); }catch(e){}
  };

  /* ── Banco de dados unificado (hub de leads) ──────────────────────
     Todo lead sai marcado com o projeto de origem — é isso que permite,
     no futuro, um único hub central receber leads de vários sites da EJ
     e ainda saber separar/agregar por cliente. */
  async function getDB(){
    try{
      if(window.claude && typeof window.claude.use === 'function'){
        return await window.claude.use('db');
      }
    }catch(e){}
    return null;
  }
  function saveLocally(lead){
    try{
      var key = STORAGE_PREFIX + 'leads';
      var all = JSON.parse(localStorage.getItem(key) || '[]');
      all.push(lead);
      localStorage.setItem(key, JSON.stringify(all));
    }catch(e){}
  }
  function sendWebhook(lead){
    if(!WEBHOOK_URL) return;
    fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(lead)
    }).catch(function(){ /* nunca bloqueia a experiência por causa do webhook */ });
  }
  EJ.saveLead = async function(partialLead){
    var ref = partialLead.ref || (PROJECT.slice(0,3).toUpperCase() + '-' + Date.now().toString(36).toUpperCase());
    var lead = Object.assign(
      {ref: ref, projeto: PROJECT, criadoEm: new Date().toISOString(), origem: document.referrer || 'direto'},
      EJ.getAcquisition(),
      partialLead
    );
    try{
      var db = await getDB();
      if(db){ await db.doc('leads/' + ref).set(lead); }
      else{ saveLocally(lead); }
    }catch(e){ saveLocally(lead); }
    sendWebhook(lead);
    return lead;
  };

  /* ── Leitura agregada — alimenta o painel de relatório (dashboard.html).
     Filtra por `projeto` no cliente: hoje cada artifact tem seu próprio
     banco, mas se um dia existir um hub central compartilhado entre vários
     sites da EJ, essa mesma função já separa os dados de cada cliente. */
  EJ.getAllLeads = async function(){
    try{
      var db = await getDB();
      if(db){
        var snap = await db.collection('leads').orderBy('criadoEm', 'desc').limit(500).get();
        return snap.docs.map(function(d){ return d.data(); }).filter(function(l){ return l.projeto === PROJECT; });
      }
    }catch(e){}
    try{
      var all = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'leads') || '[]');
      return all.slice().reverse();
    }catch(e){ return []; }
  };

  /* ── Indicação: link único pra quem já converteu ───────────────── */
  EJ.referralLink = function(ref){
    var url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('ref', ref);
    return url.toString();
  };

  captureAcquisition();

  /* Reage a uma mudança de consentimento feita depois do carregamento
     (ex.: o visitante aceita no banner alguns segundos após a página abrir). */
  EJ.onConsentGranted = function(){ captureAcquisition(); };
})();
