/* EditalVector — fluxo principal desta versão:
 * empresa → linha de fornecimento → habilitação → oportunidades e PCA direcionados → licitações de interesse → viabilidade.
 * Usa os auxiliares do index.html ($, esc, brl, dt, dias, sb, main, ir, V, cardLic, abaSel, toast...).
 */
'use strict';
const NIVEL={grupo:'Grupo',classe:'Classe',pdm:'PDM (padrão descritivo)',item:'Item',secao:'Seção',divisao:'Divisão',subclasse:'Subclasse',servico:'Serviço'};
const TIPO_CAT={M:'Material',S:'Serviço'};
const ORIGEM_LF={manual:'Declarada por você',ia:'Sugerida pela IA e confirmada por você',sicaf_declarado:'Copiada do SICAF por você — não verificada pelo sistema',historico_pncp:'Encontrada automaticamente no histórico público do CNPJ (atas de registro de preços) — não é validação do SICAF',cnae_fornecedores:'Sugerida pelo que fornecedores reais do mesmo CNAE venderam e confirmada por você'};
const CONF_LF={alta:['c-green','Confiança alta'],media:['c-amber','Confiança média'],baixa:['c-mut','Confiança baixa']};
const SIT_LF={ativo:['c-green','✓','Ativa no catálogo'],inativo:['c-amber','!','Inativa no catálogo oficial'],a_conferir:['c-amber','?','Item ainda não conferido no catálogo'],nao_encontrado:['c-red','!','Não encontrada no catálogo oficial']};
window.ST_INT={a_analisar:'A analisar',em_analise:'Em análise',viavel:'Viável',inviavel:'Inviável',arquivada:'Arquivada'};
const ST_INT_COR={a_analisar:'c-mut',em_analise:'c-blue',viavel:'c-green',inviavel:'c-red',arquivada:'c-mut'};
const fmtN=(v,d=0)=>v==null||isNaN(v)?'—':Number(v).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const pctFmt=v=>v==null||isNaN(v)?'—':Number(v).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
const brlc=v=>v==null||isNaN(v)?'—':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const rpc=async(f,a)=>{const {data,error}=await sb.rpc(f,a||{});if(error)throw error;return data;};
const pend=(t,acao,txt)=>`<div class="ev-pend" role="status"><div><b>${t}</b>${txt?`<span>${txt}</span>`:''}</div>${acao||''}</div>`;

// ------------------------------------------------------------------ "Analisar viabilidade" (salva o interesse e abre)
async function analisarViab(opId,btn){
 if(btn){btn.disabled=true;btn.textContent='Abrindo…';}
 try{const id=await rpc('analisar_viabilidade',{p_oportunidade:Number(opId)});ir('analise',{id});}
 catch(e){if(btn){btn.disabled=false;btn.textContent='Analisar viabilidade';}toast(e.message);}
}
async function marcarInteresse(opId){try{await rpc('marcar_interesse',{p_oportunidade:Number(opId)});toast('Salva em Licitações de interesse','Abrir',()=>ir('interesses'));}catch(e){toast(e.message);}}

// ------------------------------------------------------------------ início
// A empresa é opcional: perfis de busca funcionam sozinhos; com empresa e linha de fornecimento a busca automática por classe/grupo se soma a eles.
/* ---- UF e município automáticos: lista oficial do IBGE (servicodados.ibge.gov.br), guardada no aparelho por 30 dias ---- */
const IBGE_UF={AC:'Acre',AL:'Alagoas',AM:'Amazonas',AP:'Amapá',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',ES:'Espírito Santo',GO:'Goiás',MA:'Maranhão',MG:'Minas Gerais',MS:'Mato Grosso do Sul',MT:'Mato Grosso',PA:'Pará',PB:'Paraíba',PE:'Pernambuco',PI:'Piauí',PR:'Paraná',RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',RO:'Rondônia',RR:'Roraima',RS:'Rio Grande do Sul',SC:'Santa Catarina',SE:'Sergipe',SP:'São Paulo',TO:'Tocantins'};
const IBGE_MEM={};
async function ibgeMun(uf){
 if(!uf)return[];if(IBGE_MEM[uf])return IBGE_MEM[uf];
 try{const c=JSON.parse(localStorage.getItem('ibge:'+uf)||'null');if(c&&Date.now()-c.t<2592e6&&c.l&&c.l.length){return IBGE_MEM[uf]=c.l;}}catch(e){}
 try{const r=await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/estados/'+encodeURIComponent(uf)+'/municipios?view=nivelado&orderBy=nome');if(!r.ok)throw 0;
  const l=(await r.json()).map(x=>x['municipio-nome']||x.nome).filter(Boolean);if(!l.length)throw 0;
  IBGE_MEM[uf]=l;try{localStorage.setItem('ibge:'+uf,JSON.stringify({t:Date.now(),l}));}catch(e){}return l;}catch(e){return[];}
}
function ufSelect(id,atual,onch,todas){return `<select id="${id}" ${onch?`onchange="${onch}"`:''}><option value="">${todas||'Selecione a UF'}</option>${UFS.map(u=>`<option value="${u}" ${u===atual?'selected':''}>${u} · ${IBGE_UF[u]||''}</option>`).join('')}</select>`;}
function munSelect(id,uf,atual,onch){return `<select id="${id}" data-mun data-uf="${esc(uf||'')}" data-atual="${esc(atual||'')}" ${onch?`onchange="${onch}"`:''}><option value="">${uf?'Carregando municípios…':'Selecione a UF primeiro'}</option></select>`;}
async function munPreencher(sel){
 const uf=sel.dataset.uf||'',atual=sel.dataset.atual||'';sel.dataset.ok=uf+'|'+atual;
 if(!uf){sel.innerHTML='<option value="">Selecione a UF primeiro</option>';sel.disabled=true;return;}
 sel.disabled=false;const l=await ibgeMun(uf);if((sel.dataset.uf||'')!==uf)return;
 if(!l.length){sel.innerHTML=`<option value="${esc(atual)}">${esc(atual||'Não foi possível carregar a lista (IBGE)')}</option>`;return;}
 const ach=l.find(x=>x.toLowerCase()===atual.toLowerCase())||'';const lista=atual&&!ach?[atual,...l]:l;
 sel.innerHTML='<option value="">Selecione o município</option>'+lista.map(m=>`<option value="${esc(m)}" ${m===(ach||atual)?'selected':''}>${esc(m)}</option>`).join('');
}
function munAuto(){document.querySelectorAll('select[data-mun]').forEach(s=>{if(s.dataset.ok!==(s.dataset.uf||'')+'|'+(s.dataset.atual||''))munPreencher(s);});}
// quando a UF muda, a lista de municípios é trocada na hora
function ufMud(ufSel,munId,atual){const m=document.getElementById(munId);if(!m)return;m.dataset.uf=ufSel.value;m.dataset.atual=atual||'';munPreencher(m);}
new MutationObserver(()=>munAuto()).observe(document.documentElement,{childList:true,subtree:true});

V.home=async()=>{
 const q=x=>Promise.resolve(x).catch(()=>({data:null}));
 const [R,pjR,intR,D,temPerfil,BRr,topR]=await Promise.all([rpc('resumo_linha').catch(()=>null),
  q(sb.from('pessoas_juridicas').select('id,cnpj,razao_social,uf').order('propria',{ascending:false}).limit(1)),
  q(sb.rpc('listar_interesses',{p_status:null})),q(sb.rpc('dashboard_resumo')).then(r=>r.data||{}),temPerfilBusca(),
  q(sb.from('briefings').select('*,perfis_busca(nome,ativo)').order('gerado_em',{ascending:false}).limit(60)),
  q(sb.from('radar').select('id,score,status,justificativa,perfis_busca(nome),oportunidades!inner(id,objeto,orgao_nome,municipio,uf,modalidade,srp,valor_estimado,valor_sigiloso,data_fim_proposta,link_pncp,ia_resumo,ia_categoria,ia_atencao,ia_tipo,ia_termo,ia_catalogo_codigo,ia_catalogo_nome)').gte('oportunidades.data_fim_proposta',new Date().toISOString()).neq('status','descartado').order('score',{ascending:false}).limit(5))]);
 const pj=(pjR.data||[])[0],ints=intR.data||[],r=R||{},linhaOk=(r.linhas_incluir||0)>0;
 const vb=new Set(),brs=(BRr.data||[]).filter(b=>b.perfis_busca&&b.perfis_busca.ativo&&!vb.has(b.perfil_id)&&vb.add(b.perfil_id)).slice(0,3),top=topR.data||[];
 const bid=[...new Set(brs.flatMap(b=>(b.destaques||[]).map(d=>d.id)))],bop=bid.length?Object.fromEntries(((await sb.from('oportunidades').select('id,objeto,uf').in('id',bid)).data||[]).map(o=>[o.id,o])):{};
 const ago=iso=>{const m=Math.max(0,Math.round((Date.now()-new Date(iso))/6e4));return m<60?m+' min':m<1440?Math.round(m/60)+' h':Math.round(m/1440)+' d';};
 const kp=(v,l,s,go)=>`<button class="ev-kpi" onclick="${go}"><b>${v}</b><span>${l}</span><small>${s}</small></button>`;
 const avisoEmpresa=linhaOk?'':`<div class="card ev-next"><span class="ev-next-k">Automatize as buscas</span><h3>Cadastre sua empresa</h3><p>Informe o CNPJ e o sistema busca os dados públicos e sugere a linha de fornecimento (classes e grupos do catálogo) pelo que a empresa já vendeu ao governo. Com isso, licitações e compras planejadas (PCA) passam a ser buscadas automaticamente pela classe/grupo. <b>É opcional:</b> você pode pesquisar só com perfis de busca.</p><button onclick="ir('empresa',{aba:'linha'})">Cadastrar Empresa e Linha de Fornecimento</button></div>`;
 const blocoEmpresa=linhaOk?`<div class="card"><h3>Busca automática pela linha de fornecimento${pj&&pj.razao_social?' · '+esc(pj.razao_social):''}</h3><p class="sub">Classes e grupos da empresa cruzados com licitações abertas e com o PCA. ${temPerfil?'Os perfis de busca continuam valendo em paralelo.':'Você também pode criar perfis de busca para refinar.'}</p>
  <div class="ev-kpis">${kp(fmtN(r.lic_confirmadas),'Licitações na sua linha','código ou classificação confirmados',"ir('oport',{conf:'confirmada'})")}${kp(fmtN(r.lic_revisar),'Possíveis, para revisar','pela descrição',"ir('oport',{conf:'revisar'})")}${kp(fmtN(r.pca_confirmadas),'Compras planejadas (PCA)','planejamento, não é licitação aberta',"ir('pca')")}${kp(fmtN(ints.length),'Licitações de interesse',ints.filter(x=>x.status==='em_analise').length+' em análise',"ir('interesses')")}</div>
  <p class="ev-hint">Itens lidos em ${fmtN(r.abertas_com_itens)} de ${fmtN(r.abertas)} licitações abertas; a leitura avança a cada coleta. Última coleta: ${r.ultima_coleta?dt(r.ultima_coleta):'—'}.</p></div>`:'';
 const briefing=!temPerfil?avisoPerfilBusca(pode('perfis')):(brs.length?brs.map(b=>`<div class="card brief"><h3>${AI('Briefing gerado por IA (Gemini)')}${esc(b.titulo||'Briefing')} <span class="m">· ${esc(b.perfis_busca&&b.perfis_busca.nome||'')} · há ${ago(b.gerado_em)}</span></h3><p style="margin:6px 0 8px;line-height:1.5">${esc(b.resumo||'')}</p>${(b.destaques||[]).map(d=>`<div class="br" style="grid-template-columns:1fr"><span class="bl" style="cursor:pointer" onclick="ir('triagem')"><b>${esc(((bop[d.id]||{}).objeto||'#'+d.id).slice(0,90))}</b> <span class="m">${esc((bop[d.id]||{}).uf||'')} — ${esc(d.motivo||'')}</span></span></div>`).join('')}${(b.alertas||[]).length?`<div style="margin-top:6px">${b.alertas.map(a=>`<span class="tag w">${esc(a)}</span>`).join(' ')}</div>`:''}</div>`).join(''):`<div class="card"><h3>Briefing</h3><p class="sub">Seus perfis de busca estão salvos. O briefing é gerado a cada coleta completa; o primeiro aparece aqui assim que for gerado.</p></div>`);
 main.innerHTML=bannerPlano()+`<div class="top"><div><h2>${pj&&pj.razao_social?esc(pj.razao_social):'Início'}</h2><p class="sub">Pesquise por perfis de busca${linhaOk?' e pela linha de fornecimento da empresa':''}; a empresa é opcional.</p></div></div>
 <div class="ev-kpis">${kp(fmtN(D.abertos),'Editais abertos','no PNCP agora',"ir('oportunidades')")}${kp(fmtN(D.abertos7),'Encerram em 7 dias','editais abertos',"ir('oportunidades')")}${kp(fmtN(D.pca),'Itens de PCA','previsão de compras',"ir('pca')")}${temPerfil?kp(fmtN(D.radar),'No radar',fmtN(D.radar_novo)+' novos',"ir('triagem')"):''}</div>
 ${avisoEmpresa}${briefing}${blocoEmpresa}
 ${temPerfil&&top.length?`<div class="card"><h3>Melhores oportunidades dos seus perfis</h3>${top.map(x=>cardOp(x.oportunidades,{score:x.score,perfil:x.perfis_busca&&x.perfis_busca.nome,just:x.justificativa})).join('')}</div>`:''}`;
};
async function habResumo(pjId){
 const [{data:cat},{data:he},{data:docs}]=await Promise.all([sb.from('hab_catalogo').select('codigo,naturezas,obrigatorio,validade_dias'),sb.from('hab_empresas').select('natureza').eq('pessoa_juridica_id',pjId).maybeSingle(),sb.from('hab_documentos').select('codigo,valido_ate,criado_em').eq('pessoa_juridica_id',pjId).order('criado_em',{ascending:false})]);
 const nat=(he&&he.natureza)||'ltda',ult={};(docs||[]).forEach(d=>{if(!ult[d.codigo])ult[d.codigo]=d;});
 const hoje=new Date().toISOString().slice(0,10);
 const obr=(cat||[]).filter(c=>c.obrigatorio&&c.naturezas.includes(nat));
 return {obrig:obr.length,ok:obr.filter(c=>ult[c.codigo]&&(!ult[c.codigo].valido_ate||ult[c.codigo].valido_ate>=hoje)).length};
}

