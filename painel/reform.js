/* EditalVector — fluxo principal desta versão:
 * empresa → linha de fornecimento → habilitação → oportunidades e PCA direcionados → Radar → Triagem → Minhas licitações (análise de viabilidade → proposta → resultado).
 * Usa os auxiliares do index.html ($, esc, brl, dt, dias, sb, main, ir, V, cardLic, abaSel, toast...).
 */
'use strict';
const NIVEL={grupo:'Grupo',classe:'Classe',pdm:'PDM (padrão descritivo)',item:'Item',secao:'Seção',divisao:'Divisão',subclasse:'Subclasse',servico:'Serviço'};
const TIPO_CAT={M:'Material',S:'Serviço'};
const ORIGEM_LF={manual:'Declarada por você',ia:'Sugerida pela IA e confirmada por você',sicaf_declarado:'Copiada do SICAF por você — não verificada pelo sistema',historico_pncp:'Encontrada automaticamente no histórico público do CNPJ (atas de registro de preços) — não é validação do SICAF',cnae_fornecedores:'Sugerida pelo que fornecedores reais do mesmo CNAE venderam e confirmada por você'};
const CONF_LF={alta:['c-green','Confiança alta'],media:['c-amber','Confiança média'],baixa:['c-mut','Confiança baixa']};
const SIT_LF={ativo:['c-green','✓','Ativa no catálogo'],inativo:['c-amber','!','Inativa no catálogo oficial'],a_conferir:['c-amber','?','Item ainda não conferido no catálogo'],nao_encontrado:['c-red','!','Não encontrada no catálogo oficial']};
window.ST_INT={a_analisar:'A analisar',em_analise:'Em análise',viavel:'Vou participar',proposta_enviada:'Proposta enviada',ganha:'Ganha',perdida:'Perdida',inviavel:'Não vou participar',arquivada:'Descartada'};
const ST_INT_COR={a_analisar:'c-mut',em_analise:'c-blue',viavel:'c-green',proposta_enviada:'c-violet',ganha:'c-green',perdida:'c-red',inviavel:'c-mut',arquivada:'c-mut'};
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
async function marcarInteresse(opId){try{await rpc('marcar_interesse',{p_oportunidade:Number(opId)});toast('Enviada para Minhas licitações','Abrir',()=>ir('interesses'));}catch(e){toast(e.message);}}

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
 const [R,pjR,intR,D,temPerfil,BRr,nTriar,topR]=await Promise.all([rpc('resumo_linha').catch(()=>null),
  q(sb.from('pessoas_juridicas').select('id,cnpj,razao_social,uf').order('propria',{ascending:false}).limit(1)),
  q(sb.rpc('listar_interesses',{p_status:null})),q(sb.rpc('dashboard_resumo')).then(r=>r.data||{}),temPerfilBusca(),
  q(sb.from('briefings').select('*,perfis_busca(nome,ativo)').order('gerado_em',{ascending:false}).limit(60)),
  rpc('oportunidades_linha',{p_limite:1,p_so_novas:true}).then(x=>x&&x.length?Number(x[0].total):0).catch(()=>null),
  q(sb.from('radar').select('id,score,status,justificativa,perfis_busca(nome),oportunidades!inner(id,objeto,orgao_nome,municipio,uf,modalidade,srp,valor_estimado,valor_sigiloso,data_fim_proposta,link_pncp,ia_resumo,ia_categoria,ia_atencao,ia_tipo,ia_termo,ia_catalogo_codigo,ia_catalogo_nome)').gte('oportunidades.data_fim_proposta',new Date().toISOString()).neq('status','descartado').order('score',{ascending:false}).limit(5))]);
 const pj=(pjR.data||[])[0],ints=intR.data||[],r=R||{},linhaOk=(r.linhas_incluir||0)>0;
 const vb=new Set(),brs=(BRr.data||[]).filter(b=>b.perfis_busca&&b.perfis_busca.ativo&&!vb.has(b.perfil_id)&&vb.add(b.perfil_id)).slice(0,3),top=topR.data||[];
 const bid=[...new Set(brs.flatMap(b=>(b.destaques||[]).map(d=>d.id)))],bop=bid.length?Object.fromEntries(((await sb.from('oportunidades').select('id,objeto,uf').in('id',bid)).data||[]).map(o=>[o.id,o])):{};
 const ago=iso=>{const m=Math.max(0,Math.round((Date.now()-new Date(iso))/6e4));return m<60?m+' min':m<1440?Math.round(m/60)+' h':Math.round(m/1440)+' d';};
 const kp=(v,l,s,go)=>`<button class="ev-kpi" onclick="${go}"><b>${v}</b><span>${l}</span><small>${s}</small></button>`;
 const avisoEmpresa=linhaOk?'':`<div class="card ev-next"><span class="ev-next-k">Automatize as buscas</span><h3>Cadastre sua empresa</h3><p>Informe o CNPJ e o sistema busca os dados públicos e sugere a linha de fornecimento (classes e grupos do catálogo) pelo que a empresa já vendeu ao governo. Com isso, licitações e compras planejadas (PCA) passam a ser buscadas automaticamente pela classe/grupo. <b>É opcional:</b> você pode pesquisar só com perfis de busca.</p><button onclick="ir('empresa',{aba:'linha'})">Cadastrar Empresa e Linha de Fornecimento</button></div>`;
 const blocoEmpresa=linhaOk?`<div class="card"><h3>Busca automática pela linha de fornecimento${pj&&pj.razao_social?' · '+esc(pj.razao_social):''}</h3><p class="sub">Classes e grupos da empresa cruzados com licitações abertas e com o PCA. ${temPerfil?'Os perfis de busca continuam valendo em paralelo.':'Você também pode criar perfis de busca para refinar.'}</p>
  <div class="ev-kpis">${kp(fmtN(r.lic_confirmadas),'Licitações na sua linha','código ou classificação confirmados',"ir('oport',{conf:'confirmada'})")}${kp(fmtN(r.lic_revisar),'Possíveis, para revisar','pela descrição',"ir('oport',{conf:'revisar'})")}${kp(fmtN(r.pca_confirmadas),'Compras planejadas (PCA)','planejamento, não é licitação aberta',"ir('pca')")}${kp(fmtN(ints.length),'Minhas licitações',ints.filter(x=>x.status==='em_analise').length+' em análise',"ir('interesses')")}</div>
  <p class="ev-hint">Itens lidos em ${fmtN(r.abertas_com_itens)} de ${fmtN(r.abertas)} licitações abertas; a leitura avança a cada coleta. Última coleta: ${r.ultima_coleta?dt(r.ultima_coleta):'—'}.</p></div>`:'';
 const briefing=!temPerfil?avisoPerfilBusca(pode('perfis')):(brs.length?brs.map(b=>`<div class="card brief"><h3>${AI('Briefing gerado por IA (Gemini)')}${esc(b.titulo||'Briefing')} <span class="m">· ${esc(b.perfis_busca&&b.perfis_busca.nome||'')} · há ${ago(b.gerado_em)}</span></h3><p style="margin:6px 0 8px;line-height:1.5">${esc(b.resumo||'')}</p>${(b.destaques||[]).map(d=>`<div class="br" style="grid-template-columns:1fr"><span class="bl" style="cursor:pointer" onclick="ir('triagem')"><b>${esc(((bop[d.id]||{}).objeto||'#'+d.id).slice(0,90))}</b> <span class="m">${esc((bop[d.id]||{}).uf||'')} — ${esc(d.motivo||'')}</span></span></div>`).join('')}${(b.alertas||[]).length?`<div style="margin-top:6px">${b.alertas.map(a=>`<span class="tag w">${esc(a)}</span>`).join(' ')}</div>`:''}</div>`).join(''):`<div class="card"><h3>Briefing</h3><p class="sub">Seus perfis de busca estão salvos. O briefing é gerado a cada coleta completa; o primeiro aparece aqui assim que for gerado.</p></div>`);
 const nAn=ints.filter(x=>['a_analisar','em_analise'].includes(x.status)).length,nPart=ints.filter(x=>['viavel','proposta_enviada'].includes(x.status)).length;
 const passo=(n,t,s,feito,go,bt)=>`<button class="ev-passo ${feito?'ok':''}" onclick="${go}"><i>${feito?'✓':n}</i><span><b>${t}</b><small>${s}</small></span><em>${bt}</em></button>`;
 const caminho=`<div class="card ev-caminho"><h3>Seu caminho</h3><div class="ev-passos">
  ${passo(1,'Minha empresa',pj?(linhaOk?`${fmtN(r.linhas_incluir)} classe(s)/grupo(s) na linha`:'falta a linha de fornecimento'):'cadastre o CNPJ',!!(pj&&linhaOk),"ir('empresa')",pj&&linhaOk?'Revisar':'Cadastrar')}
  ${passo(2,'Radar',linhaOk?`${fmtN(r.lic_confirmadas)} licitação(ões) abertas na linha`:'aguardando a linha',false,"ir('oport')",'Ver')}
  ${passo(3,'Triagem',nTriar==null?'—':nTriar?`${fmtN(nTriar)} nova(s) para avaliar`:'nada novo',nTriar===0&&linhaOk,"ir('triar')",'Triar')}
  ${passo(4,'Minhas licitações',`${nAn} em análise · ${nPart} participando`,false,"ir('interesses')",'Abrir')}</div></div>`;
 main.innerHTML=bannerPlano()+`<div class="top"><div><h2>${pj&&pj.razao_social?esc(pj.razao_social):'Início'}</h2><p class="sub">Pesquise por perfis de busca${linhaOk?' e pela linha de fornecimento da empresa':''}; a empresa é opcional.</p></div></div>
 ${caminho}
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
 const aba=abaIni('emp',(window.ARG&&window.ARG.aba)||((linhas||[]).length?'linha':(pj&&pj.uf&&pj.cnae_principal?'linha':'dados')),['dados','linha']);
 const inc=(linhas||[]).filter(l=>l.modo==='incluir'),exc=(linhas||[]).filter(l=>l.modo==='excluir');
 main.innerHTML=`<div class="top"><div><h2>Empresa</h2><p class="sub">Comece pelo que a empresa fornece. Você pode salvar e continuar depois.</p></div><div id="lfst" class="ev-hint"></div></div>
 <div class="ev-root">
 <div class="ev-tabs" data-g="emp" data-mem="emp" role="tablist">
  <button type="button" class="${aba==='dados'?'on':''}" data-t="dados" onclick="abaSel(this)">Dados da empresa</button>
  <button type="button" class="${aba==='linha'?'on':''}" data-t="linha" onclick="abaSel(this)">Linha de fornecimento<span class="n ${inc.length?'c-green':'c-red'}">${inc.length||'!'}</span></button></div>
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
 <div class="ev-pane" data-g="emp" data-t="dados" ${aba==='dados'?'':'hidden'}>${empForm(pj)}${empTribCard(pj)}</div>
 </div>`;
 empDadosAuto();empTribAuto();empAuto(false);lfCnae();lfRestaurar();
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
const NIVEIS_CAM={M:['Grupo','Classe','PDM'],S:['Seção','Divisão','Grupo','Classe','Subclasse']};
function lfResRow(r,origem,motivo){
 const k=`${r.tipo}|${r.nivel}|${r.codigo}`;window.__LFR=window.__LFR||{};window.__LFR[k]={...r,origem:origem||'manual',motivo:motivo||null};
 const ja=(window.__EMP&&window.__EMP.linhas||[]).find(l=>l.tipo===r.tipo&&l.nivel===r.nivel&&l.codigo===String(r.codigo));
 const abre=(r.nivel!=='item'&&r.nivel!=='servico');
 const chv=lfChave(r);
 const cam=String(r.rotulo||'').split('›').map(x=>x.trim()).filter(Boolean),nv=NIVEIS_CAM[r.tipo]||[];
 const caminho=cam.length?`<ol class="lf-path">${cam.map((x,i)=>{const m=x.match(/^(\S+)\s+(.*)$/);return `<li><span class="lf-pn">${esc(nv[i]||'')}</span><span class="lf-pc">${esc(m?m[1]:'')}</span><span>${esc(m?m[2]:x)}</span></li>`;}).join('')}<li class="cur"><span class="lf-pn">${esc(NIVEL[r.nivel]||r.nivel)}</span><span class="lf-pc">${esc(r.codigo)}</span><span>${esc(r.nome)}</span></li></ol>`:'';
 const largos=chv.map(x=>`<button class="sec sm" onclick="lfAddChave('${k}','${x.nivel}')" title="Inclui ${x.nivel==='classe'?'a classe':'o grupo'} inteiro">${x.nivel==='classe'?'Classe':'Grupo'} ${esc(x.codigo)} inteira</button>`).join('');
 const extra=(caminho||largos||abre)?`<details class="lf-more"><summary>Caminho no catálogo e opções mais amplas</summary>${caminho}<div class="lf-ac2">${abre?`<button class="sec sm" onclick="lfAbrir('${k}')">Ver o que há dentro</button>`:''}${largos}</div></details>`:'';
 return `<div class="lf-row res ${r.ativo===false?'inat':''}" data-tipo="${r.tipo}"><div class="lf-main"><div class="lf-top"><span class="chip ${r.tipo==='M'?'c-blue':'c-violet'}">${TIPO_CAT[r.tipo]}</span><span class="chip c-mut">${NIVEL[r.nivel]||r.nivel} ${esc(r.codigo)}</span>${r.ativo===false?'<span class="chip c-amber">! Inativa no catálogo</span>':''}${ja?`<span class="chip c-green">✓ Já está na linha (${ja.modo==='excluir'?'exclusão':'incluída'})</span>`:''}</div>
  <b class="lf-nome">${esc(r.nome)}</b>${chv.length?`<div class="lf-chave">Liga ao PCA por: ${chv.map(x=>`<b>${x.nivel==='classe'?'Classe':'Grupo'} ${esc(x.codigo)}</b>${x.nome?' · '+esc(x.nome):''}`).join(' &nbsp;|&nbsp; ')}</div>`:''}${motivo?`<small class="lf-esp">${AI()} ${esc(motivo)}</small>`:''}${extra}</div>
  <div class="lf-ac"><button class="sm" onclick="lfAdd('${k}','incluir')">${origem==='ia'?'Confirmar':'Fornece'}</button><button class="sec sm" onclick="lfAdd('${k}','excluir')">Não fornece</button></div></div>`;
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
  if(!(r&&r.length)){box.innerHTML='<div class="vazio">Nada encontrado com esses termos. Tente sinônimos, o nome técnico ou o código.</div>';return;}
  const nM=r.filter(x=>x.tipo==='M').length,nS=r.length-nM;
  box.innerHTML=`<div class="lf-resumo"><b>${r.length}</b> resultado(s) no catálogo oficial${r.length===40?' · mostrando os 40 mais próximos, refine a pesquisa':''}</div>
   ${nM&&nS?`<div class="ev-tabs sm" data-g="lfres" role="tablist"><button type="button" class="on" data-t="" onclick="lfFiltroRes(this)">Todos<span class="n">${r.length}</span></button><button type="button" data-t="M" onclick="lfFiltroRes(this)">Materiais<span class="n">${nM}</span></button><button type="button" data-t="S" onclick="lfFiltroRes(this)">Serviços<span class="n">${nS}</span></button></div>`:''}
   <div id="lfresl">${r.map(x=>lfResRow(x)).join('')}</div>`;
 }catch(e){box.innerHTML=`<div class="vazio">Não foi possível pesquisar agora (${esc(e.message)}).</div>`;}
}
function lfFiltroRes(btn){btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===btn));const t=btn.dataset.t;document.querySelectorAll('#lfresl .lf-row').forEach(e=>{e.hidden=!!t&&e.dataset.tipo!==t;});}
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
// Preenche sozinho UF, município, porte, CNAE principal e razão/fantasia vazios a partir do CNPJ (BrasilAPI), grava e mostra na tela.
async function empDadosAuto(){
 const E=window.__EMP,pj=E&&E.pj;if(!pj||!pj.cnpj||!$('#ecn'))return;
 const falta=!pj.uf||!pj.municipio||!pj.porte||!pj.cnae_principal||!pj.razao_social||!(pj.cnaes||[]).length;
 const h=$('#ecnh');if(!falta||window.__DADOS_AUTO===pj.cnpj)return;window.__DADOS_AUTO=pj.cnpj;
 try{
  const tk=(await sb.auth.getSession()).data.session.access_token;
  const r=await fetch('/api/catalogo?cnpj='+encodeURIComponent(pj.cnpj),{headers:{authorization:'Bearer '+tk}}).then(x=>x.json());
  const rf=r&&r.receita;if(!rf){if(h)h.textContent='Não foi possível consultar o CNPJ agora; preencha manualmente ou tente de novo mais tarde.';return;}
  const upd={},set=(id,v)=>{const e=$('#'+id);if(e&&v&&!e.value){e.value=v;}};
  if(!pj.razao_social&&rf.razao_social){upd.razao_social=rf.razao_social;set('erz',rf.razao_social);}
  if(!pj.nome_fantasia&&rf.nome_fantasia){upd.nome_fantasia=rf.nome_fantasia;set('efa',rf.nome_fantasia);}
  if(!pj.uf&&rf.uf){upd.uf=rf.uf;$('#euf').value=rf.uf;const m=$('#emun');m.dataset.uf=rf.uf;m.dataset.atual=rf.municipio||'';munPreencher(m);}
  if(!pj.municipio&&rf.municipio){upd.municipio=rf.municipio;if(pj.uf){const m=$('#emun');m.dataset.atual=rf.municipio;munPreencher(m);}}
  if(!pj.porte&&rf.porte){upd.porte=rf.porte;const p=$('#epo');[...p.options].some(o=>o.value===rf.porte||o.text===rf.porte)&&(p.value=rf.porte);}
  if(!pj.cnae_principal&&rf.cnae){upd.cnae_principal=String(rf.cnae);set('ecn',String(rf.cnae));}
  if(rf.cnae_desc&&$('#ecnd')&&!$('#ecnd').textContent)$('#ecnd').textContent=rf.cnae_desc;
  if(!(pj.cnaes||[]).length&&rf.cnae){upd.cnaes=[{codigo:String(rf.cnae),descricao:rf.cnae_desc||'',principal:true},...(rf.cnaes_sec||[]).map(x=>({codigo:String(x.codigo),descricao:x.descricao||'',principal:false}))];}
  if(Object.keys(upd).length){const {error}=await sb.from('pessoas_juridicas').update(upd).eq('id',pj.id);if(!error){Object.assign(pj,upd);if(h)h.textContent='Dados preenchidos automaticamente pela Receita Federal (CNPJ). Confira e ajuste se precisar.'+(upd.cnaes&&upd.cnaes.length>1?` Mais ${upd.cnaes.length-1} atividade(s) secundária(s) usadas nas sugestões da linha.`:'');}}
 }catch(e){if(h)h.textContent='Não foi possível consultar o CNPJ agora.';}
}
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
// ------------------------------------------------------------------ perfil tributário e metas padrão (preenche a análise de viabilidade)
const REG_TXT={simples:'Simples Nacional',mei:'MEI',presumido:'Lucro Presumido',real:'Lucro Real'};
const ORIG_T={cnpj:['c-blue','Detectado pelo CNPJ'],cnae:['c-blue','Sugerido pelo CNAE'],ia:['c-violet','Sugerido pela IA'],voce:['c-mut','Escolhido por você'],padrao:['c-amber','Padrão']};
const oT=k=>{const o=ORIG_T[k];return o?`<span class="chip ${o[0]} an-or">${o[1]}</span>`:'';};
function empTribCard(pj){
 if(!pj)return '';
 const T=pj.tributacao||{},O=T.origem||{},sug=VIAB.anexoPorCnae(pj.cnae_principal),R=VIAB.tributacao(T,{});
 const sel=(k,v,ops,ph)=>`<select data-t="${k}" onchange="empTribSet(this)">${ph?`<option value="">${ph}</option>`:''}${ops.map(([a,b])=>`<option value="${a}" ${String(a)===String(v??'')?'selected':''}>${b}</option>`).join('')}</select>`;
 const MG=[5,8,10,12,15,18,20,25,30,35,40].map(v=>[v,v+'%']);
 const an=T.anexo;
 return `<div class="card" id="etrib"><h3>Tributação e metas padrão</h3><p class="sub">Usados para preencher sozinha cada análise de viabilidade: você só escolhe os itens e informa o custo. Tudo aqui é escolha, sem digitar.</p>
 <div class="ev-form emp-form">
  <div><label>Regime tributário ${oT(O.regime)}</label>${sel('regime',T.regime,Object.entries(REG_TXT),'Escolha')}${O.regime==='cnpj'?'':`<small class="ev-hint" id="etribh">${T.regime?'':'Consultando o CNPJ…'}</small>`}</div>
  ${T.regime==='simples'?`<div><label>Anexo do Simples ${oT(O.anexo)}</label>${sel('anexo',an,Object.entries(VIAB.ANEXO_TXT),'Escolha')}${T.anexo_motivo?`<small class="ev-hint">${esc(T.anexo_motivo)}</small>`:''}${pode('ia')?`<button type="button" class="sec sm" style="margin-top:6px" onclick="empAnexoIA(this)">${AI()} Pedir à IA para conferir</button>`:''}</div>
   ${an==='V'?`<div><label>Fator R</label>${sel('fator_r',T.fator_r?'1':'0',[['0','Folha abaixo de 28% da receita (Anexo V)'],['1','Folha de 28% ou mais (vai para o Anexo III)']])}</div>`:''}
   <div><label>Faturamento dos últimos 12 meses ${oT(O.faixa)}</label>${sel('faixa',T.faixa,VIAB.FAIXA_TXT.map((t,k)=>[k+1,`Faixa ${k+1}: ${t}`]),'Escolha a faixa')}</div>`:''}
  ${T.regime==='presumido'||T.regime==='real'?`<div><label>A empresa principalmente ${oT(O.atividade)}</label>${sel('atividade',T.atividade,[['comercio','revende mercadorias'],['industria','fabrica produtos'],['servico','presta serviços']],'Escolha')}</div>
   ${T.atividade==='servico'?`<div><label>ISS do município ${oT(O.iss)}</label>${sel('iss',T.iss,[[2,'2%'],[2.5,'2,5%'],[3,'3%'],[4,'4%'],[5,'5%']],'Escolha')}</div>`:T.atividade?`<div><label>ICMS efetivo nas vendas ${oT(O.icms)}</label>${sel('icms',T.icms,[[0,'0% (isento ou substituição tributária)'],[4,'4%'],[7,'7%'],[12,'12%'],[17,'17%'],[18,'18%'],[19,'19%'],[20,'20%'],[22,'22%']],'Escolha')}<small class="ev-hint">Já descontados os créditos das compras, se houver. Na dúvida, pergunte ao contador.</small></div>`:''}`:''}
  <div><label>Margem mínima padrão ${oT(O.margem_min)}</label>${sel('margem_min',T.margem_min??10,MG)}</div>
  <div><label>Margem-alvo padrão ${oT(O.margem_alvo)}</label>${sel('margem_alvo',T.margem_alvo??20,MG)}</div>
  <div><label>Seus fornecedores costumam receber em</label>${sel('prazo_fornecedor',T.prazo_fornecedor??0,[[0,'À vista'],[7,'7 dias'],[14,'14 dias'],[21,'21 dias'],[28,'28 dias'],[30,'30 dias'],[45,'45 dias'],[60,'60 dias']])}</div>
  <div><label>Caixa disponível para contratos públicos</label>${sel('caixa',T.caixa,[0,5e3,1e4,2.5e4,5e4,1e5,2.5e5,5e5,1e6,2e6,5e6].map(v=>[v,v===0?'Nenhum':brl(v)]),'Prefiro não informar')}</div>
  <div><label>Crédito que consegue usar</label>${sel('credito',T.credito,[0,1e4,2.5e4,5e4,1e5,2.5e5,5e5,1e6].map(v=>[v,v===0?'Nenhum':brl(v)]),'Prefiro não informar')}</div>
 </div>
 <div class="an-auto"><b>${esc(R.resumo)}</b>${R.pend.length?`<span>${esc(R.pend[0])}</span>`:`<span>É o que entra em cada análise.${R.notas.length?' '+esc(R.notas[0]):''}</span>`}</div></div>`;
}
async function empTribSalvar(T){const pj=window.__EMP.pj;pj.tributacao=T;const {error}=await sb.from('pessoas_juridicas').update({tributacao:T}).eq('id',pj.id);if(error){toast(error.message);return false;}return true;}
async function empTribSet(el){
 const pj=window.__EMP.pj,T=Object.assign({},pj.tributacao||{}),k=el.dataset.t;T.origem=Object.assign({},T.origem||{});
 let v=el.value;if(['faixa','iss','icms','margem_min','margem_alvo','prazo_fornecedor','caixa','credito'].includes(k))v=v===''?null:Number(v);if(k==='fator_r')v=v==='1';
 T[k]=v;T.origem[k]='voce';
 if(k==='regime'&&v==='simples'&&!T.anexo){const s=VIAB.anexoPorCnae(pj.cnae_principal);if(s){T.anexo=s.anexo;T.anexo_motivo=s.motivo;T.origem.anexo='cnae';}}
 if(k==='regime'&&(v==='presumido'||v==='real')&&!T.atividade){const s=VIAB.anexoPorCnae(pj.cnae_principal);if(s){T.atividade={I:'comercio',II:'industria'}[s.anexo]||'servico';T.origem.atividade='cnae';}}
 if(k==='anexo')delete T.anexo_motivo;
 if(await empTribSalvar(T)){toast('Salvo');$('#etrib').outerHTML=empTribCard(pj);}
}
// detecção automática: regime pelo CNPJ (Simples/MEI) e anexo pelo CNAE, só onde ainda está vazio
async function empTribAuto(){
 const pj=window.__EMP&&window.__EMP.pj;if(!pj||!pj.cnpj||!$('#etrib'))return;
 const T=Object.assign({},pj.tributacao||{}),O=T.origem=Object.assign({},T.origem||{});let mud=false;
 if(!T.regime&&window.__TRIB_AUTO!==pj.cnpj){window.__TRIB_AUTO=pj.cnpj;
  try{const tk=(await sb.auth.getSession()).data.session.access_token;const r=await fetch('/api/catalogo?cnpj='+encodeURIComponent(pj.cnpj),{headers:{authorization:'Bearer '+tk}}).then(x=>x.json());const rf=r&&r.receita;
   if(rf&&rf.mei===true){T.regime='mei';O.regime='cnpj';mud=true;}else if(rf&&rf.simples===true){T.regime='simples';O.regime='cnpj';mud=true;}
   else if(rf&&rf.simples===false){const h=$('#etribh');if(h)h.textContent='O CNPJ não é optante do Simples nem MEI: escolha entre Lucro Presumido e Lucro Real.';}
   else{const h=$('#etribh');if(h)h.textContent='Não foi possível consultar o CNPJ agora: escolha o regime.';}
  }catch(e){const h=$('#etribh');if(h)h.textContent='Não foi possível consultar o CNPJ agora: escolha o regime.';}
 }
 const s=VIAB.anexoPorCnae(pj.cnae_principal);
 if(T.regime==='simples'&&!T.anexo&&s){T.anexo=s.anexo;T.anexo_motivo=s.motivo;O.anexo='cnae';mud=true;}
 if((T.regime==='presumido'||T.regime==='real')&&!T.atividade&&s){T.atividade={I:'comercio',II:'industria'}[s.anexo]||'servico';O.atividade='cnae';mud=true;}
 if(T.margem_min==null){T.margem_min=10;O.margem_min='padrao';mud=true;}if(T.margem_alvo==null){T.margem_alvo=20;O.margem_alvo='padrao';mud=true;}
 if(mud&&await empTribSalvar(T)&&$('#etrib'))$('#etrib').outerHTML=empTribCard(pj);
}
async function empAnexoIA(btn){
 const pj=window.__EMP.pj;btn.disabled=true;btn.textContent='Consultando a IA…';
 try{const tk=(await sb.auth.getSession()).data.session.access_token;
  const r=await fetch('/api/ia',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'anexo_simples',cnaes:(pj.cnaes||[]).length?pj.cnaes:[{codigo:pj.cnae_principal,principal:true}],descricao:pj.descricao_atividades||''})}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);
  const T=Object.assign({},pj.tributacao||{});T.origem=Object.assign({},T.origem||{});T.anexo=r.anexo;T.anexo_motivo=r.motivo+(r.fator_r?' Sujeito ao Fator R.':'');T.origem.anexo='ia';
  if(await empTribSalvar(T)){toast('Anexo sugerido pela IA: '+r.anexo);$('#etrib').outerHTML=empTribCard(pj);}
 }catch(e){btn.disabled=false;btn.textContent='Pedir à IA para conferir';toast(e.message);}
}
function empForm(pj){
 if(!pj)return pend('Nenhuma empresa cadastrada nesta organização','',"Cadastre o CNPJ em Minha empresa › Dados.");
 const dp=pj.dados_publicos||null;
 return `<div class="card"><h3>Dados da empresa</h3><p class="sub">Poucos campos agora; o restante pode ser preenchido depois.</p>
 <div class="ev-form emp-form"><div><label for="ecnpj">CNPJ</label><input id="ecnpj" value="${esc(pj.cnpj)}" disabled></div>
 <div><label for="erz">Razão social</label><input id="erz" value="${esc(pj.razao_social||'')}"></div>
 <div><label for="efa">Nome fantasia</label><input id="efa" value="${esc(pj.nome_fantasia||'')}"></div>
 <div><label for="euf">UF da sede</label>${ufSelect('euf',pj.uf,"ufMud(this,'emun')")}</div>
 <div><label for="emun">Município</label>${munSelect('emun',pj.uf,pj.municipio)}</div>
 <div><label for="epo">Porte</label><select id="epo"><option value="">—</option>${['MEI','Microempresa','Empresa de pequeno porte','Demais'].map(x=>`<option ${x===pj.porte?'selected':''}>${x}</option>`).join('')}</select></div>
 <div class="emp-cnae"><label for="ecn">CNAE principal</label><div class="emp-cnae-r"><input id="ecn" inputmode="numeric" placeholder="Preenchido pelo CNPJ" value="${esc(pj.cnae_principal||'')}"><span id="ecnd" class="emp-cnae-d">${esc(((pj.cnaes||[]).find(x=>x.principal)||{}).descricao||'')}</span></div>
  <div class="ev-hint" id="ecnh">Atividade econômica principal da Receita Federal, trazida automaticamente pelo CNPJ. Serve de contexto: não é linha de fornecimento.</div></div>
 <div class="emp-wide"><label for="eda">O que a empresa faz (texto livre)</label><textarea id="eda" rows="3">${esc(pj.descricao_atividades||'')}</textarea></div></div>
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
const SUB_OP=[['oport','Linha de perfil'],['triagem','Pelos perfis de busca'],['radar','Ranking dos perfis'],['oportunidades','Pesquisa ampla']];
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
 main.innerHTML=subnav(SUB_OP,'oport')+`<div class="top"><div><h2>Licitações da linha de perfil</h2><p class="sub">Encontradas pela linha de fornecimento: primeiro as confirmadas por código ou classificação, depois as possíveis para revisar.</p></div></div>
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

// ------------------------------------------------------------------ triagem: o que o Radar trouxe e você ainda não decidiu
TELAS.triar='Triagem';
V.triar=async()=>{
 const F=window.__TRF=Object.assign({pag:0,conf:null},window.__TRF||{});
 const R=await rpc('resumo_linha').catch(()=>null)||{};
 const topo=`<div class="top"><div><h2>Triagem</h2><p class="sub">Licitações abertas que o Radar encontrou na sua linha e que você ainda não avaliou. Decida rápido: <b>Tenho interesse</b> leva para Minhas licitações; <b>Descartar</b> tira daqui.</p></div></div>`;
 if(!(R.linhas_incluir>0)){main.innerHTML=topo+pend('Cadastre a linha de fornecimento para o Radar trazer licitações',`<button onclick="ir('empresa',{aba:'linha'})">Cadastrar linha de fornecimento</button>`,'Enquanto isso, use a pesquisa ampla em Radar › Licitações abertas.');return;}
 const rows=await rpc('oportunidades_linha',{p_conf:F.conf,p_limite:20,p_offset:F.pag*20,p_so_novas:true});
 const tot=rows&&rows.length?Number(rows[0].total):0;
 main.innerHTML=topo+`<div class="ev-sub">${[[null,'Todas'],['confirmada','Confirmadas na linha'],['revisar','Possíveis, para revisar']].map(([k,rt])=>`<button type="button" class="${F.conf===k?'on':''}" onclick="window.__TRF={pag:0,conf:${k?`'${k}'`:'null'}};V.triar()">${rt}</button>`).join('')}</div>
 <p class="ev-hint">${fmtN(tot)} licitação(ões) para triar.</p>
 <div class="ev-cards">${(rows||[]).map(o=>trCard(o)).join('')||pend('Nada para triar agora','',"Quando o Radar encontrar novas licitações na sua linha, elas aparecem aqui.")}</div>
 ${tot>20?`<div class="ev-actions" style="justify-content:center">${F.pag>0?`<button class="sec" onclick="window.__TRF.pag--;V.triar()">Anteriores</button>`:''}<span class="ev-hint">Página ${F.pag+1} de ${Math.ceil(tot/20)}</span>${(F.pag+1)*20<tot?`<button class="sec" onclick="window.__TRF.pag++;V.triar()">Próximas</button>`:''}</div>`:''}`;
};
function trCard(o){
 const h=cardLic(o,{corresp:o,interesse:o.interesse});
 // troca o rodapé de ações por decisões de triagem
 return h.replace(/<footer class="lc-acts">[\s\S]*<\/footer>/,`<footer class="lc-acts"><div class="lc-l">${o.link_pncp?`<a class="gh" href="${esc(o.link_pncp)}" target="_blank" rel="noopener">${ic('ext')}PNCP</a>`:''}</div><div class="lc-r"><button class="sec" onclick="triar(${o.id},'arquivada',this)">Descartar</button><button class="sec" onclick="triar(${o.id},'a_analisar',this)">Tenho interesse</button><button class="lc-go" onclick="analisarViab(${o.id},this)">Analisar viabilidade</button></div></footer>`);
}
async function triar(id,st,btn){const card=btn.closest('article,.lc');try{await rpc('triar_oportunidade',{p_oportunidade:Number(id),p_status:st});
 if(card){card.style.transition='opacity .2s';card.style.opacity='0';setTimeout(()=>card.remove(),200);}
 toast(st==='arquivada'?'Descartada (fica em Minhas licitações › Descartadas)':'Enviada para Minhas licitações','Abrir',()=>{window.__INTF=st==='arquivada'?'descartadas':'analisar';ir('interesses');});}catch(e){toast(e.message);}}

// ------------------------------------------------------------------ minhas licitações: análise → participação → resultado
TELAS.interesses='Minhas licitações';
const ETAPAS_INT=[['analisar','A analisar',['a_analisar']],['analise','Em análise',['em_analise']],['participar','Vou participar',['viavel']],['enviada','Proposta enviada',['proposta_enviada']],['resultado','Resultado',['ganha','perdida']],['descartadas','Descartadas',['inviavel','arquivada']]];
V.interesses=async()=>{
 const rows=await rpc('listar_interesses',{p_status:null})||[];
 const cont=e=>rows.filter(x=>e[2].includes(x.status)).length;
 let at=window.__INTF;if(!ETAPAS_INT.some(e=>e[0]===at))at=(ETAPAS_INT.find(e=>e[0]!=='descartadas'&&cont(e))||ETAPAS_INT[0])[0];
 const et=ETAPAS_INT.find(e=>e[0]===at),lst=rows.filter(x=>et[2].includes(x.status));
 const DIC={analisar:'Você marcou interesse na Triagem. Abra a análise de viabilidade para calcular custo, lance mínimo, lucro e caixa.',analise:'Análises em andamento. Termine os dados que faltam e decida se vai participar.',participar:'Você decidiu participar. Prepare documentos e proposta; quando enviar, marque “Proposta enviada”.',enviada:'Aguardando a sessão ou o resultado. Registre se ganhou ou perdeu.',resultado:'Histórico de resultados.',descartadas:'Licitações que você descartou ou decidiu não disputar.'};
 main.innerHTML=`<div class="top"><div><h2>Minhas licitações</h2><p class="sub">Acompanhe cada licitação da análise ao resultado. As etapas são internas: nada é enviado ao órgão.</p></div></div>
 <div class="ev-sub">${ETAPAS_INT.map(e=>`<button type="button" class="${e[0]===at?'on':''}" onclick="window.__INTF='${e[0]}';V.interesses()">${e[1]} <span class="n">${cont(e)}</span></button>`).join('')}</div>
 <p class="ev-hint">${DIC[at]}</p>
 <div class="ev-cards">${lst.map(intCard).join('')||pend(at==='analisar'?'Nada esperando análise':'Nenhuma licitação nesta etapa',at==='analisar'?`<button onclick="ir('triar')">Ir para a Triagem</button>`:'',at==='analisar'?'Na Triagem, toque em “Tenho interesse” ou “Analisar viabilidade”.':'')}</div>`;
};
function intCard(x){
 const d=dias(x.data_fim_proposta),r=x.resultado||{};
 return `<article class="lc"><header class="lc-h"><span></span><div><div class="lc-chips"><span class="chip ${ST_INT_COR[x.status]}">${ST_INT[x.status]}</span>${d!=null?`<span class="chip c-${prazoCor(d)}">${evi('clock')}${prazoTxt(d)}</span>`:''}${x.situacao&&x.situacao!=='Divulgada no PNCP'?`<span class="chip c-red">${esc(x.situacao)}</span>`:''}${x.mudancas&&x.mudancas.length?`<span class="chip c-amber">! Mudou: ${esc(x.mudancas.join(', '))}</span>`:''}</div>
 <h3 class="lc-obj">${esc(x.objeto||'')}</h3><div class="lc-org"><span>${evi('bank')}<b>${esc(x.orgao_nome||'')}</b></span><span>${evi('pin')}${esc([x.municipio,x.uf].filter(Boolean).join('/'))}</span></div></div><div></div></header>
 <div class="lc-facts"><div><span>Valor estimado</span><b class="mono">${x.valor_sigiloso?'Sigiloso':brl(x.valor_estimado)}</b></div><div><span>Propostas até</span><b>${dt(x.data_fim_proposta)}</b></div>
  <div><span>Última análise</span><b>${x.analisado_em?dt(x.analisado_em):'Ainda não salva'}</b>${r.recomendacao?`<small>${esc(r.recomendacao.tipo==='incompleta'?'Análise incompleta':r.recomendacao.tipo==='favoravel'?'Sem alerta crítico':'Com pontos de atenção')}</small>`:''}</div>
  <div><span>Lance mínimo</span><b class="mono">${r.total&&r.total.minimo!=null?mfmt(r.total.minimo,r.moeda||'BRL'):'—'}</b>${r.total&&r.total.margem!=null?`<small>margem no lance ${pctFmt(r.total.margem)}</small>`:''}</div></div>
 ${x.mudancas&&x.mudancas.length?'<div class="lc-body"><p class="lc-note"><span>!</span><span>Os dados oficiais mudaram desde a última análise salva. Revise os pontos indicados.</span></p></div>':''}
 <footer class="lc-acts"><div class="lc-l">${x.link_pncp?`<a class="gh" href="${esc(x.link_pncp)}" target="_blank" rel="noopener">${ic('ext')}PNCP</a>`:''}</div><div class="lc-r"><button class="lc-go" onclick="ir('analise',{id:'${x.id}'})">${x.analisado_em?'Abrir análise':'Analisar viabilidade'}</button></div></footer></article>`;
}

// ------------------------------------------------------------------ análise de viabilidade (v2: orientada ao lance)
// Responde: quanto custa executar, qual preço propor e até onde baixar, quanto lucro e se há caixa até o órgão pagar.
// Os valores vêm de regras determinísticas (painel/viab.js). A IA só lê o edital para preencher premissas, sempre com origem indicada.
TELAS.analise='Análise de viabilidade';
const AN_ABAS=[['itens','1 · Itens e custo'],['premissas','2 · Premissas'],['cen','3 · Cenários e caixa'],['docs','4 · Documentos'],['decisao','5 · Decisão']];
const JULG={item:'Menor preço por item',lote:'Menor preço por lote (global)',desconto:'Maior desconto'};
const ORIG={cotacao:['c-blue','Cotação do dia'],pncp:['c-blue','PNCP'],ia:['c-violet','IA · edital'],voce:['c-mut','Você'],empresa:['c-green','Minha empresa'],padrao:['c-amber','Padrão'],compras:['c-blue','Compras.gov.br'],cnpj:['c-blue','CNPJ'],cnae:['c-blue','Pelo CNAE'],ia_anexo:['c-violet','Sugerido pela IA']};
const origem=k=>{const o=ORIG[k];return o?`<span class="chip ${o[0]} an-or">${o[1]}</span>`:'';};
V.analise=async()=>{
 const id=(window.ARG&&window.ARG.id)||window.__ANID;if(!id){ir('interesses');return;}window.__ANID=id;
 const {data:li,error}=await sb.from('licitacoes_interesse').select('*').eq('id',id).maybeSingle();
 if(error||!li){main.innerHTML=pend('Análise não encontrada','',"Ela pode ter sido criada em outra organização.");return;}
 const [{data:op},{data:itens},{data:an},linhas,{data:pjs},{data:co}]=await Promise.all([
  sb.from('oportunidades').select('id,numero_controle_pncp,objeto,orgao_nome,unidade_nome,uf,municipio,esfera,modalidade,modo_disputa,srp,valor_estimado,valor_sigiloso,data_publicacao,data_inicio_proposta,data_fim_proposta,situacao,link_pncp,atualizado_em,itens_em').eq('id',li.oportunidade_id).maybeSingle(),
  sb.from('oportunidade_itens').select('*').eq('oportunidade_id',li.oportunidade_id).order('numero_item'),
  sb.from('edital_analise').select('dados,fonte,analisado_em').eq('oportunidade_id',li.oportunidade_id).maybeSingle(),
  rpc('minha_linha').catch(()=>[]),
  sb.from('pessoas_juridicas').select('id,uf,municipio,razao_social,cnae_principal,tributacao').order('propria',{ascending:false}).limit(1),
  sb.from('correspondencias').select('confianca,motivo,evidencia').eq('fonte','licitacao').eq('ref_id',li.oportunidade_id).maybeSingle()]);
 const pj=(pjs||[])[0],T=(pj&&pj.tributacao)||{};
 const cods=[...new Set((itens||[]).filter(i=>i.cat_codigo).map(i=>i.cat_codigo))];
 const {data:nos}=cods.length?await sb.from('cat_nos').select('tipo,nivel,codigo,caminho').in('codigo',cods):{data:[]};
 const no=(i)=>(nos||[]).find(n=>n.tipo===i.cat_tipo&&n.nivel===i.cat_nivel&&n.codigo===i.cat_codigo);
 const comp={};(itens||[]).forEach(i=>{const n=no(i);if(!n){comp[i.numero_item]=i.cat_codigo?'sem_no':'sem_codigo';return;}
  const bate=l=>l.tipo===i.cat_tipo&&n.caminho[l.nivel]===l.codigo;const inc=(linhas||[]).some(l=>l.modo==='incluir'&&bate(l)),exc=(linhas||[]).some(l=>l.modo==='excluir'&&bate(l));
  comp[i.numero_item]=exc?'excluido':inc?'compativel':'fora';});
 let docs=null;if(pj){docs=await habConferir(pj.id,op&&op.data_fim_proposta).catch(()=>null);}
 const P=anPremissas(li.premissas||{},li,itens||[],comp,an&&an.dados||{},T);
 if(!P.moeda){P.moeda=/internacional/i.test(((op&&op.objeto)||'')+' '+((op&&op.modalidade)||''))?'USD':'BRL';if(P.moeda==='USD')P.origem.moeda='pncp';}
 const mesma=window.__AN&&window.__AN.li&&window.__AN.li.id===li.id;
 window.__AN={li,op:op||{},itens:itens||[],an,linhas:linhas||[],pj,T,co,comp,docs,nos:nos||[],P,aba:mesma&&AN_PANE[window.__AN.aba]?window.__AN.aba:'itens',sujo:!li.premissas||li.premissas.v!==2};
 anRender();anHistorico();anCambio();
};
// premissas v2 (converte análises salvas no formato antigo sem perder o que foi digitado)
function anPremissas(P0,li,itens,comp,D,T){
 const P=JSON.parse(JSON.stringify(P0||{}));
 if(P.v!==2){
  const it={};Object.keys(P.custo||{}).forEach(n=>{it[n]=Object.assign(it[n]||{},{custo_unit:P.custo[n]});});
  Object.keys(P.qtd||{}).forEach(n=>{it[n]=Object.assign(it[n]||{},{qtd_sim:P.qtd[n]});});
  Object.keys(P.imp||{}).forEach(n=>{it[n]=Object.assign(it[n]||{},{importado_pct:P.imp[n]});});
  const G=P.giro||{};
  const novo={v:2,sel:P.sel||null,lotes:P.lotes||{},julgamento:null,precisao:2,modo_custo:Object.keys(P.custo||{}).length?'detalhado':'rapido',it,
   custos:(P.custos||[]).map(l=>Object.assign({},l,{base:l.base==='fixo'?'contrato':l.base,grupo:'indireta'})),
   tributos:(P.pct_receita||[]).map(x=>({nome:x.nome,tipo:'pct',base:'receita',valor:x.pct,natureza:'devido',status:x.status})),
   margem_min:P.margem_min??null,margem_alvo:P.margem_desejada??null,regime:P.regime||'',
   operacao:{prazo_fornecedor:G.prazo_fornecedor??null,prazo_entrega:G.prazo_entrega??null,prazo_recebimento:G.prazo_recebimento??null,atraso:G.atraso??null,entregas:G.parcelas??1,taxa_mensal:G.taxa_mensal??null},
   lances:{},unidade:null,cenarios:JSON.parse(JSON.stringify(VIAB.CEN2)),srp_cfg:{},origem:{}};
  Object.keys(P).forEach(k=>delete P[k]);Object.assign(P,novo);
 }
 P.it=P.it||{};P.lotes=P.lotes||{};P.custos=P.custos||[];P.tributos=P.tributos||[];P.operacao=P.operacao||{};P.lances=P.lances||{};P.origem=P.origem||{};
 P.cenarios=P.cenarios||JSON.parse(JSON.stringify(VIAB.CEN2));P.srp_cfg=P.srp_cfg||{};P.hist_info=P.hist_info||{};
 // tributos automáticos pelo perfil da empresa, salvo se o usuário alterou nesta análise
 if(P.trib_auto===undefined)P.trib_auto=!P.tributos.some(x=>x.valor!=null);
 const pad=(path,v,o)=>{const ks=path.split('.');let x=P;for(let i=0;i<ks.length-1;i++){x=x[ks[i]]=x[ks[i]]||{};}const k=ks[ks.length-1];if(x[k]==null&&v!=null){x[k]=v;P.origem[path]=o;}};
 T=T||{};
 pad('margem_min',T.margem_min??10,T.margem_min!=null?'empresa':'padrao');pad('margem_alvo',T.margem_alvo??20,T.margem_alvo!=null?'empresa':'padrao');
 pad('operacao.prazo_fornecedor',T.prazo_fornecedor??0,T.prazo_fornecedor!=null?'empresa':'padrao');
 if(T.caixa!=null)pad('operacao.caixa',T.caixa,'empresa');if(T.credito!=null)pad('operacao.credito',T.credito,'empresa');
 pad('operacao.entregas',1,'padrao');
 if(!P.sel)P.sel=(li.itens_sel&&li.itens_sel.length)?li.itens_sel:itens.filter(i=>comp[i.numero_item]==='compativel').map(i=>i.numero_item);
 if(!P.tributos.length)P.tributos=[{nome:'Tributos sobre a venda (alíquota efetiva)',tipo:'pct',base:'receita',valor:null,natureza:'devido',status:'estimado'}];
 // pré-preenchimento pelo que a IA leu no edital (só campos vazios; a origem fica indicada até você editar)
 const txt=v=>v==null?'':String(typeof v==='object'?JSON.stringify(v):v);
 const diasDe=s=>{const m=txt(s).match(/(\d{1,3})\s*(?:\(\w+\)\s*)?dias/i);return m?Number(m[1]):null;};
 const mesesDe=s=>{const m=txt(s).match(/(\d{1,2})\s*(?:\(\w+\)\s*)?mes(es)?/i);return m?Number(m[1]):null;};
 if(!P.julgamento){const c=txt(D.criterio_julgamento).toLowerCase();P.julgamento=/desconto/.test(c)?'desconto':/lote|global|grupo/.test(c)?'lote':'item';if(c)P.origem.julgamento='ia';}
 const O=P.operacao;
 if(O.prazo_entrega==null&&diasDe(D.prazo_entrega)!=null){O.prazo_entrega=diasDe(D.prazo_entrega);P.origem['operacao.prazo_entrega']='ia';}
 if(O.prazo_recebimento==null&&diasDe(D.pagamento)!=null){O.prazo_recebimento=diasDe(D.pagamento);P.origem['operacao.prazo_recebimento']='ia';}
 if(O.meses==null&&mesesDe(D.vigencia)!=null){O.meses=mesesDe(D.vigencia);P.origem['operacao.meses']='ia';}
 if(O.prazo_entrega==null){O.prazo_entrega=30;P.origem['operacao.prazo_entrega']='padrao';}
 if(O.prazo_recebimento==null){O.prazo_recebimento=30;P.origem['operacao.prazo_recebimento']='padrao';}
 return P;
}
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
 const usd=P.moeda==='USD',cb=Number(P.cambio)>0?Number(P.cambio):null,conv=v=>v==null?null:usd?(cb?Math.round(v/cb*100)/100:null):v;
 return {moeda:P.moeda||'BRL',julgamento:P.julgamento,precisao:P.precisao,modo_custo:P.modo_custo,srp:!!A.op.srp,srp_cfg:P.srp_cfg,
  pend_moeda:usd&&!cb,
  itens:A.itens.filter(i=>P.sel.includes(i.numero_item)).map(i=>{const it=Object.assign({},P.it[i.numero_item]||{});if(P.origem[`it.${i.numero_item}.historico`]==='compras')it.historico=conv(it.historico);
   return Object.assign({n:i.numero_item,descricao:i.descricao,unidade:i.unidade||'',qtd:i.quantidade,ref:i.sigiloso?null:conv(i.valor_unitario),lote:P.lotes[i.numero_item]||''},it);}),
  custos:P.custos,tributos:P.trib_auto?anTribAuto().tributos:P.tributos,pend_extra:[...(P.trib_auto?anTribAuto().pend:[]),...(P.moeda==='USD'&&!(Number(P.cambio)>0)?['Informe a cotação do dólar para converter os valores do PNCP.']:[])],margem_min:P.margem_min,margem_alvo:P.margem_alvo,operacao:P.operacao,lances:P.lances,cenarios:P.cenarios};
}
function anTribAuto(){const A=window.__AN;return VIAB.tributacao(A.T,{esfera:A.op.esfera});}
function anCalc(){
 const A=window.__AN,E=anEntrada(),r=VIAB.analisar(E);
 const us=r.unidades;const semCusto=new Set(r.itens.filter(i=>!(i.custo>0)&&!((A.P.it[i.n]||{}).custo_total_est===0||(A.P.it[i.n]||{}).custo_unit===0)).map(i=>i.n));
 us.forEach(x=>{x.sem_custo=x.itens.filter(n=>semCusto.has(n));});
 // sem escolha do usuário: mostra a primeira unidade com todos os custos informados
 let u=us.find(x=>x.id===A.P.unidade)||us.find(x=>!x.sem_custo.length)||us[0]||null;
 return {E,r,u,us,docsPend:(A.docs||[]).filter(d=>d.s!=='ok').length};
}
// entrada numérica: digitação atualiza o painel na hora; vazio fica vazio (≠ zero)
const nIn=(path,v,extra='')=>`<input type="number" step="any" inputmode="decimal" data-p="${path}" value="${v==null?'':v}" oninput="anSet(this,1)" onchange="anSet(this)" ${extra}>`;
const tIn=(path,v,extra='')=>`<input data-p="${path}" value="${esc(v==null?'':v)}" onchange="anSet(this)" ${extra}>`;
const sIn=(path,v,ops,extra='')=>`<select data-p="${path}" onchange="anSet(this)" ${extra}>${Object.entries(ops).map(([k,r])=>`<option value="${k}" ${String(k)===String(v)?'selected':''}>${r}</option>`).join('')}</select>`;
const anOrig=path=>origem((window.__AN.P.origem||{})[path]);

// ---------- moeda: reais (R$ 1.234,56) ou dólar em licitação internacional (USD $ 1,234.56)
function anMoeda(){const A=window.__AN;return (A&&A.P&&A.P.moeda)||'BRL';}
function mfmt(v,m){if(v==null||isNaN(v))return '—';m=m||anMoeda();const n=Number(v);return m==='USD'?'USD $ '+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
// digitação "da direita para a esquerda": cada número entra nos centavos; sem ponto/vírgula para errar
const mIn=(path,v,extra='',m)=>`<input type="text" inputmode="numeric" autocomplete="off" class="an-money" data-p="${path}" data-m="1" data-cur="${m||''}" value="${v==null?'':mfmt(v,m)}" placeholder="${(m||anMoeda())==='USD'?'USD $ 0.00':'R$ 0,00'}" oninput="anMask(this)" ${extra}>`;
const pIn=(path,v,extra='')=>`<input type="text" inputmode="numeric" autocomplete="off" class="an-money" data-p="${path}" data-m="pct" value="${v==null?'':Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%'}" placeholder="0,00%" oninput="anMask(this)" ${extra}>`;
function anMaskVal(el){const d=el.value.replace(/\D/g,'').replace(/^0+(?=\d)/,'').slice(0,13);if(!d)return null;return Number(d)/100;}
function anMask(el){
 const v=anMaskVal(el);
 el.value=v==null?'':el.dataset.m==='pct'?v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%':mfmt(v,el.dataset.cur||undefined);
 try{const p=el.dataset.m==='pct'?el.value.length-1:el.value.length;el.setSelectionRange(p,p);}catch(e){}
 if(el.id==='anLance')return anLance(el,v);
 const A=window.__AN,path=el.dataset.p.split('.');let o=A.P;for(let i=0;i<path.length-1;i++){const k=isNaN(path[i])?path[i]:Number(path[i]);if(o[k]==null)o[k]={};o=o[k];}
 const k=path[path.length-1];o[isNaN(k)?k:Number(k)]=v;delete A.P.origem[el.dataset.p];A.sujo=true;anAtualizar();
}
function anGet(path){let o=window.__AN.P;for(const k of path.split('.')){if(o==null)return null;o=o[isNaN(k)?k:Number(k)];}return o;}
function anSet(el,leve){
 const A=window.__AN,P=A.P,path=el.dataset.p.split('.');let v=el.type==='checkbox'?el.checked:el.value;
 if(el.type==='number'||el.dataset.n!==undefined)v=v===''?null:Number(v);
 let o=P;for(let i=0;i<path.length-1;i++){const k=isNaN(path[i])?path[i]:Number(path[i]);if(o[k]==null)o[k]={};o=o[k];}
 const k=path[path.length-1];o[isNaN(k)?k:Number(k)]=v;delete P.origem[el.dataset.p];A.sujo=true;
 if(leve){anAtualizar();return;}
 if(el.tagName==='SELECT'||el.type==='checkbox')anRender();else anAtualizar();
}
function anMut(fn){fn(window.__AN.P);window.__AN.sujo=true;anRender();}
function anAba(k){window.__AN.aba=k;anRender();const t=document.querySelector('.an-tabs');if(t)t.scrollIntoView({block:'start'});}
function anUnid(id){window.__AN.P.unidade=id;anRender();}
// atualização leve: painel de estratégia + quadros calculados da etapa atual
function anAtualizar(){const C=anCalc(),ae=document.activeElement,livre=el=>el&&!(ae&&el.contains(ae));const t=$('#anTop');if(t){if(livre(t))t.innerHTML=anTopo(C);else anTopoParcial(C);}const o=$('#anOut');if(livre(o))o.innerHTML=(AN_OUT[window.__AN.aba]||(()=>''))(C);const o2=$('#anOut2');if(livre(o2))o2.innerHTML=anCaixaOut(C);const b2=$('#anSalvar');document.querySelectorAll('[id^=cu]').forEach(td=>{const n=td.id.slice(2),i=window.__AN.itens.find(x=>String(x.numero_item)===n),it=window.__AN.P.it[n]||{},q=it.qtd_sim??(i&&i.quantidade);td.textContent=it.custo_total_est!=null&&q?mfmt(it.custo_total_est/q):'—';});const b=$('#anSalvar');if(b){b.className='';b.textContent='Salvar análise';}}
function anRender(){
 const A=window.__AN,{op}=A,C=anCalc();
 main.innerHTML=`<div class="top"><div><h2>Análise de viabilidade</h2><p class="sub">${esc((op.objeto||'').slice(0,180))}</p><p class="ev-hint">${esc(op.orgao_nome||'')}${op.uf?' · '+esc([op.municipio,op.uf].filter(Boolean).join('/')):''}${op.data_fim_proposta?' · propostas até '+dt(op.data_fim_proposta):''}</p></div>
  <div class="ev-actions" style="margin:0"><span class="chip ${ST_INT_COR[A.li.status]}">${ST_INT[A.li.status]}</span><button id="anSalvar" onclick="anSalvar()" class="${A.sujo?'':'sec'}">${A.sujo?'Salvar análise':'Salva'}</button></div></div>
 <section class="card an-top" id="anTop" aria-live="polite">${anTopo(C)}</section>
 <div class="ev-tabs an-tabs" role="tablist">${AN_ABAS.map(([k,rt])=>`<button type="button" class="${A.aba===k?'on':''}" onclick="anAba('${k}')">${rt}${k==='docs'&&C.docsPend?`<span class="n c-red">${C.docsPend}</span>`:''}${k==='decisao'&&C.r.pendencias.length?`<span class="n c-amber">${C.r.pendencias.length}</span>`:''}</button>`).join('')}</div>
 <div class="an-pane">${AN_PANE[A.aba](C)}</div>
 <div class="ev-actions an-nav">${(()=>{const i=AN_ABAS.findIndex(x=>x[0]===A.aba);return `${i>0?`<button class="sec" onclick="anAba('${AN_ABAS[i-1][0]}')">← ${AN_ABAS[i-1][1].replace(/^\d · /,'')}</button>`:'<span></span>'}${i<AN_ABAS.length-1?`<button onclick="anAba('${AN_ABAS[i+1][0]}')">${AN_ABAS[i+1][1].replace(/^\d · /,'')} →</button>`:''}`;})()}</div>`;
}
// ---------- painel de estratégia (topo)
const p2=v=>v==null||isNaN(v)?'—':(v*100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';
const sN=(path,v,ops,ph)=>{const has=ops.some(o=>String(o[0])===String(v));return `<select data-p="${path}" data-n onchange="anSet(this)">${ph!==undefined?`<option value="" ${v==null?'selected':''}>${ph}</option>`:''}${!has&&v!=null?`<option value="${v}" selected>${esc(String(v))}</option>`:''}${ops.map(([k,rt])=>`<option value="${k}" ${String(k)===String(v)?'selected':''}>${rt}</option>`).join('')}</select>`;};
const DIAS=[0,5,7,10,14,15,20,21,28,30,45,60,90,120].map(d=>[d,d===0?'No mesmo dia (0)':d+' dias']);
const REAIS_V=[0,5e3,1e4,2.5e4,5e4,1e5,2.5e5,5e5,1e6,2e6,5e6];
function anTopoK(C){
 const {r,u,us}=C,A=window.__AN;
 const st=r.erros.length?['c-red','Premissas inconsistentes']:r.parcial?['c-amber','Cálculo parcial']:['c-green','Cálculo completo'];
 const un=u.unit,suf=un?` <small>/ ${esc(u.unidade||'un.')}</small>`:'';
 const semNada=u.sem_custo&&u.sem_custo.length===u.itens.length;
 const val=(a,b)=>semNada?'—':un?mfmt(a):mfmt(b);
 const L=semNada?null:u.lance,cx=u.caixa;
 return `<div class="an-top-h"><div><span class="an-k">Estratégia de lance</span>${us.length>1?`<div class="an-un">${us.map(x=>`<button type="button" class="${x.id===u.id?'on':''}" onclick="anUnid('${x.id}')">${esc(x.nome)}${x.sem_custo&&x.sem_custo.length?' <small>· sem custo</small>':''}</button>`).join('')}</div>`:`<b class="an-un1">${esc(u.nome)} · ${fmtN(u.Q,2)} ${esc(u.unidade||'')}</b>`}</div><span class="chip ${st[0]}">${st[1]}</span></div>
 ${semNada?`<div class="an-vazio"><b>Informe o custo para calcular o lance.</b><span>${u.itens.length>1?'Os itens '+u.itens.join(', ')+' ainda não têm':'O item '+u.itens[0]+' ainda não tem'} custo. É o único dado que só a sua empresa tem.</span><button onclick="anAba('itens')">Informar custo</button></div>`:`<div class="an-kpis">
  <div><span>Preço de equilíbrio</span><b>${val(u.equilibrio,u.equilibrio_total)}${u.equilibrio!=null?suf:''}</b><small>lucro zero</small></div>
  <div class="an-k-min"><span>Lance mínimo recomendado</span><b>${val(u.minimo,u.minimo_total)}${u.minimo!=null?suf:''}</b><small>${r.mMin!=null?'margem mínima '+pctFmt(r.mMin*100):'informe a margem mínima'}</small></div>
  <div><span>Preço para a margem-alvo</span><b>${val(u.alvo,u.alvo_total)}${u.alvo!=null?suf:''}</b><small>${r.mAlvo!=null?'margem '+pctFmt(r.mAlvo*100):'informe a margem-alvo'}</small></div>
  <div class="${L&&L.lucro<0?'neg':L&&L.folga!=null&&L.folga<0?'warn':''}"><span>Lucro no lance simulado</span><b>${L?mfmt(L.lucro):'—'}</b><small>${L?'margem '+p2(L.margem):'—'}</small></div>
  <div class="${cx.ok&&cx.falta>0?'neg':''}"><span>Capital de giro necessário</span><b>${cx.ok?mfmt(cx.capital):'Pendente'}</b><small>${cx.ok?(cx.falta==null?'informe o caixa':cx.falta>0?'faltam '+mfmt(cx.falta):'coberto'):'faltam prazos'}</small></div>
 </div>`}`;
}
function anTopoF(C){
 const {r,u}=C,F=u.frases||{};
 if(u.sem_custo&&u.sem_custo.length===u.itens.length)return '';
 return `${u.sem_custo&&u.sem_custo.length?`<p class="lc-note"><span>!</span><span>Falta o custo ${u.sem_custo.length>1?'dos itens '+u.sem_custo.join(', '):'do item '+u.sem_custo[0]}: até você informar, os valores acima tratam esse custo como zero. <a class="l" onclick="anAba('itens')">Informar custo</a></span></p>`:''}
 ${Object.keys(F).length?`<ul class="an-fr">${F.margem?`<li><b>Margem</b>${esc(F.margem)}</li>`:''}${F.limite?`<li><b>Limite na disputa</b>${esc(F.limite)}</li>`:''}${F.caixa?`<li><b>Caixa</b>${esc(F.caixa)}</li>`:''}${F.edital?`<li><b>Edital</b>${esc(F.edital)}</li>`:''}${F.historico?`<li><b>Preço histórico</b>${esc(F.historico)}</li>`:''}</ul>`:''}
 ${r.parcial&&r.pendencias.length?`<p class="ev-hint an-pend">Faltam ${r.pendencias.length} dado(s): ${esc(r.pendencias[0])}${r.pendencias.length>1?` <a class="l" onclick="anAba('decisao')">ver todos</a>`:''}</p>`:''}`;
}
function anSimH(C){const u=C.u,L=u&&u.lance;if(!L||!L.R||(u.sem_custo&&u.sem_custo.length===u.itens.length))return '';return `${u.unit?`Total: ${mfmt(L.R)}`:u.tipo==='desconto'?`Valor: ${mfmt(L.R)}`:''}${u.lance_padrao?' · sem lance digitado, simulando o preço-alvo':''}`;}
function anTopo(C){
 const {u}=C,A=window.__AN;
 if(!u)return `<div class="an-vazio"><b>Escolha o que vai disputar.</b><span>Marque os itens e informe o custo para ver preço de equilíbrio, lance mínimo e lucro.</span><button onclick="anAba('itens')">Selecionar itens</button></div>`;
 const Lp=A.P.lances[u.id]||{},desc=u.tipo==='desconto';
 return `<div id="anTopK">${anTopoK(C)}</div>
 <div class="an-sim"><label for="anLance">Simular meu lance${desc?' (desconto)':u.unit?' (por '+esc(u.unidade||'unidade')+')':' (valor total)'}</label>
  <div>${desc?pIn('lance',Lp.desconto,'id="anLance"'):mIn('lance',Lp.valor,'id="anLance"')}<span class="ev-hint" id="anSimH">${anSimH(C)}</span></div></div>
 <div id="anTopF">${anTopoF(C)}</div>`;
}
function anTopoParcial(C){if(!C.u)return;const k=$('#anTopK'),f=$('#anTopF'),h=$('#anSimH');if(k)k.innerHTML=anTopoK(C);if(f)f.innerHTML=anTopoF(C);if(h)h.innerHTML=anSimH(C);}
function anLance(el,v){const A=window.__AN,u=anCalc().u;if(!u)return;
 A.P.lances[u.id]=Object.assign({},A.P.lances[u.id]||{},u.tipo==='desconto'?{desconto:v}:{valor:v});if(!u.unit&&u.tipo!=='desconto')delete A.P.lances[u.id].itens;A.sujo=true;
 const C2=anCalc();anTopoParcial(C2);const o=$('#anOut');if(o&&!o.contains(document.activeElement))o.innerHTML=(AN_OUT[A.aba]||(()=>''))(C2);const o2=$('#anOut2');if(o2)o2.innerHTML=anCaixaOut(C2);const b=$('#anSalvar');if(b){b.className='';b.textContent='Salvar análise';}}
async function anLerEdital(btn){btn.disabled=true;btn.textContent='Lendo o edital… (pode levar 1 minuto)';
 try{const tk=(await sb.auth.getSession()).data.session.access_token;const r=await fetch('/api/ia',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tk},body:JSON.stringify({acao:'analisar',oportunidade_id:window.__AN.op.id})}).then(x=>x.json());
  if(r.erro)throw new Error(r.erro);toast('Edital lido');V.analise();}catch(e){btn.disabled=false;btn.textContent='Ler o edital com IA';toast(e.message);}}
function anSel(n,on){anMut(P=>{P.sel=on?[...new Set([...P.sel,n])]:P.sel.filter(x=>x!==n);});anHistorico();}
function anSelTodos(modo){const A=window.__AN;anMut(P=>{P.sel=modo==='nenhum'?[]:A.itens.filter(i=>modo==='todos'||A.comp[i.numero_item]==='compativel').map(i=>i.numero_item);});}
// ---------- 2 · custos
function anCustos(C){
 const A=window.__AN,P=A.P,sel=A.itens.filter(i=>P.sel.includes(i.numero_item));
 if(!sel.length)return `<div class="card">${pend('Selecione os itens primeiro',`<button onclick="anAba('itens')">Ir para itens</button>`)}</div>`;
 const rap=P.modo_custo==='rapido';
 const lotes=[...new Set(sel.map(i=>P.lotes[i.numero_item]).filter(Boolean))];
 const stSel=(path,v)=>sIn(path,v==='confirmado'?'confirmado':'estimado',{estimado:'Estimado',confirmado:'Confirmado'});
 const linha=(l,k)=>`<div class="an-custo"><div><label>Categoria</label>${sIn(`custos.${k}.categoria`,l.categoria,Object.fromEntries((VIAB.GRUPOS2[l.grupo||'indireta']||VIAB.GRUPOS2.indireta).cats.map(c=>[c,c])))}</div>
  <div><label>Descrição</label>${tIn(`custos.${k}.descricao`,l.descricao,'placeholder="opcional"')}</div>
  <div><label>Como incide</label>${sIn(`custos.${k}.base`,l.base,VIAB.BASES2)}</div>
  <div><label>${l.base==='pct_receita'?'Percentual':'Valor'}</label>${l.base==='pct_receita'?pIn(`custos.${k}.valor`,l.valor):mIn(`custos.${k}.valor`,l.valor)}</div>
  ${sel.length>1?`<div><label>Aplica a</label>${sIn(`custos.${k}.alvo.tipo`,(l.alvo||{}).tipo||'todos',Object.assign({todos:'Todos os itens'},lotes.length?{lote:'Um lote'}:{},{item:'Um item'}))}</div>`:''}
  ${(l.alvo||{}).tipo==='lote'?`<div><label>Lote</label>${sIn(`custos.${k}.alvo.ref`,l.alvo.ref,Object.fromEntries(lotes.map(x=>[x,x])))}</div>`:''}
  ${(l.alvo||{}).tipo==='item'?`<div><label>Item</label>${sIn(`custos.${k}.alvo.ref`,l.alvo.ref,Object.fromEntries(sel.map(i=>[i.numero_item,'Item '+i.numero_item])))}</div>`:''}
  ${sel.length>1&&!['unidade','pct_receita'].includes(l.base)&&(l.alvo||{}).tipo!=='item'?`<div><label>Critério de rateio</label>${sIn(`custos.${k}.rateio`,l.rateio||'valor',{valor:'Pelo valor estimado',quantidade:'Pela quantidade',igual:'Igual entre itens'})}</div>`:''}
  <div><label>Situação</label>${stSel(`custos.${k}.status`,l.status)}</div>
  ${A.op.srp&&!['unidade','pedido','entrega','pct_receita'].includes(l.base)?`<div><label class="pf-sw"><input type="checkbox" style="width:auto" data-p="custos.${k}.comprometido" ${(l.comprometido??['contrato','lote'].includes(l.base))?'checked':''} onchange="anSet(this)"> existe mesmo sem pedidos</label></div>`:''}
  <div class="an-del"><button class="sec sm" onclick="anMut(P=>P.custos.splice(${k},1))" aria-label="Remover custo">Remover</button></div></div>`;
 const grupo=g=>{const G=VIAB.GRUPOS2[g],ls=P.custos.map((l,k)=>[l,k]).filter(([l])=>(l.grupo||'indireta')===g);
  return `<details class="an-grp" ${ls.length||g==='execucao'?'open':''}><summary><b>${G.nome}</b><span class="n">${ls.length}</span><small>${g==='produto'?'compra, fabricação, insumos, mão de obra, encargos, benefícios, equipamentos, subcontratação':g==='execucao'?'frete, seguro, embalagem, instalação, armazenagem, deslocamento, assistência, garantia':'mobilização, administração, custos compartilhados entre itens'}</small></summary>
   ${ls.map(([l,k])=>linha(l,k)).join('')||'<p class="ev-hint">Nada lançado.</p>'}
   <div class="ev-actions"><button class="sec sm" onclick="anMut(P=>P.custos.push({id:Date.now(),grupo:'${g}',categoria:'${G.cats[0]}',descricao:'',base:'${g==='indireta'?'contrato':g==='execucao'?'entrega':'unidade'}',valor:null,status:'estimado',alvo:{tipo:'todos'},rateio:'valor'}))">+ Adicionar em ${G.nome.toLowerCase()}</button></div></details>`;};
 return `<div class="card"><h3>Como você quer informar o custo?</h3>
  <div class="ev-sub an-modo"><button type="button" class="${rap?'on':''}" onclick="anMut(P=>P.modo_custo='rapido')">Estimativa rápida</button><button type="button" class="${rap?'':'on'}" onclick="anMut(P=>P.modo_custo='detalhado')">Composição detalhada</button></div>
  <p class="ev-hint">${rap?'Comece com o custo total de cada item (tudo o que você gasta para entregar, <b>sem os tributos sobre a venda</b>). Depois detalhe: quando houver composição, a soma dela passa a ser o custo.':'A soma da composição é o custo total desta simulação. Cada despesa é contada uma vez; despesas compartilhadas entre itens são rateadas pelo critério escolhido.'}</p></div>
 ${rap?`<div class="card"><h3>Custo total estimado por item</h3><div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Descrição</th><th>Qtd.</th><th>Custo total estimado (R$)</th><th>Situação</th></tr></thead><tbody>
  ${sel.map(i=>{const n=i.numero_item,it=P.it[n]||{};return `<tr><td>${n}</td><td>${esc((i.descricao||'').slice(0,90))}</td><td>${fmtN(it.qtd_sim??i.quantidade,2)} ${esc(i.unidade||'')}</td><td>${mIn(`it.${n}.custo_total_est`,it.custo_total_est,'min="0" placeholder="informe"')}</td><td>${stSel(`it.${n}.status`,it.status)}</td></tr>`;}).join('')}
  </tbody></table></div><p class="ev-hint">Na estimativa rápida o custo varia na mesma proporção da quantidade. Para ver a diluição de despesas fixas e o frete por entrega, use a composição detalhada.</p></div>`
 :`<div class="card"><h3>Produto ou serviço: custo por unidade</h3><p class="sub">Informe o custo por unidade de fornecimento do edital, ou a <b>cotação do fornecedor</b> se ele vende em outra unidade (ex.: caixa com 12).</p>
  ${sel.map(i=>{const n=i.numero_item,it=P.it[n]||{},ct=it.cotacao||{},usaCt=ct.preco_emb!=null||it.modo_ct;const R=C.r.itens.find(x=>x.n===n)||{};
   return `<div class="an-it"><div class="an-it-h"><b>Item ${n}</b><span>${esc((i.descricao||'').slice(0,110))}</span><small>${fmtN(it.qtd_sim??i.quantidade,2)} ${esc(i.unidade||'un.')} · cotação ${usaCt?'por embalagem':'por unidade'} <a class="l" onclick="anMut(P=>{P.it[${n}]=P.it[${n}]||{};P.it[${n}].modo_ct=${usaCt?'false':'true'};${usaCt?`if(P.it[${n}].cotacao)P.it[${n}].cotacao.preco_emb=null;`:''}})">${usaCt?'usar custo por unidade':'cotação em outra unidade'}</a></small></div>
   <div class="ev-form">${usaCt?`<div><label>Preço da embalagem (R$)</label>${mIn(`it.${n}.cotacao.preco_emb`,ct.preco_emb,'min="0" placeholder="informe"')}</div><div><label>${esc(i.unidade||'Unidades')} por embalagem</label>${nIn(`it.${n}.cotacao.unid_por_emb`,ct.unid_por_emb,'min="0" placeholder="ex.: 12"')}</div>
     <div><label>Compra mínima (embalagens)</label>${nIn(`it.${n}.cotacao.minimo_emb`,ct.minimo_emb,'min="0" placeholder="0"')}</div><div><label>Sobra da embalagem</label>${sIn(`it.${n}.cotacao.sobra`,ct.sobra||'custo',{custo:'Entra no custo deste contrato',estoque:'Fica em estoque (só caixa)'})}</div>`
     :`<div><label>Custo por ${esc(i.unidade||'unidade')} (R$)</label>${mIn(`it.${n}.custo_unit`,it.custo_unit,'min="0" placeholder="informe"')}</div>`}
     <div><label>Situação</label>${stSel(`it.${n}.status`,it.status)}</div><div><label>% importado (câmbio)</label>${nIn(`it.${n}.importado_pct`,it.importado_pct,'min="0" max="100" placeholder="0"')}</div></div>
   ${usaCt&&R.emb!=null?`<p class="ev-hint">Compra real: ${fmtN(R.emb)} embalagem(ns) = ${mfmt(R.desembolso)}${R.sobra>0?`; sobram ${fmtN(R.sobra,2)} ${esc(i.unidade||'un.')}`:''}. Custo por ${esc(i.unidade||'unidade')}: ${mfmt(R.q?R.direto/R.q:null)}.</p>`:''}</div>`;}).join('')}</div>
 <div class="card"><h3>Outras despesas</h3><p class="sub">Lance cada despesa uma vez, no grupo certo, dizendo como ela incide: por unidade, pedido, entrega, mês, contrato ou lote.</p>${['produto','execucao','indireta'].map(grupo).join('')}</div>`}
 <div class="card"><h3>Custo calculado</h3><div id="anOut">${anCustosOut(C)}</div></div>`;
}
function anCustosOut(C){
 const r=C.r;
 return `<div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Qtd.</th><th>Produto/serviço</th><th>Demais custos</th><th>Custo total</th><th>Por unidade</th><th>Desembolso</th></tr></thead><tbody>
  ${r.itens.map(i=>`<tr><td>${i.n}</td><td>${fmtN(i.q,2)}</td><td>${mfmt(i.direto)}</td><td>${mfmt(i.indireto)}</td><td><b>${mfmt(i.custo)}</b></td><td>${mfmt(i.q?i.custo/i.q:null)}</td><td>${mfmt(i.desembolso)}</td></tr>`).join('')}
  </tbody><tfoot><tr><th colspan="4">Total</th><th>${mfmt(r.itens.reduce((a,i)=>a+i.custo,0))}</th><th></th><th></th></tr></tfoot></table></div>
  ${r.memoria.length?`<details class="an-mem"><summary>Como cada despesa entrou</summary><ul class="an-ul">${r.memoria.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}
  ${r.avisos.map(a=>`<p class="lc-note"><span>!</span><span>${esc(a)}</span></p>`).join('')}`;
}
// ---------- 3 · tributos e margens
function anTrib(C){
 const A=window.__AN,P=A.P;
 const linha=(x,k)=>`<div class="an-custo"><div><label>Nome</label>${tIn(`tributos.${k}.nome`,x.nome)}</div>
  <div><label>Natureza</label>${sIn(`tributos.${k}.natureza`,x.natureza||'devido',{devido:'Tributo/taxa devido',retencao:'Retenção compensável'})}</div>
  ${x.natureza==='retencao'?`<div><label>% retido do faturamento</label>${pIn(`tributos.${k}.valor`,x.valor)}</div><div><label>Compensa em (dias após o recebimento)</label>${nIn(`tributos.${k}.compensa_dias`,x.compensa_dias,'min="0" placeholder="ex.: 30"')}</div>`
  :`<div><label>Forma</label>${sIn(`tributos.${k}.tipo`,x.tipo||'pct',{pct:'Percentual',unit:'R$ por unidade',fixo:'R$ fixo no contrato'})}</div>
   ${(x.tipo||'pct')==='pct'?`<div><label>Base de incidência</label>${sIn(`tributos.${k}.base`,x.base||'receita',{receita:'Sobre a venda (receita bruta)',custo:'Sobre o custo de compra'})}</div><div><label>Alíquota efetiva estimada (%)</label>${pIn(`tributos.${k}.valor`,x.valor)}</div>`
   :`<div><label>Valor</label>${mIn(`tributos.${k}.valor`,x.valor)}</div>`}`}
  <div><label>Situação</label>${sIn(`tributos.${k}.status`,x.status==='confirmado'?'confirmado':'estimado',{estimado:'Estimado',confirmado:'Confirmado'})}</div>
  <div class="an-del"><button class="sec sm" onclick="anMut(P=>P.tributos.splice(${k},1))">Remover</button></div></div>`;
 return `<div class="card"><h3>Tributos e taxas</h3><p class="sub">O sistema <b>não presume alíquotas pelo CNPJ</b>. Informe a alíquota efetiva que a empresa estima (ex.: Simples Nacional na sua faixa). <b>Retenção compensável</b> (IR, CSLL, INSS retidos pelo órgão) não é custo: reduz o recebimento imediato e volta depois, por isso só entra no caixa.</p>
  <div class="ev-form"><div style="grid-column:1/-1"><label>Regime tributário (anotação)</label>${tIn('regime',P.regime,'placeholder="Ex.: Simples Nacional, Anexo I, faixa 3"')}</div></div>
  ${P.tributos.map(linha).join('')||'<p class="ev-hint">Nenhum tributo lançado. Se de fato não houver, lance um com 0%.</p>'}
  <div class="ev-actions"><button class="sec sm" onclick="anMut(P=>P.tributos.push({nome:'Tributo sobre a venda',tipo:'pct',base:'receita',valor:null,natureza:'devido',status:'estimado'}))">+ Tributo ou taxa</button><button class="sec sm" onclick="anMut(P=>P.tributos.push({nome:'Retenção na fonte',tipo:'pct',base:'receita',valor:null,natureza:'retencao',compensa_dias:null,status:'estimado'}))">+ Retenção compensável</button></div></div>
 <div class="card"><h3>Meta comercial</h3><p class="sub">As duas margens são <b>sobre o valor da venda</b> (lucro ÷ receita), não sobre o custo.</p>
  <div class="ev-form"><div><label>Margem mínima aceitável (%)</label>${nIn('margem_min',P.margem_min,'min="0" max="99" placeholder="informe"')}<small class="ev-hint">É o seu limite interno na disputa: abaixo dela, não vale a pena baixar o lance.</small></div>
  <div><label>Margem-alvo (%)</label>${nIn('margem_alvo',P.margem_alvo,'min="0" max="99" placeholder="informe"')}<small class="ev-hint">O que você gostaria de ganhar; define o preço inicial sugerido.</small></div></div></div>
 <div class="card"><h3>Efeito no preço</h3><div id="anOut">${anTribOut(C)}</div></div>`;
}
function anTribOut(C){const r=C.r;return `<div class="dkv"><div><span>Percentuais sobre a venda (t)</span><b>${p2(r.t)}</b><small>${esc(r.tNomes.join(' + ')||'—')}</small></div>
 <div><span>Margem mínima</span><b>${r.mMin==null?'—':p2(r.mMin)}</b></div><div><span>Margem-alvo</span><b>${r.mAlvo==null?'—':p2(r.mAlvo)}</b></div>
 <div><span>Para cada R$ 100 vendidos</span><b>${r.mMin==null?'—':mfmt(100*(1-r.t-r.mMin))}</b><small>podem ir para custos mantendo a margem mínima</small></div></div>
 ${r.erros.map(e=>`<p class="lc-note bad"><span>!</span><span>${esc(e)}</span></p>`).join('')}`;}