// ------------------------------------------------------------------ empresa + linha de fornecimento
TELAS.empresa='Empresa e linha de fornecimento';
V.empresa=async()=>{
 const [{data:pjs},linhas,R]=await Promise.all([sb.from('pessoas_juridicas').select('*').order('propria',{ascending:false}).limit(1),rpc('minha_linha').catch(()=>[]),rpc('resumo_linha').catch(()=>null)]);
 const pj=(pjs||[])[0];window.__EMP={pj,linhas:linhas||[],R};
 const aba=abaIni('emp',(window.ARG&&window.ARG.aba)||((linhas||[]).length?'linha':(pj&&pj.uf?'linha':'dados')),['dados','linha']);
 const inc=(linhas||[]).filter(l=>l.modo==='incluir'),exc=(linhas||[]).filter(l=>l.modo==='excluir');
 main.innerHTML=`<div class="top"><div><h2>Empresa</h2><p class="sub">Comece pelo que a empresa fornece. Você pode salvar e continuar depois.</p></div><div id="lfst" class="ev-hint"></div></div>
 <div class="ev-root">
 <div class="ev-tabs" data-g="emp" data-mem="emp" role="tablist">
  <button type="button" class="${aba==='linha'?'on':''}" data-t="linha" onclick="abaSel(this)">Linha de fornecimento<span class="n ${inc.length?'c-green':'c-red'}">${inc.length||'!'}</span></button>
  <button type="button" class="${aba==='dados'?'on':''}" data-t="dados" onclick="abaSel(this)">Dados da empresa</button></div>
 <div class="ev-pane" data-g="emp" data-t="linha" ${aba==='linha'?'':'hidden'}>
  <div id="lfauto"></div><div id="lfcnae"></div>
  <div class="card ev-destaque"><h3>Informe o que sua empresa fornece para encontrar licitações e compras planejadas compatíveis.</h3>
   <p class="sub">Escolha as classificações oficiais do Catálogo do Compras.gov.br (CATMAT para materiais, CATSER para serviços). Uma classe abrangente não significa que você fornece tudo dentro dela: refine com PDMs, itens ou serviços específicos, ou marque o que <b>não</b> fornece.</p>
   <p class="ev-hint"><b>A classe (material) e o grupo (serviço) são a chave</b> que liga a linha da empresa ao PCA e às licitações. Escolha classes ou grupos inteiros e refine com PDM ou item quando precisar.</p>
   ${linhas&&linhas.length?lfLista(inc,exc):pend('Nenhuma linha cadastrada ainda','',"Sem a linha, o sistema não tem como direcionar oportunidades: a pesquisa ampla continua disponível em Licitações.")}
  </div>
  <div class="card"><h3>Adicionar à linha</h3>
   <div class="ev-tabs sm" data-g="lfadd" role="tablist"><button type="button" class="on" data-t="busca" onclick="abaSel(this)">Pesquisar</button><button type="button" data-t="nav" onclick="abaSel(this);lfNav('M')">Por grupo / classe</button><button type="button" data-t="ia" onclick="abaSel(this)">Sugestões da IA</button><button type="button" data-t="sicaf" onclick="abaSel(this)">Tenho as linhas do SICAF</button></div>
   <div class="ev-pane" data-g="lfadd" data-t="busca"><div class="bar"><input id="lfq" placeholder="Nome, descrição ou código (ex.: carne bovina, 8905, 21121)" onkeydown="if(event.key==='Enter')lfBuscar()"><select id="lft"><option value="">Materiais e serviços</option><option value="M">Só materiais</option><option value="S">Só serviços</option></select><button onclick="lfBuscar()">Pesquisar</button></div><div id="lfres"></div></div>
   <div class="ev-pane" data-g="lfadd" data-t="nav" hidden><div class="bar"><select id="lfnt" onchange="lfNav(this.value)"><option value="M">Materiais (Grupo › Classe › PDM › Item)</option><option value="S">Serviços (Seção › Divisão › Grupo › Classe › Subclasse › Serviço)</option></select></div><div id="lfnav"></div></div>
   <div class="ev-pane" data-g="lfadd" data-t="ia" hidden><p class="sub">Descreva produtos e serviços com suas palavras. A IA aponta classificações <b>que existem no catálogo</b> e explica o motivo; nada entra na linha sem a sua confirmação. O CNAE não equivale a CATMAT/CATSER e só serve de contexto.</p>
    <textarea id="lfia" rows="4" placeholder="Ex.: Distribuímos carnes bovinas, suínas e de frango congeladas para órgãos públicos; não trabalhamos com pescados nem refeições prontas.">${esc(pj&&pj.descricao_atividades||'')}</textarea>
    <div class="ev-actions"><button onclick="lfSugerir()">${AI('Usa o Gemini')} Sugerir classificações</button></div><div id="lfiares"></div></div>
   <div class="ev-pane" data-g="lfadd" data-t="sicaf" hidden><p class="sub">A consulta pública de linhas do SICAF exige verificação humana (captcha) e o EditalVector não acessa sua conta gov.br. Abra a consulta, copie os códigos e cole aqui: cada código é conferido no catálogo oficial e fica registrado como <b>copiado do SICAF por você</b> (não é validação do SICAF).</p>
    <p><a class="l" href="https://www3.comprasnet.gov.br/sicaf-web/public/pages/consultas/consultarLinhaFornecimento.jsf" target="_blank" rel="noopener">Abrir a consulta de linhas de fornecimento no SICAF ↗</a></p>
    <div class="ev-form"><div><label>Tipo das linhas coladas</label><select id="lfst2"><option value="S">Serviço</option><option value="M">Material</option></select></div>
    <div style="grid-column:1/-1"><label>Códigos (um por linha; pode colar "21121 - Hospedagem…")</label><textarea id="lfsc" rows="5" placeholder="21121 - Hospedagem Servidor - Internet / Sistemas&#10;25330 - Diagramação Eletrônica e Projeto Gráfico"></textarea></div></div>
    <div class="ev-actions"><button onclick="lfSicaf()">Conferir no catálogo</button></div><div id="lfscres"></div></div>
  </div>
 </div>
 <div class="ev-pane" data-g="emp" data-t="dados" ${aba==='dados'?'':'hidden'}>${empForm(pj)}</div>
 </div>`;
 empAuto(false);lfCnae();lfRestaurar();
};
function lfLinha(l){
 const s=SIT_LF[l.situacao]||SIT_LF.ativo;
 return `<div class="lf-row ${l.modo==='excluir'?'exc':''}"><div class="lf-main">
  <div class="lf-top"><span class="chip ${l.tipo==='M'?'c-blue':'c-violet'}">${TIPO_CAT[l.tipo]}</span><span class="chip c-mut">${NIVEL[l.nivel]||l.nivel} ${esc(l.codigo)}</span><span class="chip ${s[0]}">${s[1]} ${s[2]}</span>${l.modo==='incluir'&&l.confirmada===false?'<span class="chip c-amber">! Aguardando sua confirmação</span>':''}${l.confianca&&l.origem!=='manual'&&l.origem!=='sicaf_declarado'?`<span class="chip ${CONF_LF[l.confianca][0]}">${CONF_LF[l.confianca][1]}</span>`:''}${l.principal?'<span class="chip c-green">★ Linha principal</span>':''}</div>
  <b class="lf-nome">${esc(l.nome)}</b>${l.rotulo?`<small class="lf-cam">${esc(l.rotulo)}</small>`:''}
  ${l.especialidade?`<small class="lf-esp">${l.modo==='excluir'?'Motivo':'Especialidade'}: ${esc(l.especialidade)}</small>`:''}
  ${l.evidencia?`<small class="lf-esp">Evidência: ${esc(l.evidencia)}</small>`:''}<small class="lf-orig">${esc(ORIGEM_LF[l.origem]||l.origem)} · atualizado em ${dt(l.atualizado_em)}${l.ia_motivo?` · motivo da IA: ${esc(l.ia_motivo)}`:''}</small></div>
  <div class="lf-ac">${l.modo==='incluir'&&l.confirmada===false?`<button class="sm" onclick="lfConfirmar(['${l.id}'])">Confirmar</button>`:''}${l.modo==='incluir'&&!l.principal?`<button class="sec sm" onclick="lfPrincipal('${l.id}')">Tornar principal</button>`:''}<button class="sec sm" onclick="lfEditar('${l.id}')">Editar</button><button class="sec sm" onclick="lfRemover('${l.id}')">Remover</button></div></div>`;
}
function lfLista(inc,exc){
 const g=t=>inc.filter(l=>l.tipo===t),pend=inc.filter(l=>l.confirmada===false);
 return `${pend.length?`<div class="ev-pend" role="status"><div><b>${pend.length} classe(s)/grupo(s) encontrada(s) automaticamente aguardam sua confirmação</b><span>Já são usadas na busca. Confirme as que a empresa realmente fornece e remova as demais.</span></div><button onclick="lfConfirmar(${esc(JSON.stringify(pend.map(l=>l.id)))})">Confirmar todas</button></div>`:''}${['M','S'].map(t=>g(t).length?`<h4 class="lf-h">${t==='M'?'Materiais que fornece':'Serviços que presta'} <span class="chip c-mut">${g(t).length}</span></h4>${g(t).map(lfLinha).join('')}`:'').join('')}
 ${exc.length?`<h4 class="lf-h">Não fornece (exclusões) <span class="chip c-mut">${exc.length}</span></h4><p class="ev-hint">Itens dentro destas classificações deixam de contar como compatíveis.</p>${exc.map(lfLinha).join('')}`:''}`;
}
function lfResRow(r,origem,motivo){
 const k=`${r.tipo}|${r.nivel}|${r.codigo}`;window.__LFR=window.__LFR||{};window.__LFR[k]={...r,origem:origem||'manual',motivo:motivo||null};
 const ja=(window.__EMP&&window.__EMP.linhas||[]).find(l=>l.tipo===r.tipo&&l.nivel===r.nivel&&l.codigo===String(r.codigo));
 const abre=(r.nivel!=='item'&&r.nivel!=='servico');
 const chv=lfChave(r);
 return `<div class="lf-row res ${r.ativo===false?'inat':''}"><div class="lf-main"><div class="lf-top"><span class="chip ${r.tipo==='M'?'c-blue':'c-violet'}">${TIPO_CAT[r.tipo]}</span><span class="chip c-mut">${NIVEL[r.nivel]||r.nivel} ${esc(r.codigo)}</span>${r.ativo===false?'<span class="chip c-amber">! Inativa no catálogo</span>':''}${ja?`<span class="chip c-green">✓ Já está na linha (${ja.modo==='excluir'?'exclusão':'incluída'})</span>`:''}</div>
  <b class="lf-nome">${esc(r.nome)}</b>${r.rotulo?`<small class="lf-cam">${esc(r.rotulo)}</small>`:''}${chv.length?`<small class="lf-chave">Chave do PCA: ${chv.map(x=>`<b>${x.nivel==='classe'?'Classe':'Grupo'} ${esc(x.codigo)}</b>${x.nome?' '+esc(x.nome):''}`).join(' · ')}</small>`:''}${motivo?`<small class="lf-esp">${AI()} ${esc(motivo)}</small>`:''}</div>
  <div class="lf-ac">${abre?`<button class="sec sm" onclick="lfAbrir('${k}')">Detalhar</button>`:''}<button class="sm" onclick="lfAdd('${k}','incluir')">${origem==='ia'?'Confirmar':'Fornece'}</button>${chv.map(x=>`<button class="sm" onclick="lfAddChave('${k}','${x.nivel}')" title="Inclui ${x.nivel==='classe'?'a classe':'o grupo'} inteiro${x.nome?' ('+esc(x.nome)+')':''}">${x.nivel==='classe'?'Classe':'Grupo'} ${esc(x.codigo)} inteira</button>`).join('')}<button class="sec sm" onclick="lfAdd('${k}','excluir')">Não fornece</button></div></div>`;
}
// classe (material) e grupo (serviço) do resultado: é o nível que o PCA usa como classificação superior
function lfChave(r){
 const c=r.caminho||{},out=[],nomeDe=cod=>{const m=String(r.rotulo||'').split('›').map(x=>x.trim()).find(x=>x.startsWith(cod+' '));return m?m.slice(cod.length+1):'';};
 if(r.tipo==='M'){if(c.classe&&!(r.nivel==='classe'||r.nivel==='grupo'))out.push({nivel:'classe',codigo:c.classe,nome:nomeDe(c.classe)});}
 else{if(c.grupo&&!['grupo','secao','divisao'].includes(r.nivel))out.push({nivel:'grupo',codigo:c.grupo,nome:nomeDe(c.grupo)});
  if(c.classe&&!['classe','grupo','secao','divisao'].includes(r.nivel))out.push({nivel:'classe',codigo:c.classe,nome:nomeDe(c.classe)});}
 return out;
}
function lfAddChave(k,nivel){const r=window.__LFR[k];if(!r)return;const c=r.caminho||{};const kk=`${r.tipo}|${nivel}|${c[nivel]}`;window.__LFR[kk]={tipo:r.tipo,nivel,codigo:String(c[nivel]),nome:'',caminho:null,origem:r.origem||'manual',motivo:r.motivo||null};lfAdd(kk,'incluir');}
async function lfPrincipal(id){try{await rpc('definir_linha_principal',{p_id:id});toast('Linha principal definida');V.empresa();}catch(e){toast(e.message);}}
async function lfBuscar(){
 const q=$('#lfq').value.trim(),t=$('#lft').value||null,box=$('#lfres');if(!q)return;
 box.innerHTML='<div class="vazio">Pesquisando no catálogo…</div>';
 try{const r=await rpc('cat_buscar',{p_q:q,p_tipo:t,p_limite:40,p_offset:0});
  box.innerHTML=r&&r.length?`<p class="ev-hint">${r.length} resultado(s) no catálogo oficial${r.length===40?' (mostrando os 40 mais próximos; refine a pesquisa)':''}.</p>${r.map(x=>lfResRow(x)).join('')}`:'<div class="vazio">Nada encontrado com esses termos. Tente sinônimos, o nome técnico ou o código.</div>';
 }catch(e){box.innerHTML=`<div class="vazio">Não foi possível pesquisar agora (${esc(e.message)}).</div>`;}
}
// navegação por níveis (servidor devolve só os filhos do nível aberto)
async function lfNav(tipo,nivel,codigo,rotulo){
 const box=$('#lfnav');if(!box)return;window.__LFNAV=window.__LFNAV&&window.__LFNAV.tipo===tipo&&nivel?window.__LFNAV:{tipo,trilha:[],origem:null};
 const N=window.__LFNAV;if(nivel){const i=N.trilha.findIndex(x=>x.nivel===nivel&&x.codigo===codigo);if(i>=0)N.trilha=N.trilha.slice(0,i+1);else N.trilha.push({nivel,codigo,rotulo});}
 box.innerHTML='<div class="vazio">Carregando…</div>';
 try{
  if(tipo==='M'&&nivel==='pdm'){return lfItensPdm(codigo,1);}
  const r=await rpc('cat_filhos',{p_tipo:tipo,p_nivel:nivel||null,p_codigo:codigo||null,p_limite:500,p_offset:0});
  box.innerHTML=lfTrilha()+(r&&r.length?r.map(x=>lfResRow(x)).join(''):'<div class="vazio">Sem subdivisões neste nível.</div>');
 }catch(e){box.innerHTML=`<div class="vazio">Erro: ${esc(e.message)}</div>`;}
}
function lfTrilha(){
 const N=window.__LFNAV,t=N.trilha,ant=t.length>1?t[t.length-2]:null;
 const alvo=t.length>1?`${esc(ant.codigo)} ${esc((ant.rotulo||'').slice(0,40))}`:N.origem==='busca'?'resultados da pesquisa':N.tipo==='M'?'Materiais':'Serviços';
 return `<div class="lf-trilha">${t.length||N.origem==='busca'?`<button type="button" class="sec sm lf-voltar" onclick="lfVoltar()">← Voltar para ${alvo}</button>`:''}<a onclick="window.__LFNAV=null;lfNav('${N.tipo}')">${N.tipo==='M'?'Materiais':'Serviços'}</a>${t.map(x=>` › <a onclick="lfNav('${N.tipo}','${x.nivel}','${esc(x.codigo)}')">${esc(x.codigo)} ${esc((x.rotulo||'').slice(0,40))}</a>`).join('')}</div>`;
}
// volta um nível; no primeiro nível aberto a partir de uma pesquisa, volta aos resultados da pesquisa (que continuam na tela)
// depois de incluir/excluir, a tela é refeita: guarda e devolve a pesquisa ou o nível aberto e a rolagem
function lfAba(t){const b=document.querySelector('.ev-tabs[data-g="lfadd"] button[data-t="'+t+'"]');if(b)abaSel(b);}
function lfGuardar(){
 const nav=document.querySelector('.ev-pane[data-g="lfadd"][data-t="nav"]:not([hidden])'),q=$('#lfq');
 window.__LFREST={nav:!!nav,q:q?q.value:'',t:$('#lft')?$('#lft').value:'',y:window.scrollY||document.documentElement.scrollTop||0,N:window.__LFNAV?JSON.parse(JSON.stringify(window.__LFNAV)):null};
}
async function lfRestaurar(){
 const R=window.__LFREST;if(!R)return;window.__LFREST=null;
 try{
  if(R.nav&&R.N){lfAba('nav');window.__LFNAV=R.N;const ult=R.N.trilha[R.N.trilha.length-1];
   if(ult)await lfNav(R.N.tipo,ult.nivel,ult.codigo,ult.rotulo);else await lfNav(R.N.tipo);}
  else if(R.q){$('#lfq').value=R.q;if($('#lft'))$('#lft').value=R.t;await lfBuscar();}
 }catch(e){}
 window.scrollTo(0,R.y);
}
function lfVoltar(){
 const N=window.__LFNAV;if(!N)return;
 if(N.trilha.length>1){const ant=N.trilha[N.trilha.length-2];return lfNav(N.tipo,ant.nivel,ant.codigo,ant.rotulo);}
 if(N.origem==='busca'){window.__LFNAV=null;lfAba('busca');return;}
 window.__LFNAV=null;lfNav(N.tipo);
}
function lfAbrir(k){const r=window.__LFR[k];const sel=$('#lfnt');const veioDaBusca=!!document.querySelector('.ev-pane[data-g="lfadd"][data-t="busca"]:not([hidden])');lfAba('nav');if(sel)sel.value=r.tipo;window.__LFNAV={tipo:r.tipo,trilha:[],origem:veioDaBusca?'busca':null};lfNav(r.tipo,r.nivel,r.codigo,r.nome);}
// itens de material de um PDM: vêm da API oficial sob demanda (o catálogo de itens não é carregado inteiro)
async function lfItensPdm(pdm,pag){
 const box=$('#lfnav');
 try{const r=await fetch(`/api/catalogo?pdm=${encodeURIComponent(pdm)}&pagina=${pag}`,{headers:{authorization:'Bearer '+(await sb.auth.getSession()).data.session.access_token}}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);
  const rows=(r.itens||[]).map(x=>lfResRow(x));
  box.innerHTML=lfTrilha()+`<p class="ev-hint">Itens do PDM ${esc(pdm)} no catálogo oficial (página ${pag} de ${r.paginas||1}; consulta direta à API do Compras.gov.br).</p>`+(rows.join('')||'<div class="vazio">Sem itens.</div>')
   +`<div class="ev-actions">${pag>1?`<button class="sec sm" onclick="lfItensPdm('${pdm}',${pag-1})">Anterior</button>`:''}${pag<(r.paginas||1)?`<button class="sec sm" onclick="lfItensPdm('${pdm}',${pag+1})">Próxima</button>`:''}</div>`;
 }catch(e){box.innerHTML=lfTrilha()+`<div class="vazio">O catálogo oficial não respondeu agora (${esc(e.message)}). Você pode incluir o PDM inteiro e refinar depois.</div>`;}
}
async function lfAdd(k,modo){
 const r=window.__LFR[k];if(!r)return;
 const esp=modo==='excluir'?(prompt('Motivo da exclusão (opcional):','')||null):null;
 try{await rpc('salvar_linha',{p_tipo:r.tipo,p_nivel:r.nivel,p_codigo:String(r.codigo),p_modo:modo,p_especialidade:esp,p_origem:r.origem||'manual',p_ia_motivo:r.motivo||null,p_nome:r.nome||null,p_caminho:r.caminho||null});
  toast(modo==='excluir'?'Exclusão registrada':'Incluída na linha de fornecimento');lfMudou();lfGuardar();V.empresa();}
 catch(e){toast(e.message);}
}
async function lfEditar(id){
 const l=(window.__EMP.linhas||[]).find(x=>x.id===id);if(!l)return;
 const d=document.createElement('div');d.className='ev-modal';d.innerHTML=`<div class="card"><h3>${esc(l.nome)}</h3><p class="sub">${TIPO_CAT[l.tipo]} · ${NIVEL[l.nivel]} ${esc(l.codigo)}</p>
  <div class="ev-form"><div><label>Situação na linha</label><select id="lfem"><option value="incluir" ${l.modo==='incluir'?'selected':''}>Fornece</option><option value="excluir" ${l.modo==='excluir'?'selected':''}>Não fornece (exclusão)</option></select></div>
  <div style="grid-column:1/-1"><label>${'Especialidade ou observação'}</label><textarea id="lfee" rows="3" placeholder="Ex.: só cortes congelados; atendimento em SP e MG">${esc(l.especialidade||'')}</textarea><div class="ev-hint">Também é usada para achar licitações pela descrição quando faltam códigos.</div></div></div>
  <div class="ev-actions"><button onclick="lfSalvarEd('${id}')">Salvar</button><button class="sec" onclick="this.closest('.ev-modal').remove()">Cancelar</button></div></div>`;
 document.body.appendChild(d);
}
async function lfSalvarEd(id){
 const l=window.__EMP.linhas.find(x=>x.id===id);
 try{await rpc('salvar_linha',{p_tipo:l.tipo,p_nivel:l.nivel,p_codigo:l.codigo,p_modo:$('#lfem').value,p_especialidade:$('#lfee').value||null,p_origem:l.origem==='ia'?'manual':l.origem,p_ia_motivo:null,p_nome:l.nome,p_caminho:null});
  document.querySelector('.ev-modal')?.remove();toast('Linha atualizada');lfMudou();V.empresa();}catch(e){toast(e.message);}
}
async function lfRemover(id){if(!confirm('Remover esta classificação da linha de fornecimento?'))return;try{await rpc('remover_linha',{p_id:id});toast('Removida');lfMudou();V.empresa();}catch(e){toast(e.message);}}
// depois de mudar a linha: refaz o perfil automático (sem mexer nas preferências) e recalcula as correspondências
function lfMudou(){clearTimeout(window.__LFT);window.__LFT=setTimeout(lfAtualizar,1200);}
async function lfAtualizar(){
 const st=t=>{const e=$('#lfst');if(e)e.innerHTML=t;};
 st('Atualizando oportunidades…');
 try{
  const pid=await rpc('sincronizar_perfil_linha');
  const r=await rpc('atualizar_correspondencias',{p_org:null});
  st(`Direcionamento atualizado: ${fmtN(r.licitacoes_confirmadas)} licitações e ${fmtN(r.pca_confirmadas)} itens do PCA confirmados.`);
  if(pid){ // significado (vetores) roda em segundo plano; demora alguns segundos
   const tk=(await sb.auth.getSession()).data.session.access_token;
   fetch('/api/perfil',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'salvar',perfil:pid})})
    .then(x=>x.json()).then(j=>{if(j.erro)st('Correspondência por código atualizada. A busca por significado ficou pendente: '+esc(j.erro));}).catch(()=>{});
  }
 }catch(e){st('Não foi possível atualizar agora: '+esc(e.message));}
}
async function lfSugerir(){
 const t=$('#lfia').value.trim(),box=$('#lfiares');if(t.length<10)return toast('Descreva um pouco mais o que a empresa fornece.');
 box.innerHTML='<div class="vazio">Consultando o catálogo e a IA…</div>';
 try{const tk=(await sb.auth.getSession()).data.session.access_token;
  const r=await fetch('/api/ia',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'sugerir_linhas',texto:t})}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);
  const pj=window.__EMP.pj;if(pj&&t!==pj.descricao_atividades)sb.from('pessoas_juridicas').update({descricao_atividades:t}).eq('id',pj.id).then(()=>{});
  box.innerHTML=(r.sugestoes||[]).length?`<p class="ev-hint">${AI()} ${r.sugestoes.length} sugestão(ões), todas conferidas no catálogo oficial. Confirme uma a uma.</p>`+r.sugestoes.map(x=>lfResRow(x,'ia',x.motivo)).join(''):'<div class="vazio">A IA não encontrou classificações seguras para essa descrição. Use a pesquisa.</div>';
 }catch(e){box.innerHTML=`<div class="vazio">${esc(e.message)}</div>`;}
}
// Cadastro automático pelo CNPJ: dados públicos (Receita via BrasilAPI) + o que o CNPJ já vendeu em atas de registro de preços,
// traduzido para classe (material) e grupo (serviço). Só acrescenta; nunca remove nem altera linhas existentes.
async function empAuto(forcar){
 const E=window.__EMP,pj=E&&E.pj,box=$('#lfauto');if(!pj||!pj.cnpj||!box)return;
 const jaFez=pj.dados_publicos&&pj.dados_publicos.historico_em;
 const auto=!forcar&&!(E.linhas||[]).length&&!jaFez&&!window.__AUTO_FEITO;
 if(!forcar&&!auto){box.innerHTML=(E.linhas||[]).length?`<div class="ev-hint">Linha preenchida a partir de ${jaFez?'consulta pública em '+dt(pj.dados_publicos.historico_em):'seus registros'}. <a class="l" onclick="empAuto(true)">Atualizar pelo histórico público do CNPJ</a></div>`:`<div class="ev-hint"><a class="l" onclick="empAuto(true)">Buscar a linha pelo histórico público do CNPJ</a></div>`;return;}
 window.__AUTO_FEITO=true;
 box.innerHTML='<div class="card"><div class="vazio">Consultando os dados públicos do CNPJ e o que a empresa já forneceu ao governo…</div></div>';
 const tk=(await sb.auth.getSession()).data.session.access_token,H={authorization:'Bearer '+tk};
 const nota=[];let rec=null,hist=null,add=0;
 try{const r=await fetch('/api/catalogo?cnpj='+encodeURIComponent(pj.cnpj),{headers:H}).then(x=>x.json());if(!r.erro){rec=r;}else nota.push('Dados cadastrais: '+r.erro);}catch(e){nota.push('Dados cadastrais indisponíveis agora.');}
 try{const r=await fetch('/api/catalogo?historico='+encodeURIComponent(pj.cnpj),{headers:H}).then(x=>x.json());if(r.erro)throw new Error(r.erro);hist=r;}catch(e){nota.push('Histórico de fornecimento indisponível agora ('+e.message+').');}
 const rf=rec&&rec.receita;
 const upd={dados_publicos:{fonte:'BrasilAPI (Receita Federal) e Dados Abertos Compras.gov.br',receita:rf||null,sicaf:rec&&rec.sicaf||null,historico_registros:hist?hist.registros:null,historico_em:hist?new Date().toISOString():null},dados_publicos_em:new Date().toISOString()};
 if(rf){upd.situacao_cadastral=rf.situacao||null;if(rf.cnae)upd.cnaes=[{codigo:String(rf.cnae),descricao:rf.cnae_desc||'',principal:true},...(rf.cnaes_sec||[]).map(x=>({codigo:String(x.codigo),descricao:x.descricao||'',principal:false}))];if(!pj.razao_social&&rf.razao_social)upd.razao_social=rf.razao_social;if(!pj.uf&&rf.uf)upd.uf=rf.uf;if(!pj.municipio&&rf.municipio)upd.municipio=rf.municipio;if(!pj.porte&&rf.porte)upd.porte=rf.porte;if(!pj.cnae_principal&&rf.cnae)upd.cnae_principal=rf.cnae;if(!pj.nome_fantasia&&rf.nome_fantasia)upd.nome_fantasia=rf.nome_fantasia;}
 await sb.from('pessoas_juridicas').update(upd).eq('id',pj.id);
 if(hist&&(hist.itens||[]).length){try{add=await rpc('salvar_linhas_historico',{p_itens:hist.itens});}catch(e){nota.push('Não foi possível gravar a linha: '+e.message);}}
 const cn=rf?[rf.cnae_desc,...(rf.cnaes_sec||[]).map(x=>x.descricao)].filter(Boolean):[];
 if(upd.cnaes)pj.cnaes=upd.cnaes;
 if(add>0){lfMudou();toast(`Linha encontrada pelo histórico: ${add} classe(s)/grupo(s) para confirmar`);return V.empresa();}
 box.innerHTML=`<div class="card ev-destaque"><h3>${hist&&(hist.itens||[]).length?'A linha já estava completa':'Não encontramos fornecimento anterior deste CNPJ'}</h3>
  <p class="sub">${hist?(hist.itens||[]).length?`O histórico público (${fmtN(hist.registros)} itens de atas nos últimos 3 anos) cai em classes/grupos que já estão na linha.`:'O CNPJ não aparece como fornecedor em atas de registro de preços dos últimos 3 anos, ou é uma empresa nova. Isso não impede o uso: escolha a classe ou o grupo, ou deixe a IA sugerir a partir da atividade.':'A consulta pública não respondeu agora.'}${nota.length?' '+esc(nota.join(' ')):''}</p>
  ${cn.length&&!(E.linhas||[]).length?`<p class="sub">Veja abaixo as sugestões feitas a partir dos CNAEs da empresa (CNAE não equivale a CATMAT/CATSER; você confirma cada uma).</p>`:''}</div>`;
 window.__CNAE_TXT=cn.join('. ');lfCnae();
}
async function lfConfirmar(ids){try{const n=await rpc('confirmar_linhas',{p_ids:ids});toast(n+' confirmada(s)');lfMudou();V.empresa();}catch(e){toast(e.message);}}
// Etapas 3 e 4: sugestões de classe/grupo pelos CNAEs (relação aprendida de fornecedores reais + IA restrita ao catálogo), com confirmação
async function lfCnae(){
 const E=window.__EMP,pj=E&&E.pj,box=$('#lfcnae');if(!pj||!box)return;
 const cn=Array.isArray(pj.cnaes)?pj.cnaes:[];
 if(!cn.length){box.innerHTML='';return;}
 box.innerHTML='<div class="card"><div class="vazio">Procurando classes e grupos para os CNAEs da empresa…</div></div>';
 const cods=cn.map(x=>String(x.codigo));let rows=[],aviso='';
 try{rows=(await rpc('sugestoes_cnae',{p_cnaes:cods}))||[];}catch(e){box.innerHTML='';return;}
 const faltam=cn.filter(x=>!rows.some(r=>r.cnae===String(x.codigo)));
 const chave='cnaeia:'+pj.cnpj;let ult=0;try{ult=+localStorage.getItem(chave)||0;}catch(e){}
 if(faltam.length&&Date.now()-ult>7*864e5){
  try{const tk=(await sb.auth.getSession()).data.session.access_token;
   const r=await fetch('/api/ia',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'sugerir_cnae',cnaes:faltam.map(x=>({codigo:String(x.codigo),descricao:x.descricao}))})}).then(x=>x.json());
   try{localStorage.setItem(chave,String(Date.now()));}catch(e){}
   if(r.erro)aviso=r.erro;else rows=(await rpc('sugestoes_cnae',{p_cnaes:cods}))||rows;
  }catch(e){aviso='Sugestões por IA indisponíveis agora.';}
 }
 const noLinha=new Set((E.linhas||[]).map(l=>`${l.tipo}|${l.nivel}|${l.codigo}`)),G=new Map(),RK={alta:3,media:2,baixa:1};
 rows.forEach(r=>{const k=`${r.tipo}|${r.nivel}|${r.codigo}`;if(noLinha.has(k)||(window.__LFDESC||{})[k])return;
  const g=G.get(k)||{...r,cnaes:[]};g.cnaes.push(r.cnae);
  if((r.origem==='amostra_fornecedores'?10:0)+RK[r.confianca]>(g.origem==='amostra_fornecedores'?10:0)+RK[g.confianca]){Object.assign(g,{origem:r.origem,confianca:r.confianca,apoio:r.apoio,amostra:r.amostra,motivo:r.motivo});}
  G.set(k,g);});
 const lista=[...G.values()].sort((a,b)=>RK[b.confianca]-RK[a.confianca]||(b.apoio||0)-(a.apoio||0));
 window.__LFSUG=Object.fromEntries(lista.map(g=>[`${g.tipo}|${g.nivel}|${g.codigo}`,g]));
 const desc=c=>(cn.find(x=>String(x.codigo)===c)||{}).descricao||'';
 const alta=lista.filter(g=>g.confianca==='alta');
 box.innerHTML=`<div class="card"><h3>Sugestões pelas atividades da empresa (CNAE)</h3>
  <p class="sub">CNAE não é linha de fornecimento: abaixo estão <b>sugestões</b> de classe/grupo a partir das ${cn.length} atividade(s) da empresa na Receita Federal; só entram na linha depois que você confirmar.</p>
  <details class="ev-det"><summary>Ver os ${cn.length} CNAE(s) da empresa</summary><ul>${cn.map(x=>`<li><b>${esc(x.codigo)}</b> ${esc(x.descricao||'')}${x.principal?' <span class="chip c-mut">principal</span>':''}</li>`).join('')}</ul></details>
  ${aviso?`<p class="ev-hint">${esc(aviso)}</p>`:''}
  ${faltam.length&&rows.length===0?`<p class="ev-hint">Ainda não há sugestões para estes CNAEs. A relação com o catálogo é aprendida na próxima coleta a partir do que fornecedores reais do mesmo CNAE venderam; enquanto isso, use a pesquisa ou as sugestões por IA.</p>`:''}
  ${alta.length>1?`<div class="ev-actions"><button onclick="lfSugTodas()">Confirmar as ${alta.length} de confiança alta</button></div>`:''}
  ${lista.length?lista.slice(0,30).map(g=>{const k=`${g.tipo}|${g.nivel}|${g.codigo}`;return `<div class="lf-row res"><div class="lf-main"><div class="lf-top"><span class="chip ${g.tipo==='M'?'c-blue':'c-violet'}">${TIPO_CAT[g.tipo]}</span><span class="chip c-mut">${NIVEL[g.nivel]} ${esc(g.codigo)}</span><span class="chip ${CONF_LF[g.confianca][0]}">${CONF_LF[g.confianca][1]}</span><span class="chip c-mut">${g.origem==='amostra_fornecedores'?'Fornecedores reais':'IA (sugestão)'}</span></div>
   <b class="lf-nome">${esc(g.nome)}</b>${g.rotulo?`<small class="lf-cam">${esc(g.rotulo)}</small>`:''}
   <small class="lf-esp">${g.origem==='ia'?AI()+' ':''}${esc(g.motivo||'')}${g.confirmacoes?` · confirmada por ${g.confirmacoes} empresa(s)`:''}</small>
   <small class="lf-orig">CNAE de origem: ${[...new Set(g.cnaes)].map(c=>esc(c)+' '+esc(desc(c).slice(0,40))).join('; ')}</small></div>
   <div class="lf-ac"><button class="sm" onclick="lfSugOk('${k}')">Confirmar</button><button class="sec sm" onclick="lfSugNao('${k}')">Não é minha</button></div></div>`;}).join(''):(faltam.length?'':'<div class="vazio">Todas as sugestões já estão na linha ou foram dispensadas.</div>')}</div>`;
}
async function lfSugConf(k){const g=window.__LFSUG[k];if(!g)return;
 await rpc('confirmar_sugestao_cnae',{p_tipo:g.tipo,p_nivel:g.nivel,p_codigo:g.codigo,p_cnaes:[...new Set(g.cnaes)],p_origem:g.origem==='ia'?'ia':'cnae_fornecedores',p_confianca:g.confianca,p_motivo:g.origem==='ia'?g.motivo:null});}
async function lfSugOk(k){try{await lfSugConf(k);toast('Incluída na linha de fornecimento');lfMudou();V.empresa();}catch(e){toast(e.message);}}
function lfSugNao(k){(window.__LFDESC=window.__LFDESC||{})[k]=1;lfCnae();}
async function lfSugTodas(){const ks=Object.keys(window.__LFSUG).filter(k=>window.__LFSUG[k].confianca==='alta');
 try{for(const k of ks)await lfSugConf(k);toast(ks.length+' incluída(s) na linha');lfMudou();V.empresa();}catch(e){toast(e.message);}}
async function lfSicaf(){
 const tipo=$('#lfst2').value,cods=[...new Set(($('#lfsc').value.match(/^\s*(\d{2,9})/gm)||[]).map(x=>x.trim()))],box=$('#lfscres');
 if(!cods.length)return toast('Cole ao menos um código.');
 box.innerHTML='<div class="vazio">Conferindo…</div>';
 const out=[];for(const c of cods.slice(0,60)){const r=await rpc('cat_buscar',{p_q:c,p_tipo:tipo,p_limite:10,p_offset:0}).catch(()=>[]);out.push([c,r||[]]);}
 box.innerHTML=out.map(([c,r])=>r.length?(r.length>1?`<p class="ev-hint">O código ${esc(c)} existe em mais de um nível; escolha o que está no seu SICAF:</p>`:'')+r.map(x=>lfResRow(x,'sicaf_declarado')).join(''):`<div class="lf-row"><div class="lf-main"><b>${esc(c)}</b><small class="lf-cam">Não encontrado no catálogo oficial como ${TIPO_CAT[tipo].toLowerCase()}.</small></div></div>`).join('');
}
function empForm(pj){
 if(!pj)return pend('Nenhuma empresa cadastrada nesta organização','',"Use Minha organização para cadastrar o CNPJ.");
 const dp=pj.dados_publicos||null;
 return `<div class="card"><h3>Dados da empresa</h3><p class="sub">Poucos campos agora; o restante pode ser preenchido depois.</p>
 <div class="ev-form"><div><label>CNPJ</label><input id="ecnpj" value="${esc(pj.cnpj)}" disabled></div>
 <div><label>Razão social</label><input id="erz" value="${esc(pj.razao_social||'')}"></div>
 <div><label>Nome fantasia</label><input id="efa" value="${esc(pj.nome_fantasia||'')}"></div>
 <div><label>UF da sede</label>${ufSelect('euf',pj.uf,"ufMud(this,'emun')")}</div>
 <div><label>Município</label>${munSelect('emun',pj.uf,pj.municipio)}</div>
 <div><label>Porte</label><select id="epo"><option value="">—</option>${['MEI','Microempresa','Empresa de pequeno porte','Demais'].map(x=>`<option ${x===pj.porte?'selected':''}>${x}</option>`).join('')}</select></div>
 <div><label>CNAE principal <small>(só contexto; não é linha de fornecimento)</small></label><input id="ecn" value="${esc(pj.cnae_principal||'')}"></div>
 <div style="grid-column:1/-1"><label>O que a empresa faz (texto livre)</label><textarea id="eda" rows="3">${esc(pj.descricao_atividades||'')}</textarea></div></div>
 <div class="ev-actions"><button onclick="empSalvar()">Salvar</button><button class="sec" onclick="empPublicos()">Buscar dados públicos do CNPJ</button></div>
 ${dp?`<p class="ev-hint">Dados públicos consultados em ${dt(pj.dados_publicos_em)} (fonte: ${esc(dp.fonte||'—')}). Confira antes de usar.</p>`:''}<div id="epub"></div></div>`;
}
async function empSalvar(){
 const pj=window.__EMP.pj;const row={razao_social:$('#erz').value.trim(),nome_fantasia:$('#efa').value.trim()||null,uf:$('#euf').value||null,municipio:$('#emun').value.trim()||null,porte:$('#epo').value||null,cnae_principal:$('#ecn').value.trim()||null,descricao_atividades:$('#eda').value.trim()||null,atualizado_em:new Date().toISOString()};
 if(!row.razao_social)return toast('Informe a razão social.');
 const {error}=await sb.from('pessoas_juridicas').update(row).eq('id',pj.id);if(error)return toast(error.message);toast('Dados salvos');V.empresa();
}
// dados públicos: Receita (BrasilAPI) para cadastro; situação no SICAF pela API de dados abertos (sem linhas de fornecimento)
async function empPublicos(){
 const pj=window.__EMP.pj,box=$('#epub');box.innerHTML='<div class="vazio">Consultando…</div>';
 try{const tk=(await sb.auth.getSession()).data.session.access_token;
  const r=await fetch('/api/catalogo?cnpj='+encodeURIComponent(pj.cnpj),{headers:{authorization:'Bearer '+tk}}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);
  const rf=r.receita||{},sf=r.sicaf;
  box.innerHTML=`<div class="ev-pub"><h4>Receita Federal (via BrasilAPI)</h4>${rf.razao_social?`<p><b>${esc(rf.razao_social)}</b>${rf.nome_fantasia?' · '+esc(rf.nome_fantasia):''}<br>${esc(rf.municipio||'')}/${esc(rf.uf||'')} · ${esc(rf.porte||'')} · CNAE ${esc(rf.cnae||'')} ${esc(rf.cnae_desc||'')}</p><button class="sm" onclick='empAplicar(${JSON.stringify({razao_social:rf.razao_social,nome_fantasia:rf.nome_fantasia,uf:rf.uf,municipio:rf.municipio,cnae_principal:rf.cnae}).replace(/'/g,"&#39;")})'>Usar estes dados no cadastro</button>`:'<p>Não encontrado.</p>'}
   <h4>SICAF (Dados Abertos do Compras.gov.br)</h4><p>${sf?`${sf.ativo?'Cadastro ativo':'Cadastro inativo'}${sf.habilitadoLicitar!=null?` · ${sf.habilitadoLicitar?'apto a licitar no cadastro':'não apto a licitar no cadastro'}`:''} · porte ${esc(sf.porteEmpresaNome||'—')}`:'Fornecedor não encontrado na base pública do SICAF.'}</p>
   <p class="ev-hint">A base pública não informa linhas de fornecimento; cadastre-as na aba Linha de fornecimento.</p></div>`;
  await sb.from('pessoas_juridicas').update({dados_publicos:{fonte:'BrasilAPI (Receita Federal) e Dados Abertos Compras.gov.br',receita:rf,sicaf:sf||null},dados_publicos_em:new Date().toISOString()}).eq('id',pj.id);
 }catch(e){box.innerHTML=`<div class="vazio">Consulta indisponível agora (${esc(e.message)}). O cadastro continua funcionando normalmente.</div>`;}
}
async function empAplicar(d){Object.entries({erz:d.razao_social,efa:d.nome_fantasia,ecn:d.cnae_principal}).forEach(([k,v])=>{if(v&&$('#'+k))$('#'+k).value=v;});if(d.uf&&$('#euf'))$('#euf').value=d.uf;if($('#emun')){const m=$('#emun');m.dataset.uf=d.uf||$('#euf').value;m.dataset.atual=d.municipio||'';munPreencher(m);}toast('Campos preenchidos; confira e salve.');}

// ------------------------------------------------------------------ subnavegação de Licitações e PCA
const SUB_OP=[['oport','Pela linha de fornecimento'],['triagem','Pelos perfis de busca'],['radar','Radar'],['oportunidades','Pesquisa ampla']];
const SUB_PCA=[['pca','Pela linha de fornecimento'],['pca_ampla','Pesquisa ampla']];
const subnav=(lst,at)=>`<nav class="ev-sub" aria-label="Visões">${lst.map(([k,r])=>`<button type="button" class="${k===at?'on':''}" onclick="ir('${k}')">${r}${(k==='triagem'||k==='radar')&&!pode('radar')?' 🔒':''}</button>`).join('')}</nav>`;
['triagem','radar','oportunidades'].forEach(k=>{const f=V[k];if(!f)return;V[k]=async()=>{await f();main.insertAdjacentHTML('afterbegin',subnav(SUB_OP,k)+(k==='oportunidades'?'<p class="ev-hint ev-amplo">Pesquisa ampla: mostra licitações fora da sua linha de fornecimento. Use quando quiser explorar além do direcionamento.</p>':''));};});
V.pca_ampla=V.pca;V.pca_ampla=(f=>async()=>{await f();main.insertAdjacentHTML('afterbegin',subnav(SUB_PCA,'pca_ampla')+'<p class="ev-hint ev-amplo">Pesquisa ampla no PCA, fora da sua linha de fornecimento.</p>');})(V.pca);
// o bloqueio de plano das telas antigas vale também para a subnavegação
const _telaBloq=telaBloqueada;window.telaBloqueada=t=>{_telaBloq(t);if(['triagem','radar'].includes(t))main.insertAdjacentHTML('afterbegin',subnav(SUB_OP,t));};

// ------------------------------------------------------------------ licitações direcionadas pela linha
V.oport=async()=>{
 const F=window.__OPF=Object.assign({conf:null,uf:'',busca:'',ordem:'prazo',refinos:true,pag:0},window.__OPF||{},window.ARG&&window.ARG.conf?{conf:window.ARG.conf,pag:0}:{});
 const R=await rpc('resumo_linha').catch(()=>null)||{};
 if(!(R.linhas_incluir>0)){main.innerHTML=subnav(SUB_OP,'oport')+`<div class="top"><div><h2>Licitações</h2></div></div>`+pend('Cadastre a linha de fornecimento para ver licitações direcionadas',`<button onclick="ir('empresa',{aba:'linha'})">Cadastrar linha de fornecimento</button>`,'Sem ela, nada aqui seria personalizado. A pesquisa ampla continua disponível na aba acima.');return;}
 const PL=R.perfil_linha||{};
 const rows=await rpc('oportunidades_linha',{p_conf:F.conf,p_busca:F.busca||null,p_uf:F.uf||null,p_ordem:F.ordem,p_limite:30,p_offset:F.pag*30,p_aplicar_refinos:F.refinos});
 const tot=rows&&rows.length?Number(rows[0].total):0;
 const refinos=[PL.ufs&&PL.ufs.length?'UF: '+PL.ufs.join(', '):'',PL.modalidades&&PL.modalidades.length?PL.modalidades.length+' modalidade(s)':'',PL.valor_min!=null?'mín. '+brl(PL.valor_min):'',PL.valor_max!=null?'máx. '+brl(PL.valor_max):'',PL.dias?`≥ ${PL.dias} dias para propostas`:''].filter(Boolean);
 main.innerHTML=subnav(SUB_OP,'oport')+`<div class="top"><div><h2>Licitações na sua linha</h2><p class="sub">Encontradas pela linha de fornecimento: primeiro as confirmadas por código ou classificação, depois as possíveis para revisar.</p></div></div>
 <div class="card ev-filtros"><div class="bar">
  <select id="ofc"><option value="">Confirmadas e para revisar</option><option value="confirmada" ${F.conf==='confirmada'?'selected':''}>Só confirmadas</option><option value="revisar" ${F.conf==='revisar'?'selected':''}>Só para revisar</option></select>
  <select id="ofu"><option value="">Todas as UFs</option>${UFS.map(u=>`<option ${u===F.uf?'selected':''}>${u}</option>`).join('')}</select>
  <input id="ofb" placeholder="Palavra no objeto" value="${esc(F.busca)}" onkeydown="if(event.key==='Enter')opFiltrar()">
  <select id="ofo"><option value="prazo">Encerra antes</option><option value="valor" ${F.ordem==='valor'?'selected':''}>Maior valor</option><option value="recentes" ${F.ordem==='recentes'?'selected':''}>Mais recentes</option></select>
  <button onclick="opFiltrar()">Filtrar</button></div>
  <div class="ev-refino"><span>Refinamentos: ${refinos.length?refinos.map(esc).join(' · '):'nenhum'}</span>
   <label class="pf-sw"><input type="checkbox" style="width:auto" ${F.refinos?'checked':''} onchange="window.__OPF.refinos=this.checked;window.__OPF.pag=0;ir('oport')"> aplicar</label>
   <button class="sec sm" onclick="opRefinar()">Ajustar refinamentos</button></div>
 </div>
 <p class="ev-hint">${fmtN(tot)} licitação(ões) aberta(s). Itens lidos em ${fmtN(R.abertas_com_itens)} de ${fmtN(R.abertas)} licitações abertas — muitas publicações não trazem código de catálogo; por isso as sugestões pela descrição aparecem separadas, para revisão.</p>
 <div class="ev-cards">${(rows||[]).map(o=>cardLic(o,{corresp:o,interesse:o.interesse})).join('')||'<div class="vazio">Nenhuma licitação aberta com esses filtros.</div>'}</div>
 ${tot>30?`<div class="ev-actions" style="justify-content:center">${F.pag>0?`<button class="sec" onclick="window.__OPF.pag--;ir('oport')">Anteriores</button>`:''}<span class="ev-hint">Página ${F.pag+1} de ${Math.ceil(tot/30)}</span>${(F.pag+1)*30<tot?`<button class="sec" onclick="window.__OPF.pag++;ir('oport')">Próximas</button>`:''}</div>`:''}`;
};
function opFiltrar(){Object.assign(window.__OPF,{conf:$('#ofc').value||null,uf:$('#ofu').value,busca:$('#ofb').value.trim(),ordem:$('#ofo').value,pag:0});window.ARG=null;V.oport();}
async function opRefinar(){
 const R=await rpc('resumo_linha');const P=R.perfil_linha||{};
 const d=document.createElement('div');d.className='ev-modal';d.innerHTML=`<div class="card"><h3>Refinar o direcionamento</h3><p class="sub">Estas preferências filtram os resultados da linha de fornecimento. Não mudam as classificações da empresa.</p>
 <div class="ev-form"><div style="grid-column:1/-1"><label>Só nestas UFs (vazio = Brasil inteiro)</label><input id="rfu" value="${esc((P.ufs||[]).join(', '))}" placeholder="SP, MG"></div>
 <div><label>Valor mínimo (R$)</label><input id="rfmin" type="number" min="0" value="${P.valor_min??''}"></div><div><label>Valor máximo (R$)</label><input id="rfmax" type="number" min="0" value="${P.valor_max??''}"></div>
 <div><label>Dias mínimos até o fim das propostas</label><input id="rfd" type="number" min="0" value="${P.dias??0}"></div>
 <div style="grid-column:1/-1"><label>Modalidades (nenhuma marcada = todas)</label><div class="pf-mods">${MODS_PF.map(m=>`<label><input type="checkbox" style="width:auto" data-rm="${esc(m)}" ${(P.modalidades||[]).includes(m)?'checked':''}> ${esc(m)}</label>`).join('')}</div></div></div>
 <div class="ev-actions"><button onclick="opRefinoSalvar()">Salvar</button><button class="sec" onclick="this.closest('.ev-modal').remove()">Cancelar</button></div></div>`;
 document.body.appendChild(d);
}
async function opRefinoSalvar(){
 const ufs=$('#rfu').value.toUpperCase().split(/[^A-Z]+/).filter(u=>UFS.includes(u));
 const n=v=>v===''?null:Number(v);
 try{await rpc('refinar_linha',{p_ufs:ufs,p_modalidades:[...document.querySelectorAll('[data-rm]:checked')].map(x=>x.dataset.rm),p_valor_min:n($('#rfmin').value),p_valor_max:n($('#rfmax').value),p_dias:Number($('#rfd').value||0)});
  document.querySelector('.ev-modal')?.remove();toast('Refinamentos salvos');window.__OPF.pag=0;ir('oport');}catch(e){toast(e.message);}
}

// ------------------------------------------------------------------ compras planejadas (PCA)
TELAS.pca='Compras planejadas — PCA';
V.pca=async()=>{
 const F=window.__PCF=Object.assign({conf:null,uf:'',ano:'',de:'',ate:'',orgao:'',pag:0},window.__PCF||{});
 const R=await rpc('resumo_linha').catch(()=>null)||{};
 const aviso='<p class="ev-pca-aviso"><b>PCA é planejamento.</b> Os itens abaixo são compras que os órgãos pretendem fazer; podem mudar ou não acontecer. Não são licitações abertas nem contratação garantida.</p>';
 if(!(R.linhas_incluir>0)){main.innerHTML=subnav(SUB_PCA,'pca')+`<div class="top"><div><h2>Compras planejadas — PCA</h2></div></div>`+aviso+pend('Cadastre a linha de fornecimento para ver compras planejadas compatíveis',`<button onclick="ir('empresa',{aba:'linha'})">Cadastrar linha de fornecimento</button>`);return;}
 const rows=await rpc('pca_linha',{p_conf:F.conf,p_uf:F.uf||null,p_ano:F.ano?Number(F.ano):null,p_de:F.de||null,p_ate:F.ate||null,p_orgao:F.orgao||null,p_limite:30,p_offset:F.pag*30});
 const tot=rows&&rows.length?Number(rows[0].total):0;const ano=new Date().getFullYear();
 main.innerHTML=subnav(SUB_PCA,'pca')+`<div class="top"><div><h2>Compras planejadas — PCA</h2><p class="sub">Itens dos Planos de Contratações Anuais compatíveis com a sua linha de fornecimento.</p></div></div>${aviso}
 <div class="card ev-filtros"><div class="bar">
  <select id="pfc"><option value="">Confirmadas e para revisar</option><option value="confirmada" ${F.conf==='confirmada'?'selected':''}>Só confirmadas</option><option value="revisar" ${F.conf==='revisar'?'selected':''}>Só para revisar</option></select>
  <select id="pfu"><option value="">Todas as UFs</option>${UFS.map(u=>`<option ${u===F.uf?'selected':''}>${u}</option>`).join('')}</select>
  <select id="pfa"><option value="">Todos os anos</option>${[ano,ano+1].map(a=>`<option ${String(a)===String(F.ano)?'selected':''}>${a}</option>`).join('')}</select>
  <input id="pfo" placeholder="Órgão" value="${esc(F.orgao)}">
  <div><label class="mini">Desejada de</label><input id="pfde" type="date" value="${F.de}"></div><div><label class="mini">até</label><input id="pfat" type="date" value="${F.ate}"></div>
  <button onclick="pcaFiltrar()">Filtrar</button></div></div>
 <p class="ev-hint">${fmtN(tot)} item(ns). Itens com valor a partir de R$ 30 mil; classificações conferidas no catálogo oficial quando o plano usa o Catálogo do Compras.gov.br.</p>
 <div class="ev-cards">${(rows||[]).map(pcaCard).join('')||'<div class="vazio">Nenhum item planejado compatível com esses filtros.</div>'}</div>
 ${tot>30?`<div class="ev-actions" style="justify-content:center">${F.pag>0?`<button class="sec" onclick="window.__PCF.pag--;ir('pca')">Anteriores</button>`:''}<span class="ev-hint">Página ${F.pag+1} de ${Math.ceil(tot/30)}</span>${(F.pag+1)*30<tot?`<button class="sec" onclick="window.__PCF.pag++;ir('pca')">Próximas</button>`:''}</div>`:''}`;
};
function pcaFiltrar(){Object.assign(window.__PCF,{conf:$('#pfc').value||null,uf:$('#pfu').value,ano:$('#pfa').value,orgao:$('#pfo').value.trim(),de:$('#pfde').value,ate:$('#pfat').value,pag:0});V.pca();}
function pcaCard(p){
 const ok=p.confianca==='confirmada',d=p.data_desejada;
 const link=`https://pncp.gov.br/app/pca/${esc(p.orgao_cnpj)}/${esc(p.ano)}`;
 return `<article class="lc pc"><header class="lc-h"><span></span><div><div class="lc-chips"><span class="chip c-orange">PCA ${esc(p.ano)}</span>${p.cat_tipo?`<span class="chip ${p.cat_tipo==='M'?'c-blue':'c-violet'}">${TIPO_CAT[p.cat_tipo]}</span>`:''}<span class="chip ${ok?'c-green':'c-amber'}">${ok?'✓ Na sua linha de fornecimento':'? Possível — revise'}</span></div>
  <h3 class="lc-obj">${esc(p.descricao||'Sem descrição')}</h3><div class="lc-org"><span>${evi('bank')}<b>${esc(p.orgao_nome||'')}</b></span>${p.nome_unidade?`<span>${esc(p.nome_unidade)}</span>`:''}${p.uf?`<span>${evi('pin')}${esc(p.uf)}</span>`:''}</div></div><div></div></header>
  <div class="lc-facts"><div><span>Valor estimado</span><b class="mono">${p.valor_total!=null?brl(p.valor_total):'Não informado'}</b>${p.valor_unitario!=null?`<small>${brlc(p.valor_unitario)} por ${esc(p.unidade_medida||'unidade')}</small>`:''}</div>
   <div><span>Quantidade</span><b>${p.quantidade!=null?fmtN(p.quantidade,0):'—'}</b>${p.unidade_medida?`<small>${esc(p.unidade_medida)}</small>`:''}</div>
   <div><span>Data desejada</span><b>${d?dt(d+'T12:00:00'):'Não informada'}</b></div>
   <div><span>Classificação</span><b>${esc(p.classificacao_codigo||'—')}</b><small>${esc(p.classificacao_nome||'')}${p.codigo_item?` · item ${esc(p.codigo_item)}`:''}</small></div></div>
  <div class="lc-body"><p class="lc-why ${ok?'ok':'rev'}"><b>${ok?'Por que apareceu':'Por que pode interessar'}:</b> ${esc(p.motivo||'')}</p>
   ${p.licitacao_provavel_id?`<p class="lc-note"><span>↔</span><span>Provável licitação já publicada pelo mesmo órgão e na mesma linha: <a class="l" onclick="analisarViab(${p.licitacao_provavel_id})">${esc((p.licitacao_provavel_objeto||'').slice(0,120))}</a>. Vínculo inferido, não oficial.</span></p>`:''}
   <p class="ev-hint">Plano atualizado no PNCP em ${p.plano_atualizado_em?dt(p.plano_atualizado_em):'—'} · coletado em ${p.item_atualizado_em?dt(p.item_atualizado_em):'—'}.</p></div>
  <footer class="lc-acts"><div class="lc-l"></div><div class="lc-r"><a class="gh" href="${link}" target="_blank" rel="noopener">${ic('ext')}Ver plano no PNCP</a></div></footer></article>`;
}