function anCaixaOut(C){const u=C.u;if(!u)return '<p class="ev-hint">Selecione itens.</p>';const cx=u.caixa;
 if(!cx.ok)return `<p class="lc-note"><span>!</span><span>Capital de giro pendente: informe ${esc((cx.falta||[]).join(', '))}. A análise de preço e lucro continua valendo.</span></p>`;
 return `<div class="dkv"><div><span>Capital de giro necessário</span><b>${mfmt(cx.capital)}</b><small>maior déficit acumulado, no dia ${cx.dia}</small></div>
  <div><span>Falta depois do caixa e do crédito</span><b class="${cx.falta>0?'v-red':''}">${cx.falta==null?'Informe o caixa':mfmt(cx.falta)}</b>${cx.dia_falta!=null&&cx.falta>0?`<small>no dia ${cx.dia_falta}</small>`:''}</div>
  <div><span>Custo do dinheiro no período</span><b>${cx.custo_giro==null?'—':mfmt(cx.custo_giro)}</b></div></div>
  <div class="tbw"><table class="tb an-tb an-fluxo"><thead><tr><th>Dia</th><th>Evento</th><th>Valor</th><th>Saldo da operação</th><th>Com caixa e crédito</th></tr></thead><tbody>
  ${cx.serie.map(s=>`<tr><td>${s.dia}</td><td>${esc(s.evento)}</td><td class="${s.valor<0?'v-red':''}">${mfmt(s.valor)}</td><td class="${s.saldo<0?'v-red':''}">${mfmt(s.saldo)}</td><td class="${s.disponivel<0?'v-red':''}">${mfmt(s.disponivel)}</td></tr>`).join('')}</tbody></table></div>`;}
function anCenOut(C){
 const u=C.u;if(!u||!u.lance)return '<p class="ev-hint">Informe custos e margens para comparar cenários.</p>';
 const c=VIAB.cenarios2(C.E,u.id,window.__AN.P.cenarios);if(!c)return '';
 const nomes={base:'Base',conservador:'Conservador',srp_maxima:'Ata: quantidade máxima',srp_provavel:'Ata: quantidade provável',srp_menores:'Ata: pedidos menores',srp_sem_pedidos:'Ata: nenhum pedido'};
 const ks=Object.keys(c);
 return `<div class="tbw"><table class="tb an-tb"><thead><tr><th>Cenário</th><th>Quantidade</th><th>Lance mínimo</th><th>Lucro no lance</th><th>Margem</th><th>Capital de giro</th><th>Falta de caixa</th></tr></thead><tbody>
  ${ks.map(k=>{const x=c[k];if(x.vazio)return `<tr><td>${nomes[k]||k}</td><td>0</td><td>—</td><td class="${x.comprometido>0?'v-red':''}">${x.comprometido!=null?mfmt(-x.comprometido):'—'}</td><td>—</td><td>${x.caixa!=null?mfmt(-x.caixa):'—'}</td><td>—</td></tr>`;
   return `<tr><td>${nomes[k]||k}</td><td>${fmtN(x.Q,2)}</td><td>${u.unit?mfmt(x.minimo):mfmt(x.minimo_total)}</td><td class="${x.lucro<0?'v-red':''}">${mfmt(x.lucro)}</td><td>${p2(x.margem)}</td><td>${x.capital==null?'Pendente':mfmt(x.capital)}</td><td class="${x.falta>0?'v-red':''}">${x.falta==null?'—':mfmt(x.falta)}</td></tr>`;}).join('')}</tbody></table></div>
  ${c.srp_sem_pedidos&&c.srp_sem_pedidos.linhas.length?`<p class="ev-hint">Sem pedidos, você ainda arca com: ${esc(c.srp_sem_pedidos.linhas.join('; '))}. Marque em Custos o que existe mesmo sem pedidos.</p>`:c.srp_sem_pedidos?'<p class="ev-hint">Sem pedidos: nenhum custo marcado como comprometido (marque em Custos o que existe mesmo sem pedidos).</p>':''}`;
}
// ---------- 6 · documentos
function anDocs(C){
 const A=window.__AN,an=A.an,D=an&&an.dados||{},H=D.habilitacao||{},op=A.op||{};
 const S={ok:['c-green','✓','Anexado e válido na data'],falta:['c-red','!','Não anexado'],vencido:['c-red','!','Vencido'],vence_antes:['c-amber','!','Vence antes da sessão'],sem_validade:['c-amber','?','Sem data de validade']};
 return `<div class="card"><h3>Documentos da empresa × data da sessão</h3><p class="sub">Conferência dos documentos obrigatórios anexados em Habilitação, com validade até ${op.data_fim_proposta?dt(op.data_fim_proposta):'—'}. É uma verificação de cadastro, <b>não um parecer de habilitação</b>.</p>
  ${A.docs?A.docs.map(d=>{const s=S[d.s];return `<div class="hdoc" style="padding:9px 0"><div class="hdoc-st ${s[0]}">${s[1]}</div><div><div class="hdoc-nm">${esc(d.nome)}</div>${d.valido_ate?`<div class="hdoc-meta">válido até ${dt(d.valido_ate+'T12:00:00')}</div>`:''}</div><div class="hdoc-ac"><span class="chip ${s[0]}">${s[2]}</span></div></div>`;}).join('')+`<div class="ev-actions"><button class="sec" onclick="ir('habilitacao')">Abrir documentos de habilitação</button></div>`:'<p class="ev-hint">Cadastre a empresa para conferir os documentos.</p>'}</div>
 <div class="card"><h3>Exigências deste edital ${an?origem('ia'):''}</h3>
  ${an&&Object.keys(H).length?`<div class="dex">${Object.entries(H).map(([g,l])=>Array.isArray(l)&&l.length?`<div><h5>${esc(g.replace(/_/g,' '))}</h5><ul>${l.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'').join('')}</div>`:'<p class="sub">Sem leitura do edital por IA: confira as exigências no documento oficial.</p>'}
  ${an&&(D.riscos||[]).length?`<h4>Pontos de atenção lidos no edital</h4>${D.riscos.map(z=>`<p class="lc-note"><span>!</span><span><b>${esc(z.tema||'')}</b> ${esc(z.descricao||'')}</span></p>`).join('')}`:''}</div>`;
}
// ---------- 7 · resumo, memória de cálculo e decisão
function anDec(C){
 const A=window.__AN,{r,u}=C,st=A.li.status;
 const est=[...A.P.custos.filter(l=>l.status!=='confirmado').map(l=>`Custo estimado: ${l.categoria}${l.descricao?' – '+l.descricao:''}`),...A.P.tributos.filter(x=>x.status!=='confirmado').map(x=>`Tributo estimado: ${x.nome}`),...Object.entries(A.P.origem).map(([k])=>`Premissa lida por IA, a conferir: ${k.replace('operacao.','').replace(/_/g,' ')}`)];
 const BT=st==='viavel'||st==='proposta_enviada'?[['proposta_enviada','Proposta enviada'],['ganha','Ganhei'],['perdida','Perdi'],['em_analise','Voltar para análise','sec']]
  :[['viavel','Vou participar'],['inviavel','Não vou participar','sec'],['em_analise','Manter em análise','sec'],['arquivada','Descartar','sec']];
 return `<div class="card"><h3>Pendências e avisos</h3>${r.pendencias.length?`<p class="sub">Dados que faltam para o cálculo ficar completo:</p><ul class="an-ul">${r.pendencias.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:'<p class="ev-hint">Nenhum dado essencial faltando.</p>'}
  ${r.avisos.length?`<h4>Avisos</h4><ul class="an-ul">${r.avisos.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}
  ${est.length?`<h4>Depende de confirmação</h4><ul class="an-ul">${est.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</div>
 <div class="card"><h3>Memória de cálculo${u?' · '+esc(u.nome):''}</h3><div id="anOut">${anMemOut(C)}</div></div>
 <div class="card"><h3>Sua decisão</h3><p class="sub">O sistema não estima chance de vitória: a decisão é sua. Estes estados organizam suas licitações e não enviam nada ao órgão.</p>
  <textarea id="andec" rows="2" placeholder="Observação (opcional)">${esc(A.li.decisao_obs||'')}</textarea>
  <div class="ev-actions">${BT.map(([s,rt,c])=>`<button class="${c||''}" onclick="anDecidir('${s}')">${rt}</button>`).join('')}</div></div>`;
}
function anMemOut(C){
 const {r,u}=C;if(!u||u.vazio)return '<p class="ev-hint">Selecione itens.</p>';
 const Q=u.Q,Cc=u.C,t=r.t,L=u.lance,un=u.unit;
 const ln=(a,b)=>`<div><span>${a}</span><b>${b}</b></div>`;
 return `<div class="dkv an-memk">${ln('Q · quantidade',fmtN(Q,2)+' '+esc(u.unidade||''))}${ln('C · custo total da execução',mfmt(Cc))}${ln('t · percentuais sobre a venda',p2(t))}${ln('m_min · margem mínima',r.mMin==null?'—':p2(r.mMin))}${ln('m_alvo · margem-alvo',r.mAlvo==null?'—':p2(r.mAlvo))}</div>
 <ul class="an-ul an-form">
  <li>Equilíbrio = C ÷ (1 − t)${un?' ÷ Q':''} = ${mfmt(Cc)} ÷ ${(1-t).toFixed(4)}${un?' ÷ '+fmtN(Q,2):''} = <b>${un?mfmt(u.equilibrio):mfmt(u.equilibrio_total)}</b> (arredondado para cima)</li>
  ${r.mMin!=null?`<li>Lance mínimo = C ÷ (1 − t − m_min)${un?' ÷ Q':''} = ${mfmt(Cc)} ÷ ${(1-t-r.mMin).toFixed(4)}${un?' ÷ '+fmtN(Q,2):''} = <b>${un?mfmt(u.minimo):mfmt(u.minimo_total)}</b>; margem real no valor exibido: ${p2(u.margem_no_minimo)}</li>`:''}
  ${r.mAlvo!=null?`<li>Preço-alvo = C ÷ (1 − t − m_alvo)${un?' ÷ Q':''} = <b>${un?mfmt(u.alvo):mfmt(u.alvo_total)}</b></li>`:''}
  ${L?`<li>Receita no lance: R = ${un?mfmt(L.unit)+' × '+fmtN(Q,2):u.tipo==='desconto'?mfmt(u.base_desc)+' × (1 − '+p2(L.desconto)+')':'valor global'} = <b>${mfmt(L.R)}</b></li>
  <li>Lucro = R × (1 − t) − C = ${mfmt(L.R)} × ${(1-t).toFixed(4)} − ${mfmt(L.custo)} = <b>${mfmt(L.lucro)}</b>; margem = lucro ÷ R = <b>${p2(L.margem)}</b></li>
  ${L.custo_max!=null?`<li>Custo máximo para a margem mínima neste lance = R × (1 − t − m_min) = ${mfmt(L.custo_max)}; redução necessária = máx(0, C − custo máximo) = <b>${mfmt(L.reducao)}</b></li>`:''}`:''}
  ${u.desconto_max!=null?`<li>Desconto máximo = 1 − lance mínimo ÷ base = 1 − ${mfmt(u.minimo_total)} ÷ ${mfmt(u.base_desc)} = <b>${p2(u.desconto_max)}</b></li>`:''}
  ${u.teto_total!=null&&r.mMin!=null?`<li>Teto confirmado ${mfmt(u.teto_total)}: custo máximo = teto × (1 − t − m_min) = ${mfmt(u.teto_total*(1-t-r.mMin))}; redução necessária = <b>${mfmt(u.teto_reducao)}</b></li>`:''}
 </ul>
 ${u.composicao?`<h4>Composição dos preços unitários ${u.composicao_manual?'(manual)':'(proporcional ao valor estimado)'}</h4><div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Qtd.</th><th>Preço unitário</th><th>Teto unit.</th><th>Subtotal</th></tr></thead><tbody>
  ${u.composicao.map(c=>`<tr><td>${c.n}</td><td>${fmtN(c.q,2)}</td><td>${mIn(`lances.${u.id}.itens.${c.n}`,c.preco,'min="0"')}</td><td>${c.teto==null?'—':mfmt(c.teto)}</td><td class="${c.acima_teto?'v-red':''}">${mfmt((c.preco||0)*c.q)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="4">Total da composição</th><th>${mfmt(u.composicao_total)}</th></tr></tfoot></table></div>
  <p class="ev-hint">Edite os unitários para compor o lote; com todos preenchidos, a composição manual passa a ser o lance. ${u.composicao_manual?`<a class="l" onclick="anMut(P=>{delete P.lances['${u.id}'].itens})">Voltar ao rateio automático</a>`:''}</p>`:''}
 <p class="ev-hint">Valores calculados por regras fixas (não por IA). Pisos arredondados para cima na precisão de ${window.__AN.P.precisao??2} casas; totais = preço unitário × quantidade.</p>`;
}
// ---------- 1 · itens e custo (juntos: escolher o que disputar e dizer quanto custa)
function anItens2(C){
 const A=window.__AN,op=A.op,D=A.an&&A.an.dados||{},P=A.P,d=dias(op.data_fim_proposta);
 const CMP={compativel:['c-green','✓ Na sua linha'],fora:['c-mut','Fora da linha'],excluido:['c-red','Você marcou que não fornece'],sem_codigo:['c-amber','Sem código'],sem_no:['c-amber','Código a conferir']};
 const usaLote=P.julgamento!=='item',LOTES=Object.fromEntries([['','—'],...Array.from({length:20},(_,k)=>[String(k+1),'Lote '+(k+1)])]);
 const ia=(k,r)=>{const v=D[k];return `<div><span>${r} ${origem('ia')}</span><b class="${v==null||v===''?'v-amber':''}">${v==null||v===''?'Não encontrado':esc(typeof v==='object'?JSON.stringify(v):String(v===true?'Sim':v===false?'Não':v))}</b></div>`;};
 const sel=A.itens.filter(i=>P.sel.includes(i.numero_item));
 return `<details class="card an-dados"><summary><b>Dados da licitação</b><span>${esc(op.modalidade||'')}${op.srp?' · registro de preços':''} · ${op.valor_sigiloso?'valor sigiloso':'estimado '+brl(op.valor_estimado)}${d!=null?` · <span class="v-${prazoCor(d)}">${prazoTxt(d)}</span>`:''}</span></summary>
  <div class="dkv"><div><span>Órgão ${origem('pncp')}</span><b>${esc(op.orgao_nome||'—')}</b>${op.unidade_nome?`<small>${esc(op.unidade_nome)}</small>`:''}</div>
  <div><span>Local ${origem('pncp')}</span><b>${esc([op.municipio,op.uf].filter(Boolean).join('/')||'—')}</b><small>${{F:'órgão federal',E:'órgão estadual',M:'órgão municipal',D:'Distrito Federal'}[op.esfera]||''}</small></div>
  <div><span>Propostas até ${origem('pncp')}</span><b>${op.data_fim_proposta?dt(op.data_fim_proposta):'Não informado'}</b></div>
  ${A.an?ia('criterio_julgamento','Critério de julgamento')+ia('prazo_entrega','Prazo de entrega')+ia('local_entrega','Local de entrega')+ia('pagamento','Prazo de pagamento')+ia('vigencia','Duração do contrato'):''}</div>
  ${A.an?`<p class="ev-hint">${AI()} Lido ${A.an.fonte==='edital'?'do edital':'só do objeto'} em ${dt(A.an.analisado_em)}; confira no documento.</p>`:(pode('ia')?`<button class="sec" onclick="anLerEdital(this)">${AI()} Ler o edital com IA</button>`:'')}
  ${op.link_pncp?`<p><a class="l" href="${esc(op.link_pncp)}" target="_blank" rel="noopener">Abrir edital e anexos no PNCP ↗</a></p>`:''}</details>
 <div class="card"><h3>1. Escolha o que vai disputar</h3>
  <div class="ev-form"><div><label>Como a disputa é julgada ${anOrig('julgamento')}</label>${sIn('julgamento',P.julgamento,JULG)}</div></div>
  ${A.itens.length?`<div class="ev-actions" style="margin-top:0"><button class="sec sm" onclick="anSelTodos('linha')">Só os da minha linha</button><button class="sec sm" onclick="anSelTodos('todos')">Todos</button><button class="sec sm" onclick="anSelTodos('nenhum')">Nenhum</button></div>
  <div class="tbw"><table class="tb an-tb an-m"><thead><tr><th></th><th>Item</th><th>Descrição</th><th>Quantidade</th><th>Estimado unit. ${origem('pncp')}</th><th>Preço histórico ${origem('compras')}</th>${usaLote?'<th>Lote</th>':''}<th>Linha</th></tr></thead><tbody>
  ${A.itens.map(i=>{const n=i.numero_item,on=P.sel.includes(n),c=CMP[A.comp[n]]||CMP.sem_codigo,it=P.it[n]||{},h=P.hist_info[n];return `<tr class="${on?'on':''}"><td class="m-ck"><input type="checkbox" ${on?'checked':''} onchange="anSel(${n},this.checked)" aria-label="Disputar item ${n}"></td><td class="m-h">${n}</td><td class="m-h">${esc((i.descricao||'').slice(0,140))}</td>
   <td data-l="Quantidade">${fmtN(i.quantidade,2)} ${esc(i.unidade||'')}</td><td data-l="Estimado unit.">${i.sigiloso?'Sigiloso':mfmt(i.valor_unitario)}</td>
   <td data-l="Preço histórico">${it.historico!=null?`${mfmt(it.historico)}${h&&h.n?`<small class="ev-hint">mediana de ${h.n} compras</small>`:''}`:h&&h.st==='buscando'?'<small class="ev-hint">buscando…</small>':h&&h.st==='sem'?'<small class="ev-hint">sem compras comparáveis</small>':'—'}</td>
   ${usaLote?`<td data-l="Lote">${on?sIn(`lotes.${n}`,P.lotes[n]||'',LOTES):''}</td>`:''}<td data-l="Linha"><span class="chip ${c[0]}">${c[1]}</span></td></tr>`;}).join('')}</tbody></table></div>
  ${usaLote?'<p class="ev-hint">O PNCP não informa os lotes: marque o lote de cada item conforme o edital.</p>':''}`
  :pend('Os itens desta licitação ainda não foram lidos do PNCP','',"A leitura acontece na próxima coleta.")}</div>
 ${sel.length?`<div class="card"><h3>2. Quanto custa para você entregar?</h3><p class="sub">É o único dado que só a sua empresa tem. Informe o custo total de cada item <b>sem os tributos sobre a venda</b>: o resto já vem calculado.</p>
  ${P.modo_custo==='rapido'?`<div class="tbw"><table class="tb an-tb an-m"><thead><tr><th>Item</th><th>Descrição</th><th>Quantidade</th><th>Seu custo total</th><th>Custo por unidade</th></tr></thead><tbody>
   ${sel.map(i=>{const n=i.numero_item,it=P.it[n]||{},q=it.qtd_sim??i.quantidade;return `<tr><td class="m-h">${n}</td><td class="m-h">${esc((i.descricao||'').slice(0,90))}</td><td data-l="Quantidade">${fmtN(q,2)} ${esc(i.unidade||'')}</td><td data-l="Seu custo total">${mIn(`it.${n}.custo_total_est`,it.custo_total_est,'min="0" placeholder="informe"')}</td><td data-l="Custo por unidade" id="cu${n}">${it.custo_total_est!=null&&q?mfmt(it.custo_total_est/q):'—'}</td></tr>`;}).join('')}</tbody></table></div>
   <p class="ev-hint">Prefere informar o preço do fornecedor (por unidade ou por caixa), frete e outras despesas separadas? <a class="l" onclick="anMut(P=>P.modo_custo='detalhado')">Usar composição detalhada</a></p>`
  :`<p class="ev-hint">Composição detalhada ativa. <a class="l" onclick="anMut(P=>P.modo_custo='rapido')">Voltar ao custo total por item</a></p>`}</div>
  ${P.modo_custo==='detalhado'?anCustos(C).replace(/^<div class="card"><h3>Como você quer informar o custo\?<\/h3>[\s\S]*?<\/p><\/div>/,''):`<div class="card"><h3>Custo calculado</h3><div id="anOut">${anCustosOut(C)}</div></div>`}
  <details class="card an-grp2"><summary><b>Ajustes por item</b><small>quantidade diferente do edital, teto confirmado no edital, preço histórico manual${P.julgamento==='desconto'?', base do desconto':''}</small></summary>
   <div class="tbw"><table class="tb an-tb"><thead><tr><th>Item</th><th>Qtd. simulada</th><th>Teto confirmado no edital</th><th>Preço histórico</th>${P.julgamento==='desconto'?'<th>Base do desconto</th>':''}</tr></thead><tbody>
   ${sel.map(i=>{const n=i.numero_item,it=P.it[n]||{};return `<tr><td>${n}</td><td>${nIn(`it.${n}.qtd_sim`,it.qtd_sim,'min="0" placeholder="= edital"')}</td><td>${mIn(`it.${n}.teto`,it.teto,'min="0" placeholder="só se o edital fixar"')}</td><td>${mIn(`it.${n}.historico`,it.historico,'min="0"')}</td>${P.julgamento==='desconto'?`<td>${mIn(`it.${n}.base_desc`,it.base_desc,`min="0" placeholder="${i.valor_unitario??''}"`)}</td>`:''}</tr>`;}).join('')}</tbody></table></div>
   <p class="ev-hint">Valor estimado (PNCP), teto confirmado e preço histórico são coisas diferentes: o teto só existe se o edital fixar um valor máximo aceitável.</p></details>`:''}`;
}
// cotação do dólar (venda) do dia, só para licitação internacional e quando ainda não informada
async function anCambio(){const A=window.__AN;if(!A||A.P.moeda!=='USD'||Number(A.P.cambio)>0)return;
 try{const j=await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL').then(x=>x.json());const v=Number(j&&j.USDBRL&&j.USDBRL.ask);
  if(v>0&&window.__AN===A){A.P.cambio=Math.round(v*100)/100;A.P.origem.cambio='cotacao';A.sujo=true;anRender();}}catch(e){}}
// preço histórico automático: mediana das compras públicas dos últimos 12 meses (Compras.gov.br), na mesma unidade
async function anHistorico(){
 const A=window.__AN;if(!A)return;const P=A.P;let tk=null;
 for(const i of A.itens.filter(x=>P.sel.includes(x.numero_item))){
  const n=i.numero_item,it=P.it[n]=P.it[n]||{};if(it.historico!=null||P.hist_info[n]||!i.cat_codigo)continue;
  const no=A.nos.find(x=>x.tipo===i.cat_tipo&&x.codigo===i.cat_codigo),cod=i.cat_tipo==='M'?(no&&no.caminho&&no.caminho.pdm):i.cat_codigo;if(!cod)continue;
  P.hist_info[n]={st:'buscando'};
  try{tk=tk||(await sb.auth.getSession()).data.session.access_token;
   const r=await fetch(`/api/preco?tipo=${i.cat_tipo}&codigo=${encodeURIComponent(cod)}&un=${encodeURIComponent((i.unidade||'').toUpperCase())}`,{headers:{authorization:'Bearer '+tk}}).then(x=>x.json());
   if(r&&r.estat&&r.estat.n>=3&&r.unidade===(i.unidade||'').toUpperCase()){it.historico=Math.round(r.estat.mediana*100)/100;P.hist_info[n]={n:r.estat.n,un:r.unidade,em:new Date().toISOString()};P.origem[`it.${n}.historico`]='compras';A.sujo=true;}
   else P.hist_info[n]={st:'sem'};
  }catch(e){P.hist_info[n]={st:'sem'};}
  if(window.__AN===A)(A.aba==='itens'?anRender:anAtualizar)();
 }
}
// ---------- 2 · premissas (tudo pré-preenchido; só ajuste se quiser)
function anPrem(C){
 const A=window.__AN,P=A.P,O=P.operacao,TA=anTribAuto(),F=O.financiamento||{},K=O.caucao||{};
 const MG=[5,8,10,12,15,18,20,25,30,35,40].map(v=>[v,v+'%']);
 const f=(path,rot,ops,ph)=>`<div><label>${rot} ${anOrig(path)}</label>${sN(path,anGet(path),ops,ph)}</div>`;
 return `<div class="card"><h3>Moeda da proposta</h3><div class="ev-form"><div><label>Valores em ${anOrig('moeda')}</label>${sIn('moeda',P.moeda||'BRL',{BRL:'Real (R$ 00.000,00)',USD:'Dólar (USD $ 00,000.00) · licitação internacional'})}</div>
  ${P.moeda==='USD'?`<div><label>Cotação do dólar ${anOrig('cambio')}</label>${mIn('cambio',P.cambio,'','BRL')}<small class="ev-hint">Converte os valores do PNCP e do histórico, que estão em reais.</small></div>`:''}</div><p class="ev-hint">Os custos e lances que você digitou não são convertidos ao trocar a moeda: confira-os.</p></div>
 <div class="card"><h3>Tributos</h3>
  ${P.trib_auto?`<div class="an-auto"><b>${esc(TA.resumo)}</b><span>${origem('empresa')} calculado pelo perfil tributário da empresa${A.op.esfera==='F'&&TA.tributos.some(x=>x.natureza==='retencao')?' e pela esfera do órgão (federal)':''}.</span></div>
   ${TA.pend.length?TA.pend.map(x=>`<p class="lc-note"><span>!</span><span>${esc(x)}</span></p>`).join('')+`<div class="ev-actions"><button onclick="ir('empresa',{aba:'dados'})">Completar o perfil da empresa</button></div>`:''}
   ${TA.tributos.length?`<ul class="an-ul">${TA.tributos.map(x=>`<li>${esc(x.nome)}: <b>${String(x.valor).replace('.',',')}%</b>${x.natureza==='retencao'?' (retenção: só caixa)':''}</li>`).join('')}</ul>`:''}
   ${TA.notas.length?`<p class="ev-hint">${TA.notas.map(esc).join(' ')}</p>`:''}
   <div class="ev-actions"><button class="sec sm" onclick="anMut(P=>{P.tributos=JSON.parse(JSON.stringify(anTribAuto().tributos));P.trib_auto=false;})">Alterar só nesta análise</button><button class="sec sm" onclick="ir('empresa',{aba:'dados'})">Editar perfil tributário da empresa</button></div>`
  :`<p class="sub">Tributos alterados só nesta análise. <a class="l" onclick="anMut(P=>{P.trib_auto=true;})">Voltar ao cálculo automático (${esc(TA.resumo)})</a></p>${anTribLinhas()}`}</div>
 <div class="card"><h3>Meta comercial</h3><p class="sub">Margens sobre o valor da venda. A mínima é o seu limite na disputa; a alvo define o preço inicial.</p>
  <div class="ev-form">${f('margem_min','Margem mínima',MG)}${f('margem_alvo','Margem-alvo',MG)}</div></div>
 <div class="card"><h3>Prazos e caixa</h3><p class="sub">Contados da assinatura do contrato ou do empenho. Vêm do edital, do perfil da empresa ou de um padrão; troque se precisar.</p>
  <div class="ev-form">${f('operacao.entregas','Pedidos/entregas',[1,2,3,4,6,12,24,52].map(v=>[v,v===1?'1 entrega':v+' entregas']))}
  ${f('operacao.prazo_entrega','Prazo de entrega após o pedido',DIAS)}
  ${f('operacao.prazo_recebimento','O órgão paga em',DIAS)}
  ${f('operacao.atraso','Atraso esperado no pagamento',[[0,'Nenhum'],[15,'15 dias'],[30,'30 dias'],[60,'60 dias'],[90,'90 dias']],'Nenhum')}
  ${f('operacao.prazo_fornecedor','Você paga o fornecedor em',DIAS)}
  ${f('operacao.meses','Duração do contrato',[1,3,6,12,24,36,48,60].map(v=>[v,v+(v===1?' mês':' meses')]),'Não informada')}
  ${f('operacao.caixa','Caixa disponível para a operação',REAIS_V.map(v=>[v,v===0?'Nenhum':mfmt(v).replace(/,00$|\.00$/,'')]),'Não informar')}
  ${f('operacao.credito','Crédito que consegue usar',REAIS_V.map(v=>[v,v===0?'Nenhum':mfmt(v).replace(/,00$|\.00$/,'')]),'Nenhum')}</div></div>
 <details class="card an-grp2"><summary><b>Mais opções</b><small>precisão do preço, financiamento, caução, custo do dinheiro, recolhimento dos tributos</small></summary>
  <div class="ev-form"><div><label>Casas decimais no preço</label>${sIn('precisao',P.precisao??2,{2:'2 (centavos)',3:'3',4:'4'})}</div>
  ${f('operacao.prazo_faturamento','Faturamento após a entrega',DIAS,'No mesmo dia')}${f('operacao.dias_tributo','Recolhimento dos tributos após receber',DIAS,'No mesmo dia')}
  ${f('operacao.taxa_mensal','Custo do dinheiro',[[1,'1% ao mês'],[1.5,'1,5% ao mês'],[2,'2% ao mês'],[3,'3% ao mês'],[4,'4% ao mês'],[5,'5% ao mês']],'Não considerar')}
  <div><label class="pf-sw"><input type="checkbox" data-p="operacao.incluir_custo_giro" ${O.incluir_custo_giro?'checked':''} onchange="anSet(this)"> incluir o custo do capital de giro no custo</label></div></div>
  <h4>Financiamento</h4><div class="ev-form">${f('operacao.financiamento.valor','Valor liberado',REAIS_V.map(v=>[v,v===0?'Nenhum':mfmt(v).replace(/,00$|\.00$/,'')]),'Sem financiamento')}${F.valor?f('operacao.financiamento.dia','Liberado no dia',DIAS,'0')+f('operacao.financiamento.quitacao','Quitado no dia',DIAS.concat([[150,'150 dias'],[180,'180 dias']]))+`<div><label>Juros</label>${mIn('operacao.financiamento.juros',F.juros,'min="0"')}</div><div><label>Tarifas</label>${mIn('operacao.financiamento.tarifas',F.tarifas,'min="0"')}</div>`:''}</div>
  <h4>Garantia em caução</h4><div class="ev-form">${f('operacao.caucao.valor','Valor da caução',REAIS_V.map(v=>[v,v===0?'Nenhum':mfmt(v).replace(/,00$|\.00$/,'')]),'Sem caução')}${K.valor?f('operacao.caucao.devolucao','Devolvida no dia',DIAS.concat([[180,'180 dias'],[365,'365 dias']]),'Ao fim do contrato'):''}</div></details>
 <div class="card"><h3>Efeito no preço</h3><div id="anOut">${anTribOut(C)}</div></div>`;
}
function anTribLinhas(){return anTrib(anCalc()).replace(/^[\s\S]*?(<div class="an-custo">|<p class="ev-hint">Nenhum tributo)/,'$1').replace(/<\/div>\s*<div class="card"><h3>Meta comercial[\s\S]*$/,'');}
// ---------- 3 · cenários e caixa
function anCen2(C){
 const A=window.__AN,P=A.P;
 const CE=[['custo','Custo de compra',[0,5,10,15,20,30].map(v=>[v,v?'+'+v+'%':'sem variação'])],['frete','Frete',[0,10,20,30,50].map(v=>[v,v?'+'+v+'%':'sem variação'])],['cambio','Câmbio (parte importada)',[0,5,10,20].map(v=>[v,v?'+'+v+'%':'sem variação'])],['qtd','Quantidade pedida',[0,-10,-20,-30,-50].map(v=>[v,v?v+'%':'a do edital'])],['atraso','Atraso no pagamento',[0,15,30,60,90].map(v=>[v,v?'+'+v+' dias':'sem atraso'])]];
 return `<div class="card"><h3>Cenários</h3><p class="sub">O lance simulado fica fixo e as condições pioram no conservador. Ajuste se quiser.</p>
  <div class="tbw"><table class="tb an-tb"><thead><tr><th>Condição</th><th>Base</th><th>Conservador</th></tr></thead><tbody>
  ${CE.map(([k,rt,ops])=>`<tr><td>${rt}</td>${['base','conservador'].map(c=>`<td>${sN(`cenarios.${c}.${k}`,(P.cenarios[c]||{})[k]??0,ops)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  ${A.op.srp?`<h4>Registro de preços</h4><div class="ev-form"><div><label>Quantidade provável</label>${sN('srp_cfg.provavel_pct',P.srp_cfg.provavel_pct??50,[[25,'25% da máxima'],[50,'50% da máxima'],[75,'75% da máxima'],[100,'100% da máxima']])}</div><div><label>Pedidos menores</label>${sN('srp_cfg.fator_pedidos',P.srp_cfg.fator_pedidos??2,[[2,'o dobro de entregas'],[3,'o triplo de entregas'],[4,'4× mais entregas']])}</div></div>`:''}</div>
 <div class="card"><h3>Resultado por cenário</h3><div id="anOut">${anCenOut(C)}</div></div>
 <div class="card"><h3>Fluxo de caixa no lance simulado</h3><div id="anOut2">${anCaixaOut(C)}</div></div>`;
}
const AN_PANE={itens:anItens2,premissas:anPrem,cen:anCen2,docs:anDocs,decisao:anDec};
const AN_OUT={itens:anCustosOut,premissas:anTribOut,cen:anCenOut,decisao:anMemOut};
async function anSalvar(silencioso){
 const A=window.__AN,C=anCalc(),u=C.u,r=C.r;
 const alerta=C.us.some(x=>x.lance&&(x.lance.folga<0||x.lance.lucro<0))||C.us.some(x=>x.teto_reducao>0)||C.us.some(x=>x.caixa.ok&&x.caixa.falta>0);
 const tipo=r.erros.length?'erro':r.parcial?'incompleta':alerta?'atencao':'favoravel';
 const res={versao_calculo:2,moeda:A.P.moeda||'BRL',calculado_em:new Date().toISOString(),pendencias:r.pendencias,
  unidades:C.us.map(x=>({id:x.id,nome:x.nome,Q:x.Q,C:x.C,equilibrio:x.equilibrio_total,minimo:x.minimo_total,alvo:x.alvo_total,lance:x.lance&&{R:x.lance.R,lucro:x.lance.lucro,margem:x.lance.margem},capital:x.caixa.ok?x.caixa.capital:null,falta:x.caixa.ok?x.caixa.falta:null})),
  total:{margem:u&&u.lance?u.lance.margem*100:null,lucro:u&&u.lance?u.lance.lucro:null,minimo:u?u.minimo_total:null,capital:u&&u.caixa.ok?u.caixa.capital:null},
  recomendacao:{tipo}};
 try{await rpc('salvar_viabilidade',{p_id:A.li.id,p_itens:A.P.sel,p_lotes:Object.entries(A.P.lotes).filter(([,v])=>v).map(([n,l])=>({n:Number(n),lote:l})),p_premissas:A.P,p_resultado:res});
  A.sujo=false;if(A.li.status==='a_analisar')A.li.status='em_analise';if(!silencioso){toast('Análise salva');anRender();}}catch(e){toast(e.message);throw e;}
}
async function anDecidir(s){const A=window.__AN;try{if(A.sujo)await anSalvar(true);await rpc('decidir_interesse',{p_id:A.li.id,p_status:s,p_obs:$('#andec')?$('#andec').value:null});A.li.status=s;A.sujo=false;toast('Situação: '+ST_INT[s]);anRender();}catch(e){toast(e.message);}}

// ------------------------------------------------------------------ habilitação: cards por categoria, com situação clara
const HAB_EST={nao_iniciado:['c-mut','○','Não iniciado'],preenchendo:['c-blue','◐','Em preenchimento'],revisao:['c-amber','?','Pendente de revisão'],completo:['c-green','✓','Completo no cadastro'],vencido:['c-red','!','Documento vencido'],edital:['c-mut','·','Conforme o edital']};
V.habilitacao=async()=>{
 const [{data:pjs},{data:pfs}]=await Promise.all([sb.from('pessoas_juridicas').select('id,cnpj,razao_social,uf,municipio,propria').order('propria',{ascending:false}),sb.from('pessoas_fisicas').select('id,cpf,nome,uf,municipio').order('nome')]);
 const sujeitos=[...(pjs||[]).map(x=>({...x,tipo:'pj',nome:x.razao_social,doc:x.cnpj})),...(pfs||[]).map(x=>({...x,tipo:'pf',doc:x.cpf}))];
 const topo=`<div class="top"><div><h2>Habilitação</h2><p class="sub">Organização geral dos documentos da empresa. A conferência de cada licitação acontece na análise de viabilidade.</p></div></div>`;
 if(!sujeitos.length){main.innerHTML=topo+pend('Cadastre a empresa primeiro',`<button onclick="ir('empresa',{aba:'dados'})">Cadastrar empresa</button>`);return;}
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