// ------------------------------------------------------------------ licitações de interesse
TELAS.interesses='Licitações de interesse';
V.interesses=async()=>{
 const st=window.__INTF||'';
 const rows=await rpc('listar_interesses',{p_status:st||null});
 const n=k=>(rows||[]).filter(x=>x.status===k).length;
 main.innerHTML=`<div class="top"><div><h2>Licitações de interesse</h2><p class="sub">Avaliação interna da empresa. Estes estados não iniciam disputa nem criam processo.</p></div></div>
 <div class="ev-sub">${[['','Todas'],...Object.entries(ST_INT)].map(([k,r])=>`<button type="button" class="${k===st?'on':''}" onclick="window.__INTF='${k}';V.interesses()">${r}${k&&!st?` <span class="n">${n(k)}</span>`:''}</button>`).join('')}</div>
 <div class="ev-cards">${(rows||[]).map(intCard).join('')||pend('Nenhuma licitação de interesse ainda','',"Em Licitações, toque em “Analisar viabilidade” para salvar e analisar.")}</div>`;
};
function intCard(x){
 const d=dias(x.data_fim_proposta),r=x.resultado||{};
 return `<article class="lc"><header class="lc-h"><span></span><div><div class="lc-chips"><span class="chip ${ST_INT_COR[x.status]}">${ST_INT[x.status]}</span>${d!=null?`<span class="chip c-${prazoCor(d)}">${evi('clock')}${prazoTxt(d)}</span>`:''}${x.situacao&&x.situacao!=='Divulgada no PNCP'?`<span class="chip c-red">${esc(x.situacao)}</span>`:''}${x.mudancas&&x.mudancas.length?`<span class="chip c-amber">! Mudou: ${esc(x.mudancas.join(', '))}</span>`:''}</div>
 <h3 class="lc-obj">${esc(x.objeto||'')}</h3><div class="lc-org"><span>${evi('bank')}<b>${esc(x.orgao_nome||'')}</b></span><span>${evi('pin')}${esc([x.municipio,x.uf].filter(Boolean).join('/'))}</span></div></div><div></div></header>
 <div class="lc-facts"><div><span>Valor estimado</span><b class="mono">${x.valor_sigiloso?'Sigiloso':brl(x.valor_estimado)}</b></div><div><span>Propostas até</span><b>${dt(x.data_fim_proposta)}</b></div>
  <div><span>Última análise</span><b>${x.analisado_em?dt(x.analisado_em):'Ainda não salva'}</b>${r.recomendacao?`<small>${esc(r.recomendacao.tipo==='incompleta'?'Análise incompleta':r.recomendacao.tipo==='favoravel'?'Sem alerta crítico':'Com pontos de atenção')}</small>`:''}</div>
  <div><span>Margem estimada</span><b>${r.total&&r.total.margem!=null?pctFmt(r.total.margem):'—'}</b></div></div>
 ${x.mudancas&&x.mudancas.length?'<div class="lc-body"><p class="lc-note"><span>!</span><span>Os dados oficiais mudaram desde a última análise salva. Revise os pontos indicados.</span></p></div>':''}
 <footer class="lc-acts"><div class="lc-l">${x.link_pncp?`<a class="gh" href="${esc(x.link_pncp)}" target="_blank" rel="noopener">${ic('ext')}PNCP</a>`:''}</div><div class="lc-r"><button class="lc-go" onclick="ir('analise',{id:'${x.id}'})">Abrir análise</button></div></footer></article>`;
}

// ------------------------------------------------------------------ análise de viabilidade
TELAS.analise='Análise de viabilidade';
const AN_ABAS=[['resumo','1 · Oportunidade'],['itens','2 · Itens e lotes'],['custos','3 · Custos'],['preco','4 · Preço'],['cenarios','5 · Cenários e caixa'],['docs','6 · Documentos e riscos'],['resultado','7 · Resultado']];
V.analise=async()=>{
 const id=(window.ARG&&window.ARG.id)||window.__ANID;if(!id){ir('interesses');return;}window.__ANID=id;
 const {data:li,error}=await sb.from('licitacoes_interesse').select('*').eq('id',id).maybeSingle();
 if(error||!li){main.innerHTML=pend('Análise não encontrada','',"Ela pode ter sido criada em outra organização.");return;}
 const [{data:op},{data:itens},{data:an},linhas,{data:pjs},{data:co}]=await Promise.all([
  sb.from('oportunidades').select('id,numero_controle_pncp,objeto,orgao_nome,unidade_nome,uf,municipio,modalidade,modo_disputa,srp,valor_estimado,valor_sigiloso,data_publicacao,data_inicio_proposta,data_fim_proposta,situacao,link_pncp,atualizado_em,itens_em').eq('id',li.oportunidade_id).maybeSingle(),
  sb.from('oportunidade_itens').select('*').eq('oportunidade_id',li.oportunidade_id).order('numero_item'),
  sb.from('edital_analise').select('dados,fonte,analisado_em').eq('oportunidade_id',li.oportunidade_id).maybeSingle(),
  rpc('minha_linha').catch(()=>[]),
  sb.from('pessoas_juridicas').select('id,uf,municipio,razao_social').order('propria',{ascending:false}).limit(1),
  sb.from('correspondencias').select('confianca,motivo,evidencia').eq('fonte','licitacao').eq('ref_id',li.oportunidade_id).maybeSingle()]);
 const pj=(pjs||[])[0];
 // compatibilidade por item (código do item × linha), calculada aqui para orientar a seleção
 const cods=[...new Set((itens||[]).filter(i=>i.cat_codigo).map(i=>i.cat_codigo))];
 const {data:nos}=cods.length?await sb.from('cat_nos').select('tipo,nivel,codigo,caminho').in('codigo',cods):{data:[]};
 const no=(i)=>(nos||[]).find(n=>n.tipo===i.cat_tipo&&n.nivel===i.cat_nivel&&n.codigo===i.cat_codigo);
 const comp={};(itens||[]).forEach(i=>{const n=no(i);if(!n){comp[i.numero_item]=i.cat_codigo?'sem_no':'sem_codigo';return;}
  const bate=l=>l.tipo===i.cat_tipo&&n.caminho[l.nivel]===l.codigo;const inc=(linhas||[]).some(l=>l.modo==='incluir'&&bate(l)),exc=(linhas||[]).some(l=>l.modo==='excluir'&&bate(l));
  comp[i.numero_item]=exc?'excluido':inc?'compativel':'fora';});
 let docs=null;if(pj){docs=await habConferir(pj.id,op&&op.data_fim_proposta).catch(()=>null);}
 const P=Object.assign({sel:null,lotes:{},custo:{},imp:{},qtd:{},pct_receita:[{nome:'Tributos sobre a receita',pct:null,status:'estimado'}],regime:'',custos:[],margem_min:null,margem_desejada:null,preco_proposto:{},giro:{prazo_fornecedor:0,prazo_entrega:null,prazo_recebimento:null,atraso:0,taxa_mensal:null,parcelas:1},cenarios:JSON.parse(JSON.stringify(VIAB.CENARIOS_PADRAO)),conf:{}},li.premissas||{});
 if(!P.sel)P.sel=(li.itens_sel&&li.itens_sel.length)?li.itens_sel:(itens||[]).filter(i=>comp[i.numero_item]==='compativel').map(i=>i.numero_item);
 window.__AN={li,op,itens:itens||[],an,linhas:linhas||[],pj,co,comp,docs,P,aba:window.__AN&&window.__AN.li&&window.__AN.li.id===li.id?window.__AN.aba:'resumo'};
 anRender();
};
async function habConferir(pjId,dataRef){
 const [{data:cat},{data:he},{data:docs}]=await Promise.all([sb.from('hab_catalogo').select('codigo,nome,grupo,naturezas,obrigatorio,validade_dias,ordem').order('ordem'),sb.from('hab_empresas').select('natureza').eq('pessoa_juridica_id',pjId).maybeSingle(),sb.from('hab_documentos').select('codigo,valido_ate,arquivo_nome,criado_em').eq('pessoa_juridica_id',pjId).order('criado_em',{ascending:false})]);
 const nat=(he&&he.natureza)||null,ult={};(docs||[]).forEach(d=>{if(!ult[d.codigo])ult[d.codigo]=d;});
 const ref=(dataRef||new Date().toISOString()).slice(0,10),hoje=new Date().toISOString().slice(0,10);
 return (cat||[]).filter(c=>c.obrigatorio&&(!nat||c.naturezas.includes(nat))&&!(c.naturezas.length===1&&c.naturezas[0]==='pf')).map(c=>{const d=ult[c.codigo];
  const s=!d?'falta':d.valido_ate&&d.valido_ate<hoje?'vencido':d.valido_ate&&d.valido_ate<ref?'vence_antes':!d.valido_ate&&c.validade_dias?'sem_validade':'ok';
  return {codigo:c.codigo,nome:c.nome,grupo:c.grupo,s,valido_ate:d&&d.valido_ate};});
}
function anEntrada(){
 const A=window.__AN,P=A.P;
 return {itens:A.itens.filter(i=>P.sel.includes(i.numero_item)).map(i=>({n:i.numero_item,descricao:i.descricao,qtd:P.qtd[i.numero_item]??i.quantidade,ref:i.valor_unitario,custo:P.custo[i.numero_item],lote:P.lotes[i.numero_item]||'',importado_pct:P.imp[i.numero_item]})),
  pct_receita:P.pct_receita,custos:P.custos,margem_min:P.margem_min,margem_desejada:P.margem_desejada,preco_proposto:P.preco_proposto,giro:P.giro};
}
function anCalc(){const A=window.__AN,E=anEntrada();const r=VIAB.calcular(E);const cen=r.erros.length?null:VIAB.cenarios(E,A.P.cenarios);const sens=r.erros.length||r.incompleta?[]:VIAB.sensibilidade(E);
 const docsPend=(A.docs||[]).filter(d=>d.s!=='ok').length;return {E,r,cen,sens,rec:VIAB.recomendacao(r,cen,docsPend),docsPend};}
const nIn=(path,v,extra='')=>`<input type="number" step="any" inputmode="decimal" data-p="${path}" value="${v==null?'':v}" onchange="anSet(this)" ${extra}>`;
function anSet(el){
 const A=window.__AN,P=A.P,path=el.dataset.p.split('.');let v=el.type==='checkbox'?el.checked:el.value;
 if(el.type==='number')v=v===''?null:Number(v);
 let o=P;for(let i=0;i<path.length-1;i++){const k=isNaN(path[i])?path[i]:Number(path[i]);if(o[k]==null)o[k]={};o=o[k];}
 const k=path[path.length-1];o[isNaN(k)?k:Number(k)]=v;window.__AN.sujo=true;anRender();
}
function anSel(n,on){const P=window.__AN.P;P.sel=on?[...new Set([...P.sel,n])]:P.sel.filter(x=>x!==n);window.__AN.sujo=true;anRender();}
function anSelTodos(modo){const A=window.__AN;A.P.sel=modo==='nenhum'?[]:A.itens.filter(i=>modo==='todos'||A.comp[i.numero_item]==='compativel').map(i=>i.numero_item);A.sujo=true;anRender();}
function anAddCusto(){const P=window.__AN.P;P.custos.push({id:Date.now(),categoria:'Frete',descricao:'',base:'fixo',valor:null,status:'estimado',alvo:{tipo:'todos'},rateio:'valor'});window.__AN.sujo=true;anRender();}
function anDelCusto(i){window.__AN.P.custos.splice(i,1);window.__AN.sujo=true;anRender();}
function anAddPct(){window.__AN.P.pct_receita.push({nome:'Outro percentual sobre a receita',pct:null,status:'estimado'});window.__AN.sujo=true;anRender();}
function anDelPct(i){window.__AN.P.pct_receita.splice(i,1);window.__AN.sujo=true;anRender();}
function anAba(k){window.__AN.aba=k;anRender();scrollTo(0,0);}
function anRender(){
 const A=window.__AN,{op,P}=A,C=anCalc(),r=C.r;
 const d=dias(op&&op.data_fim_proposta);
 const st=r.erros.length?['c-red','Premissas inconsistentes']:r.incompleta?['c-amber','Análise incompleta']:['c-green','Análise completa'];
 main.innerHTML=`<div class="top"><div><h2>Análise de viabilidade</h2><p class="sub">${esc((op&&op.objeto||'').slice(0,180))}</p></div><div class="ev-actions" style="margin:0"><span class="chip ${ST_INT_COR[A.li.status]}">${ST_INT[A.li.status]}</span></div></div>
 <div class="an-bar"><div><span>Custo estimado</span><b>${brl(r.total.custo)}</b></div><div><span>Preço mínimo (total)</span><b>${brl(r.total.minimo)}</b></div><div><span>Proposta</span><b>${brl(r.total.receita)}</b></div><div><span>Margem</span><b>${pctFmt(r.total.margem)}</b></div><div><span>Necessidade de caixa</span><b>${r.giro.ok?brl(r.giro.necessidade):'—'}</b></div>
  <div class="an-st"><span class="chip ${st[0]}">${st[1]}</span><button onclick="anSalvar()" ${A.sujo?'':'class="sec"'}>${A.sujo?'Salvar análise':'Salva'}</button></div></div>
 <div class="ev-tabs an-tabs" role="tablist">${AN_ABAS.map(([k,rt])=>`<button type="button" class="${A.aba===k?'on':''}" onclick="anAba('${k}')">${rt}${k==='docs'&&C.docsPend?`<span class="n c-red">${C.docsPend}</span>`:''}${k==='resultado'&&r.pendencias.length?`<span class="n c-amber">${r.pendencias.length}</span>`:''}</button>`).join('')}</div>
 <div class="an-pane">${({resumo:anResumo,itens:anItens,custos:anCustos,preco:anPreco,cenarios:anCenarios,docs:anDocs,resultado:anResultado})[A.aba](C)}</div>
 <div class="ev-actions an-nav">${(()=>{const i=AN_ABAS.findIndex(x=>x[0]===A.aba);return `${i>0?`<button class="sec" onclick="anAba('${AN_ABAS[i-1][0]}')">← ${AN_ABAS[i-1][1].replace(/^\d · /,'')}</button>`:'<span></span>'}${i<AN_ABAS.length-1?`<button onclick="anAba('${AN_ABAS[i+1][0]}')">${AN_ABAS[i+1][1].replace(/^\d · /,'')} →</button>`:''}`;})()}</div>`;
}
function anResumo(){
 const A=window.__AN,op=A.op||{},d=dias(op.data_fim_proposta),an=A.an,D=an&&an.dados||{};
 const ia=(k,r)=>D[k]!=null&&D[k]!==''&&!(Array.isArray(D[k])&&!D[k].length)?`<div><span>${r}</span><b>${esc(typeof D[k]==='object'?JSON.stringify(D[k]):String(D[k]===true?'Sim':D[k]===false?'Não':D[k]))}</b></div>`:'';
 const tot=A.itens.reduce((a,i)=>a+Number(i.valor_total||0),0);
 return `<div class="card"><h3>Dados oficiais (PNCP)</h3><div class="dkv">
  <div><span>Órgão</span><b>${esc(op.orgao_nome||'—')}</b>${op.unidade_nome?`<small>${esc(op.unidade_nome)}</small>`:''}</div>
  <div><span>Local</span><b>${esc([op.municipio,op.uf].filter(Boolean).join('/')||'—')}</b></div>
  <div><span>Modalidade</span><b>${esc(op.modalidade||'—')}</b>${op.modo_disputa?`<small>${esc(op.modo_disputa)}</small>`:''}</div>
  <div><span>Situação</span><b>${esc(op.situacao||'—')}</b><small>conferida em ${op.atualizado_em?dt(op.atualizado_em):'—'}</small></div>
  <div><span>Propostas até</span><b>${op.data_fim_proposta?dt(op.data_fim_proposta)+' '+new Date(op.data_fim_proposta).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'Não informado'}</b>${d!=null?`<small class="v-${prazoCor(d)}">${prazoTxt(d)}</small>`:''}</div>
  <div><span>Valor estimado</span><b>${op.valor_sigiloso?'Sigiloso':brl(op.valor_estimado)}</b></div>
  <div><span>Itens</span><b>${A.itens.length||'Não lidos ainda'}</b>${A.itens.length?`<small>soma ${brl(tot)}</small>`:''}</div>
  <div><span>Registro de preços</span><b>${op.srp==null?'—':op.srp?'Sim':'Não'}</b></div></div>
  ${A.co?`<p class="lc-why ${A.co.confianca==='confirmada'?'ok':'rev'}"><b>Aderência à linha:</b> ${esc(A.co.motivo)}</p>`:'<p class="lc-why rev"><b>Aderência à linha:</b> esta licitação não foi encontrada pela sua linha de fornecimento (veio de perfil ou pesquisa ampla).</p>'}
  ${op.link_pncp?`<p><a class="l" href="${esc(op.link_pncp)}" target="_blank" rel="noopener">Abrir no PNCP (edital e anexos) ↗</a></p>`:''}</div>
 <div class="card"><h3>Condições lidas no edital ${an?`<small class="aib-t">IA</small>`:''}</h3>
  ${an?`<p class="ev-hint">${AI()} Extraído por IA ${an.fonte==='edital'?'do texto do edital':'só do objeto (o edital não pôde ser lido)'} em ${dt(an.analisado_em)}. A extração não informa página ou trecho; confira cada ponto no documento oficial.</p>
   <div class="dkv">${ia('criterio_julgamento','Critério de julgamento')}${ia('prazo_entrega','Prazo de entrega')}${ia('local_entrega','Local de entrega')}${ia('pagamento','Pagamento')}${ia('vigencia','Vigência')}${ia('garantia','Garantia exigida')}${ia('exige_amostra','Exige amostra')}${ia('exige_visita_tecnica','Exige visita técnica')}${ia('exclusivo_me_epp','Exclusivo ME/EPP')}</div>${(()=>{const f=[['prazo_entrega','prazo de entrega'],['vigencia','vigência'],['garantia','garantia exigida'],['criterio_julgamento','critério de julgamento'],['local_entrega','local de entrega'],['pagamento','pagamento']].filter(([k])=>D[k]==null||D[k]===''||(Array.isArray(D[k])&&!D[k].length)).map(x=>x[1]);return f.length?`<p class="ev-hint">A IA não encontrou no edital: ${f.join(', ')}. Confira no documento.</p>`:'';})()}`
  :`<p class="sub">O edital ainda não foi lido por IA. Sem essa leitura, prazos, pagamento e exigências ficam como pendências para você conferir no documento.</p>${pode('ia')?`<button class="sec" onclick="anLerEdital(this)">${AI()} Ler o edital com IA</button>`:''}`}</div>`;
}
async function anLerEdital(btn){btn.disabled=true;btn.textContent='Lendo o edital… (pode levar 1 minuto)';
 try{const tk=(await sb.auth.getSession()).data.session.access_token;const r=await fetch('/api/ia',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'analisar',oportunidade_id:window.__AN.op.id})}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);toast('Edital lido');V.analise();}catch(e){btn.disabled=false;btn.textContent='Ler o edital com IA';toast(e.message);}}
function anItens(){
 const A=window.__AN,P=A.P;
 if(!A.itens.length)return `<div class="card">${pend('Os itens desta licitação ainda não foram lidos do PNCP','',"A leitura acontece na próxima coleta. Enquanto isso, confira os itens no edital.")}</div>`;
 const CMP={compativel:['c-green','✓ Na sua linha'],fora:['c-mut','Fora da linha'],excluido:['c-red','Você marcou que não fornece'],sem_codigo:['c-amber','Sem código de catálogo'],sem_no:['c-amber','Código ainda não conferido']};
 const lotes=[...new Set(Object.values(P.lotes).filter(Boolean))];
 return `<div class="card"><h3>Itens a avaliar</h3><p class="sub">Marque os itens que pretende cotar. A aderência de um item não significa aderência da licitação inteira. A API do PNCP não informa lotes: se o edital agrupar itens em lote, informe o lote de cada item (itens de um lote precisam ser cotados juntos).</p>
 <div class="ev-actions" style="margin-top:0"><button class="sec sm" onclick="anSelTodos('linha')">Só os da minha linha</button><button class="sec sm" onclick="anSelTodos('todos')">Todos</button><button class="sec sm" onclick="anSelTodos('nenhum')">Nenhum</button></div>
 <div class="tbw"><table class="tb an-tb"><thead><tr><th></th><th>Item</th><th>Descrição</th><th>Qtd.</th><th>Ref. unitária</th><th>Linha</th><th>Lote</th></tr></thead><tbody>
 ${A.itens.map(i=>{const c=CMP[A.comp[i.numero_item]]||CMP.sem_codigo,on=P.sel.includes(i.numero_item);return `<tr class="${on?'on':''}"><td><input type="checkbox" style="width:auto" ${on?'checked':''} onchange="anSel(${i.numero_item},this.checked)" aria-label="Avaliar item ${i.numero_item}"></td><td>${i.numero_item}</td><td>${esc((i.descricao||'').slice(0,160))}${i.cat_codigo?`<small class="lf-cam">${i.cat_tipo==='M'?'CATMAT':'CATSER'} ${esc(i.cat_codigo)}</small>`:''}${i.situacao&&i.situacao!=='Em andamento'?`<small class="v-amber">${esc(i.situacao)}</small>`:''}</td>
  <td>${fmtN(i.quantidade,2)} ${esc(i.unidade||'')}</td><td>${i.sigiloso?'Sigiloso':brlc(i.valor_unitario)}</td><td><span class="chip ${c[0]}">${c[1]}</span></td>
  <td><input list="anlotes" value="${esc(P.lotes[i.numero_item]||'')}" data-p="lotes.${i.numero_item}" onchange="anSet(this)" placeholder="—" style="min-width:90px"></td></tr>`;}).join('')}
 </tbody></table></div><datalist id="anlotes">${lotes.map(l=>`<option value="${esc(l)}">`).join('')}</datalist>
 ${(()=>{const fl=lotes.filter(l=>A.itens.some(i=>P.lotes[i.numero_item]===l&&P.sel.includes(i.numero_item))&&A.itens.some(i=>P.lotes[i.numero_item]===l&&!P.sel.includes(i.numero_item)));return fl.length?`<p class="lc-note"><span>!</span><span>Lote(s) ${esc(fl.join(', '))} com itens fora da seleção: em geral o lote inteiro precisa ser cotado.</span></p>`:'';})()}</div>`;
}
function anCustos(C){
 const A=window.__AN,P=A.P,sel=A.itens.filter(i=>P.sel.includes(i.numero_item));
 if(!sel.length)return `<div class="card">${pend('Selecione os itens primeiro',`<button onclick="anAba('itens')">Ir para itens</button>`)}</div>`;
 const lotes=[...new Set(sel.map(i=>P.lotes[i.numero_item]).filter(Boolean))];
 const stSel=(path,v)=>`<select data-p="${path}" onchange="anSet(this)"><option value="estimado" ${v!=='confirmado'?'selected':''}>Estimado</option><option value="confirmado" ${v==='confirmado'?'selected':''}>Confirmado</option></select>`;
 return `<div class="card"><h3>Custo direto por item</h3><p class="sub">Custo de aquisição (material) ou de execução (serviço) por unidade. <b>Campo vazio não é zero</b>: fica como pendência.</p>
 <div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Descrição</th><th>Qtd. considerada</th><th>Custo unitário (R$)</th><th>Situação</th><th>% importado</th></tr></thead><tbody>
 ${sel.map(i=>`<tr><td>${i.numero_item}</td><td>${esc((i.descricao||'').slice(0,90))}</td><td>${nIn('qtd.'+i.numero_item,P.qtd[i.numero_item]??i.quantidade,'min="0"')}</td><td>${nIn('custo.'+i.numero_item,P.custo[i.numero_item],'min="0" placeholder="informe"')}</td><td>${stSel('conf.'+i.numero_item,P.conf[i.numero_item])}</td><td>${nIn('imp.'+i.numero_item,P.imp[i.numero_item],'min="0" max="100" placeholder="0"')}</td></tr>`).join('')}
 </tbody></table></div><p class="ev-hint">% importado: parcela do custo sujeita a câmbio (usada nos cenários).</p></div>
 <div class="card"><h3>Outros custos</h3><p class="sub">Cada custo entra uma vez. <b>Fixo</b>: um valor rateado entre os itens; <b>por unidade</b>: soma ao custo de cada unidade; <b>por lote</b>: um valor para cada lote; <b>% sobre a receita</b>: incide sobre o preço de venda.</p>
 ${P.custos.length?P.custos.map((l,k)=>`<div class="an-custo"><div><label>Categoria</label><select data-p="custos.${k}.categoria" onchange="anSet(this)">${VIAB.CATEGORIAS.map(c=>`<option ${c===l.categoria?'selected':''}>${c}</option>`).join('')}</select></div>
  <div><label>Descrição</label><input data-p="custos.${k}.descricao" value="${esc(l.descricao||'')}" onchange="anSet(this)"></div>
  <div><label>Como incide</label><select data-p="custos.${k}.base" onchange="anSet(this)">${Object.entries(VIAB.BASES).map(([b,r])=>`<option value="${b}" ${b===l.base?'selected':''}>${r}</option>`).join('')}</select></div>
  <div><label>${l.base==='pct_receita'?'Percentual (%)':'Valor (R$)'}</label>${nIn(`custos.${k}.valor`,l.valor,'min="0" placeholder="informe"')}</div>
  <div><label>Aplica a</label><select data-p="custos.${k}.alvo.tipo" onchange="anSet(this)"><option value="todos" ${(l.alvo||{}).tipo==='todos'?'selected':''}>Todos os itens</option>${lotes.length?`<option value="lote" ${(l.alvo||{}).tipo==='lote'?'selected':''}>Um lote</option>`:''}<option value="item" ${(l.alvo||{}).tipo==='item'?'selected':''}>Um item</option></select></div>
  ${(l.alvo||{}).tipo==='lote'?`<div><label>Lote</label><select data-p="custos.${k}.alvo.ref" onchange="anSet(this)">${lotes.map(x=>`<option ${x===l.alvo.ref?'selected':''}>${esc(x)}</option>`).join('')}</select></div>`:''}
  ${(l.alvo||{}).tipo==='item'?`<div><label>Item</label><select data-p="custos.${k}.alvo.ref" onchange="anSet(this)">${sel.map(i=>`<option value="${i.numero_item}" ${String(i.numero_item)===String(l.alvo.ref)?'selected':''}>${i.numero_item}</option>`).join('')}</select></div>`:''}
  ${['fixo','lote'].includes(l.base)?`<div><label>Rateio</label><select data-p="custos.${k}.rateio" onchange="anSet(this)"><option value="valor" ${l.rateio==='valor'?'selected':''}>Pelo valor de referência</option><option value="quantidade" ${l.rateio==='quantidade'?'selected':''}>Pela quantidade</option><option value="igual" ${l.rateio==='igual'?'selected':''}>Igual entre itens</option></select></div>`:''}
  <div><label>Situação</label>${stSel(`custos.${k}.status`,l.status)}</div><div class="an-del"><button class="sec sm" onclick="anDelCusto(${k})" aria-label="Remover custo">Remover</button></div></div>`).join(''):'<p class="ev-hint">Nenhum outro custo informado. Frete, seguro, embalagem, instalação, garantia, despesas administrativas e contingências costumam existir.</p>'}
 <div class="ev-actions"><button class="sec" onclick="anAddCusto()">+ Adicionar custo</button></div>
 ${C.r.avisos.filter(a=>a.includes('dupla')||a.includes('nenhum item')).map(a=>`<p class="lc-note"><span>!</span><span>${esc(a)}</span></p>`).join('')}</div>`;
}
function anPreco(C){
 const A=window.__AN,P=A.P,r=C.r;
 return `<div class="card"><h3>Tributos e percentuais sobre a receita</h3><p class="sub">Informe os percentuais do seu regime tributário sobre o faturamento. O sistema <b>não presume alíquotas pelo CNPJ</b>. Zero é aceito quando de fato não houver.</p>
 <div class="ev-form"><div style="grid-column:1/-1"><label>Regime tributário (anotação)</label><input data-p="regime" value="${esc(P.regime||'')}" onchange="anSet(this)" placeholder="Ex.: Simples Nacional, Anexo I, faixa 3"></div></div>
 ${P.pct_receita.map((p,k)=>`<div class="an-custo"><div><label>Nome</label><input data-p="pct_receita.${k}.nome" value="${esc(p.nome||'')}" onchange="anSet(this)"></div><div><label>Percentual (%)</label>${nIn(`pct_receita.${k}.pct`,p.pct,'min="0" max="99.99" placeholder="informe"')}</div><div><label>Situação</label><select data-p="pct_receita.${k}.status" onchange="anSet(this)"><option value="estimado" ${p.status!=='confirmado'?'selected':''}>Estimado</option><option value="confirmado" ${p.status==='confirmado'?'selected':''}>Confirmado</option></select></div><div class="an-del"><button class="sec sm" onclick="anDelPct(${k})">Remover</button></div></div>`).join('')}
 <div class="ev-actions"><button class="sec sm" onclick="anAddPct()">+ Outro percentual sobre a receita</button></div></div>
 <div class="card"><h3>Margem</h3><p class="sub"><b>Margem</b> é o lucro sobre o preço de venda (receita). <b>Markup</b> é o acréscimo sobre o custo. Ex.: custo 100 vendido a 125 → markup 25%, margem 20% (antes dos tributos).</p>
 <div class="ev-form"><div><label>Margem mínima aceitável (%)</label>${nIn('margem_min',P.margem_min,'placeholder="informe"')}</div><div><label>Margem desejada (%)</label>${nIn('margem_desejada',P.margem_desejada,'placeholder="informe"')}</div></div>
 <p class="ev-hint">Fórmula usada: <b>preço = custo unitário considerado ÷ (1 − percentuais sobre a receita − margem)</b>. Custo considerado = custo direto + custos por unidade + rateio dos custos fixos e por lote. Preços arredondados para cima no centavo, para não perder margem; totais = preço unitário × quantidade.</p></div>
 ${r.erros.map(e=>`<p class="lc-note bad"><span>!</span><span>${esc(e)}</span></p>`).join('')}
 <div class="card"><h3>Formação de preço por item</h3><div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Custo unit.</th><th>% receita</th><th>Equilíbrio</th><th>Mínimo</th><th>Sugerido</th><th>Preço proposto</th><th>Ref.</th><th>Desconto máx.</th><th>Lucro</th><th>Margem</th><th>Markup</th></tr></thead><tbody>
 ${r.itens.map(i=>`<tr><td>${i.n}</td><td>${brlc(i.custo_unit)}</td><td>${pctFmt(i.pct_receita)}</td><td>${brlc(i.preco_equilibrio)}</td><td><b>${brlc(i.preco_min)}</b></td><td>${brlc(i.preco_sugerido)}</td><td>${nIn('preco_proposto.'+i.n,P.preco_proposto[i.n],`placeholder="${i.preco_sugerido??''}" min="0"`)}</td><td>${i.ref?brlc(i.ref):'—'}</td><td class="${i.desconto_max<0?'v-red':''}">${i.desconto_max==null?'—':pctFmt(i.desconto_max)}</td><td>${brlc(i.lucro)}</td><td>${pctFmt(i.margem)}</td><td>${pctFmt(i.markup)}</td></tr>`).join('')}
 </tbody><tfoot><tr><th colspan="6">Total</th><th>${brlc(r.total.receita)}</th><th>${brlc(r.total.referencia)}</th><th></th><th>${brlc(r.total.lucro)}</th><th>${pctFmt(r.total.margem)}</th><th>${pctFmt(r.total.markup)}</th></tr></tfoot></table></div>
 <p class="ev-hint">Preço proposto vazio = preço sugerido. Desconto máximo = quanto abaixo da referência dá para chegar sem passar do preço mínimo (negativo: o mínimo já está acima da referência).</p></div>`;
}
function anCenarios(C){
 const A=window.__AN,P=A.P,r=C.r,G=P.giro;
 const CEN=[['custo','Custo de aquisição (%)'],['frete','Frete (%)'],['qtd','Quantidade (%)'],['cambio','Câmbio (%) na parcela importada'],['entrega','Prazo de entrega (+ dias)'],['receb','Prazo de recebimento (+ dias)'],['atraso','Atraso de pagamento (+ dias)']];
 return `<div class="card"><h3>Prazos e caixa</h3><p class="sub">Necessidade de caixa é quanto você precisa ter antes de receber. Custo financeiro é o custo desse dinheiro no período; são coisas diferentes.</p>
 <div class="ev-form"><div><label>Prazo para pagar o fornecedor (dias)</label>${nIn('giro.prazo_fornecedor',G.prazo_fornecedor,'min="0"')}</div><div><label>Prazo de entrega/execução (dias)</label>${nIn('giro.prazo_entrega',G.prazo_entrega,'min="0" placeholder="informe"')}</div>
 <div><label>Prazo de pagamento do órgão após a entrega (dias)</label>${nIn('giro.prazo_recebimento',G.prazo_recebimento,'min="0" placeholder="informe"')}</div><div><label>Atraso esperado no pagamento (dias)</label>${nIn('giro.atraso',G.atraso,'min="0"')}</div>
 <div><label>Entregas parceladas (nº)</label>${nIn('giro.parcelas',G.parcelas,'min="1" step="1"')}</div><div><label>Custo do dinheiro (% ao mês)</label>${nIn('giro.taxa_mensal',G.taxa_mensal,'min="0" placeholder="informe"')}</div></div>
 ${r.giro.ok?`<div class="dkv"><div><span>Necessidade de caixa</span><b>${brl(r.giro.necessidade)}</b></div><div><span>Custo financeiro</span><b>${r.giro.custo_financeiro==null?'Informe a taxa':brl(r.giro.custo_financeiro)}</b></div><div><span>Período de exposição</span><b>${r.giro.dias_exposicao} dias</b></div></div>`:'<p class="ev-hint">Informe prazo de entrega e prazo de pagamento do órgão para calcular.</p>'}</div>
 <div class="card"><h3>Cenários</h3><p class="sub">O preço da proposta fica fixo e as premissas variam. Edite as variações de cada cenário.</p>
 <div class="tbw"><table class="tb an-tb"><thead><tr><th>Premissa</th>${['conservador','base','otimista'].map(k=>`<th>${k[0].toUpperCase()+k.slice(1)}</th>`).join('')}</tr></thead><tbody>
 ${CEN.map(([k,rt])=>`<tr><td>${rt}</td>${['conservador','base','otimista'].map(c=>`<td>${nIn(`cenarios.${c}.${k}`,P.cenarios[c][k])}</td>`).join('')}</tr>`).join('')}
 </tbody><tfoot>${C.cen?[['Lucro','lucro',brl],['Margem','margem',pctFmt],['Necessidade de caixa','giro',v=>v==null?'—':brl(v)],['Custo financeiro','custo_financeiro',v=>v==null?'—':brl(v)]].map(([rt,k,f])=>`<tr><th>${rt}</th>${['conservador','base','otimista'].map(c=>`<th class="${k==='lucro'&&C.cen[c].lucro<0?'v-red':''}">${f(C.cen[c][k])}</th>`).join('')}</tr>`).join(''):'<tr><td colspan="4">Corrija as premissas para ver os cenários.</td></tr>'}</tfoot></table></div></div>
 ${C.sens.length?`<div class="card"><h3>O que mais pesa no resultado</h3><p class="sub">Efeito de cada variação sobre o lucro e o caixa, mantendo o preço.</p><div class="an-sens">${C.sens.map(s=>{const mx=Math.max(...C.sens.map(x=>Math.abs(x.d_lucro)))||1;return `<div><span>${esc(s.premissa)}</span><i style="--w:${Math.round(Math.abs(s.d_lucro)/mx*100)}%" class="${s.d_lucro<0?'neg':'pos'}"></i><b>${brl(s.d_lucro)}</b><small>${s.d_giro?'caixa '+(s.d_giro>0?'+':'')+brl(s.d_giro):''}</small></div>`;}).join('')}</div></div>`:''}`;
}
function anDocs(C){
 const A=window.__AN,an=A.an,D=an&&an.dados||{},H=D.habilitacao||{},op=A.op||{};
 const S={ok:['c-green','✓','Anexado e válido na data'],falta:['c-red','!','Não anexado'],vencido:['c-red','!','Vencido'],vence_antes:['c-amber','!','Vence antes da sessão'],sem_validade:['c-amber','?','Anexado sem data de validade']};
 const r=C.r,ris=[];
 if(A.pj&&op.uf&&A.pj.uf&&A.pj.uf!==op.uf)ris.push(['Logística',`Entrega em ${op.uf}, fora da UF da empresa (${A.pj.uf}): confira frete, prazo e quem arca com o transporte.`]);
 if(D.local_entrega)ris.push(['Logística',`Local de entrega (lido por IA): ${String(D.local_entrega).slice(0,200)}`]);
 if(r.giro.ok&&r.total.receita>0&&r.giro.necessidade>0.5*r.total.receita)ris.push(['Financeiro',`A necessidade de caixa (${brl(r.giro.necessidade)}) passa de metade da receita prevista.`]);
 if(C.cen&&C.cen.conservador.lucro<0)ris.push(['Comercial',`Prejuízo de ${brl(-C.cen.conservador.lucro)} no cenário conservador.`]);
 r.itens.filter(i=>i.desconto_max<0).forEach(i=>ris.push(['Comercial',`Item ${i.n}: preço mínimo acima da referência do órgão.`]));
 if(op.valor_sigiloso)ris.push(['Comercial','Valor estimado sigiloso: não há referência para comparar o preço.']);
 if(op.situacao&&op.situacao!=='Divulgada no PNCP')ris.push(['Situação',`Situação no PNCP: ${op.situacao}.`]);
 const conf=[...(P=>[...P.custos.filter(l=>l.status!=='confirmado').map(l=>`Custo estimado: ${l.categoria}${l.descricao?' – '+l.descricao:''}`),...P.pct_receita.filter(p=>p.status!=='confirmado').map(p=>`Percentual estimado: ${p.nome}`),...Object.keys(P.custo).filter(n=>P.sel.includes(Number(n))&&P.conf[n]!=='confirmado'&&P.custo[n]!=null).map(n=>`Custo direto do item ${n} estimado`)])(A.P),...(an?['Exigências e condições lidas por IA (confirmar no edital)']:[])];
 return `<div class="card"><h3>Documentos da empresa × data da sessão</h3><p class="sub">Conferência dos documentos obrigatórios anexados em Habilitação com validade até ${op.data_fim_proposta?dt(op.data_fim_proposta):'—'}. É uma verificação de cadastro, <b>não um parecer de habilitação</b>.</p>
  ${A.docs?A.docs.map(d=>{const s=S[d.s];return `<div class="hdoc" style="padding:9px 0"><div class="hdoc-st ${s[0]}">${s[1]}</div><div><div class="hdoc-nm">${esc(d.nome)}</div>${d.valido_ate?`<div class="hdoc-meta">válido até ${dt(d.valido_ate+'T12:00:00')}</div>`:''}</div><div class="hdoc-ac"><span class="chip ${s[0]}">${s[2]}</span></div></div>`;}).join('')+`<div class="ev-actions"><button class="sec" onclick="ir('habilitacao')">Abrir Habilitação</button></div>`:'<p class="ev-hint">Cadastre a empresa para conferir os documentos.</p>'}</div>
 <div class="card"><h3>Exigências deste edital ${an?'<small class="aib-t">IA</small>':''}</h3>
  ${an&&Object.keys(H).length?`<p class="ev-hint">${AI()} Lidas por IA ${an.fonte==='edital'?'do edital':'do objeto'}; a extração não traz página ou trecho. Confira no documento.</p><div class="dex">${Object.entries(H).map(([g,l])=>Array.isArray(l)&&l.length?`<div><h5>${esc(g.replace(/_/g,' '))}</h5><ul>${l.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'').join('')}</div>`:'<p class="sub">Sem leitura do edital por IA: confira as exigências de habilitação e técnicas no documento oficial.</p>'}
  ${an&&(D.riscos||[]).length?`<h4>Pontos de atenção lidos no edital</h4>${D.riscos.map(z=>`<p class="lc-note"><span>!</span><span><b>${esc(z.tema||'')}</b> ${esc(z.descricao||'')}</span></p>`).join('')}`:''}</div>
 <div class="card"><h3>Riscos identificados</h3>${ris.length?ris.map(([t,x])=>`<p class="lc-note"><span>!</span><span><b>${t}:</b> ${esc(x)}</span></p>`).join(''):'<p class="ev-hint">Nenhum risco automático com as premissas atuais.</p>'}</div>
 <div class="card"><h3>Depende de confirmação</h3>${conf.length?`<ul class="an-ul">${conf.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<p class="ev-hint">Nada marcado como estimado.</p>'}</div>`;
}
function anResultado(C){
 const A=window.__AN,r=C.r,rec=C.rec;
 const TIPO={incompleta:['c-amber','Análise incompleta'],erro:['c-red','Premissas inconsistentes'],atencao:['c-amber','Com pontos de atenção'],favoravel:['c-green','Sem alerta crítico']}[rec.tipo];
 return `<div class="card"><h3>Resumo</h3><div class="dkv">
  <div><span>Aderência à linha</span><b>${A.co?(A.co.confianca==='confirmada'?'Confirmada':'Possível (revisar)'):'Não encontrada pela linha'}</b><small>${A.P.sel.length} de ${A.itens.length} itens avaliados</small></div>
  <div><span>Pendências documentais</span><b>${C.docsPend}</b></div><div><span>Custo estimado</span><b>${brl(r.total.custo)}</b></div>
  <div><span>Preço mínimo</span><b>${brl(r.total.minimo)}</b></div><div><span>Preço proposto</span><b>${brl(r.total.receita)}</b></div><div><span>Margem</span><b>${pctFmt(r.total.margem)}</b></div>
  <div><span>Necessidade de caixa</span><b>${r.giro.ok?brl(r.giro.necessidade):'—'}</b></div><div><span>Referência do órgão</span><b>${brl(r.total.referencia)}</b></div></div></div>
 <div class="card an-rec"><span class="chip ${TIPO[0]}">${TIPO[1]}</span><p>${esc(rec.texto)}</p><p class="ev-hint">O sistema não estima chance de vitória. A decisão é sua.</p></div>
 ${r.pendencias.length?`<div class="card"><h3>Informações faltantes</h3><ul class="an-ul">${r.pendencias.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>`:''}
 ${r.avisos.length?`<div class="card"><h3>Avisos</h3><ul class="an-ul">${r.avisos.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>`:''}
 <div class="card"><h3>Sua decisão</h3><textarea id="andec" rows="2" placeholder="Observação (opcional)">${esc(A.li.decisao_obs||'')}</textarea>
 <div class="ev-actions"><button onclick="anDecidir('viavel')">Considerar viável</button><button class="sec" onclick="anDecidir('inviavel')">Considerar inviável</button><button class="sec" onclick="anDecidir('arquivada')">Arquivar</button><button class="sec" onclick="anDecidir('em_analise')">Manter em análise</button></div>
 <p class="ev-hint">Estes estados são internos: não iniciam disputa nem criam processo.</p></div>`;
}
async function anSalvar(silencioso){
 const A=window.__AN,C=anCalc();
 const res={total:C.r.total,giro:C.r.giro.ok?{necessidade:C.r.giro.necessidade,custo_financeiro:C.r.giro.custo_financeiro}:null,cenarios:C.cen,recomendacao:C.rec,pendencias:C.r.pendencias,itens:C.r.itens.map(i=>({n:i.n,custo_unit:i.custo_unit,preco_min:i.preco_min,preco:i.preco,margem:i.margem})),calculado_em:new Date().toISOString(),versao_calculo:1};
 try{await rpc('salvar_viabilidade',{p_id:A.li.id,p_itens:A.P.sel,p_lotes:Object.entries(A.P.lotes).filter(([,v])=>v).map(([n,l])=>({n:Number(n),lote:l})),p_premissas:A.P,p_resultado:res});
  A.sujo=false;if(!silencioso){toast('Análise salva');anRender();}}catch(e){toast(e.message);throw e;}
}
async function anDecidir(s){const A=window.__AN;try{if(A.sujo)await anSalvar(true);await rpc('decidir_interesse',{p_id:A.li.id,p_status:s,p_obs:$('#andec')?$('#andec').value:null});A.li.status=s;A.sujo=false;toast('Situação: '+ST_INT[s]);anRender();}catch(e){toast(e.message);}}

// ------------------------------------------------------------------ habilitação: cards por categoria, com situação clara
const HAB_EST={nao_iniciado:['c-mut','○','Não iniciado'],preenchendo:['c-blue','◐','Em preenchimento'],revisao:['c-amber','?','Pendente de revisão'],completo:['c-green','✓','Completo no cadastro'],vencido:['c-red','!','Documento vencido'],edital:['c-mut','·','Conforme o edital']};
V.habilitacao=async()=>{
 const [{data:pjs},{data:pfs}]=await Promise.all([sb.from('pessoas_juridicas').select('id,cnpj,razao_social,uf,municipio,propria').order('propria',{ascending:false}),sb.from('pessoas_fisicas').select('id,cpf,nome,uf,municipio').order('nome')]);
 const sujeitos=[...(pjs||[]).map(x=>({...x,tipo:'pj',nome:x.razao_social,doc:x.cnpj})),...(pfs||[]).map(x=>({...x,tipo:'pf',doc:x.cpf}))];
 const topo=`<div class="top"><div><h2>Habilitação</h2><p class="sub">Organização geral dos documentos da empresa. A conferência de cada licitação acontece na análise de viabilidade.</p></div></div>`;
 if(!sujeitos.length){main.innerHTML=topo+pend('Cadastre a empresa primeiro',`<button onclick="ir('organizacao')">Minha organização</button>`);return;}
 const pjI=(pjs||[]).find(x=>x.propria)||(pjs||[])[0];const sel=(window.ARG&&window.ARG.sujeito)||window.__HABSEL||(pjI?'pj:'+pjI.id:'pf:'+pfs[0].id);const [tp,pid]=sel.split(':');
 const sj=sujeitos.find(x=>x.id===pid&&x.tipo===tp)||sujeitos[0];window.__HABSEL=sj.tipo+':'+sj.id;
 const ch=sj.tipo==='pf'?'pessoa_fisica_id':'pessoa_juridica_id';
 const [{data:cat},{data:he},{data:docs},{data:lufs}]=await Promise.all([sb.from('hab_catalogo').select('*').order('ordem'),sb.from('hab_empresas').select('*').eq(ch,sj.id).maybeSingle(),sb.from('hab_documentos').select('*').eq(ch,sj.id).order('criado_em',{ascending:false}),sb.from('hab_links_uf').select('*')]);
 const H=he||{natureza:sj.tipo==='pf'?'pf':null,uf:sj.uf||'',municipio:sj.municipio||'',etapas:{}};window.__HAB={sujeito:sj,tipo:sj.tipo,H,cat:cat||[],lufs:lufs||[]};
 const NAT={mei:'MEI',ei:'Empresário individual',ltda:'Sociedade limitada (inclui unipessoal e antiga EIRELI)',sa:'Sociedade anônima',coop:'Cooperativa',ss:'Sociedade simples',assoc:'Associação ou fundação'};
 const vers={};(docs||[]).forEach(d=>{(vers[d.codigo]=vers[d.codigo]||[]).push(d);});
 const itens=(cat||[]).filter(c=>c.naturezas.includes(sj.tipo==='pf'?'pf':(H.natureza||'ltda')));
 const obg=c=>sj.tipo==='pf'?(c.obrigatorio_pf??c.obrigatorio):c.obrigatorio;
 const hoje=new Date().toISOString().slice(0,10),em15=new Date(Date.now()+15*864e5).toISOString().slice(0,10);
 const sit=c=>{const d=(vers[c.codigo]||[])[0];if(!d)return 'falta';if(d.valido_ate&&d.valido_ate<hoje)return 'vencido';if(!d.valido_ate&&c.validade_dias)return 'sem_validade';if(d.valido_ate&&d.valido_ate<=em15)return 'vencendo';return 'ok';};
 const GR=[['credenciamento','Identificação','Dados cadastrais do fornecedor (SICAF nível I).'],['juridica','Habilitação jurídica','Prova de que a empresa existe e de quem a representa (Lei 14.133, art. 66).'],['fiscal','Regularidade fiscal, social e trabalhista','União, estado, município, FGTS e Justiça do Trabalho (art. 68).'],['tecnica','Qualificação técnica','Atestados e registros que mostram capacidade de executar (art. 67).'],['economica','Qualificação econômico-financeira','Balanço e certidão de falência (art. 69).'],['declaracoes','Declarações','Declarações exigidas nos editais (arts. 63 e 68).'],['impedimentos','Impedimentos e sanções','Consultas de impedimento para licitar.'],['sicaf','SICAF','Cadastro no SICAF.']];
 const cats=GR.map(([g,t,x])=>{const its=itens.filter(c=>c.grupo===g);if(!its.length)return null;const ob=its.filter(obg);const s=ob.map(sit);
  const est=!ob.length?'edital':s.includes('vencido')?'vencido':s.every(v=>v==='falta')?'nao_iniciado':s.includes('falta')?'preenchendo':s.some(v=>v==='sem_validade'||v==='vencendo')?'revisao':'completo';
  const prox=ob.find(c=>['vencido','falta'].includes(sit(c)))||ob.find(c=>['sem_validade','vencendo'].includes(sit(c)));
  return {g,t,x,its,ob,est,prox,okN:s.filter(v=>v==='ok'||v==='vencendo').length};}).filter(Boolean);
 const totOb=cats.reduce((a,c)=>a+c.ob.length,0),totOk=cats.reduce((a,c)=>a+c.okN,0),pct=totOb?Math.round(totOk/totOb*100):0;
 const lk=c=>c.link&&!c.link.startsWith('uf:')?c.link.replace('{UF}',encodeURIComponent(H.uf||'')).replace('{MUNICIPIO}',encodeURIComponent(H.municipio||'')):null;
 const ST={falta:['c-red','Não anexado'],vencido:['c-red','Vencido'],sem_validade:['c-amber','Sem data de validade'],vencendo:['c-amber','Vence em até 15 dias'],ok:['c-green','Anexado e válido']};
 const docRow=c=>{const vs=vers[c.codigo]||[],d=vs[0],s=sit(c),l=lk(c);const o=obg(c);
  return `<div class="hdoc"><div class="hdoc-st ${o?ST[s][0]:'c-mut'}">${s==='ok'?'✓':s==='falta'?(o?'!':'·'):'!'}</div>
  <div><div class="hdoc-nm">${esc(c.nome)} ${o?'':'<span class="chip c-mut">conforme o edital</span>'}</div>
   <div class="hdoc-meta">${[esc(c.base_legal||''),c.validade_dias?`validade usual ${c.validade_dias} dias`:'',c.sicaf_automatico?'o SICAF consulta sozinho':''].filter(Boolean).join(' · ')}</div>
   ${d?`<div class="hdoc-meta">📎 ${esc(d.arquivo_nome||'sem arquivo')} · enviado em ${dt(d.criado_em)}${d.valido_ate?' · válido até '+dt(d.valido_ate+'T12:00:00'):''}</div>`:''}
   ${vs.length>1?`<details><summary>${vs.length-1} versão(ões) anterior(es)</summary>${vs.slice(1).map(v=>`<div class="hdoc-meta">${dt(v.criado_em)} · ${esc(v.arquivo_nome||'sem arquivo')}${v.valido_ate?' · validade '+dt(v.valido_ate+'T12:00:00'):''}${v.arquivo_path?` · <a class="l" onclick="verDocHab('${esc(v.arquivo_path)}')">ver</a>`:''}</div>`).join('')}</details>`:''}
   ${c.como_obter?`<details><summary>Como obter</summary><p>${esc(c.como_obter)}</p></details>`:''}</div>
  <div class="hdoc-ac">${o||d?`<span class="chip ${ST[s][0]}">${ST[s][1]}</span>`:''}${l?`<a href="${l}" target="_blank" rel="noopener" class="gh">Emitir ↗</a>`:''}${c.link&&c.link.startsWith('uf:')?ufPicker(c.codigo,c.link.slice(3),H.uf):''}${d&&d.arquivo_path?`<button class="sec sm" onclick="verDocHab('${esc(d.arquivo_path)}')">Ver</button>`:''}<button class="sm anexar" onclick="novoDocHab('${c.codigo}')">${d?'Nova versão':'Anexar'}</button></div></div>`;};
 const aberto=window.__HABOPEN||(cats.find(c=>['vencido','preenchendo','nao_iniciado','revisao'].includes(c.est))||{}).g;
 main.innerHTML=topo+`<div class="card"><div class="hab-head"><div class="ev-form">
   <div style="grid-column:1/-1"><label>Fornecedor</label><select onchange="window.__HABSEL=this.value;ir('habilitacao',{sujeito:this.value})">${sujeitos.map(x=>`<option value="${x.tipo}:${x.id}" ${x.id===sj.id&&x.tipo===sj.tipo?'selected':''}>${x.tipo==='pf'?'Pessoa física':'Pessoa jurídica'} · ${esc(x.nome)} · ${esc(x.doc)}</option>`).join('')}</select></div>
   ${sj.tipo==='pj'?`<div style="grid-column:1/-1"><label>Natureza jurídica</label><select onchange="salvarHab({natureza:this.value||null})"><option value="">Selecione…</option>${Object.entries(NAT).map(([k,v])=>`<option value="${k}" ${k===H.natureza?'selected':''}>${v}</option>`).join('')}</select>${!H.natureza?'<div class="ev-hint">A lista de documentos se ajusta à natureza jurídica.</div>':''}</div>`:''}
   <div><label>UF da sede</label>${ufSelect('huf',H.uf,"salvarHab({uf:this.value||null,municipio:null})")}</div><div><label>Município da sede</label>${munSelect('hmun',H.uf,H.municipio,"salvarHab({municipio:this.value||null})")}</div></div>
  <div class="hab-prog"><div class="pc"><b>${pct}%</b><span>dos documentos obrigatórios anexados e válidos no cadastro</span></div><div class="hbar"><i style="width:${pct}%"></i></div>
   <span class="ev-hint" style="margin:0">Documento anexado não significa empresa habilitada: cada edital tem suas exigências.</span></div></div></div>
 <div class="hab-cats">${cats.map(c=>{const e=HAB_EST[c.est];return `<details class="card hab-cat" ${c.g===aberto?'open':''} ontoggle="if(this.open)window.__HABOPEN='${c.g}'"><summary><span class="hdoc-st ${e[0]}">${e[1]}</span><div><b>${c.t}</b><small>${c.x}</small></div><span class="chip ${e[0]}">${e[2]}</span><span class="hab-n">${c.ob.length?`${c.okN}/${c.ob.length}`:''}</span></summary>
  ${c.prox?`<div class="hab-prox"><span>Próxima ação:</span> <b>${esc(c.prox.nome)}</b> — ${ST[sit(c.prox)][1].toLowerCase()} <button class="sm anexar" onclick="novoDocHab('${c.prox.codigo}')">${sit(c.prox)==='falta'?'Anexar':'Nova versão'}</button></div>`:''}
  ${c.its.map(docRow).join('')}</details>`;}).join('')}</div>
 ${sj.tipo==='pj'?`<details class="card hab-cat"><summary><span class="hdoc-st c-mut">i</span><div><b>Cadastro no SICAF</b><small>Passo a passo do credenciamento, feito pelo próprio fornecedor no gov.br.</small></div></summary>
  <p class="ev-hint">O EditalVector não pede nem guarda senha gov.br ou certificado digital.</p>
  <ol class="an-ul"><li>Conta gov.br prata ou ouro do responsável.</li><li>Acessar o <a class="l" href="https://www3.comprasnet.gov.br/sicaf-web/index.jsf" target="_blank" rel="noopener">SICAF ↗</a> e concluir o credenciamento (nível I).</li><li>Cadastrar as linhas de fornecimento no SICAF e, aqui, em Empresa › Linha de fornecimento.</li><li>Conferir impedimentos na <a class="l" href="https://certidoes-apf.apps.tcu.gov.br/" target="_blank" rel="noopener">consulta consolidada do TCU ↗</a>.</li></ol></details>`:''}`;
};

// tudo registrado: inicia o painel
iniciar();
