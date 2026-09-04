'use strict';
let deal=null,currentTab='all',currentSort='default',currentFilter=null;
const PROMPTS={summary:'Fasse den Deal und die Kommentare zusammen (5-7 Saetze). Was ist das Angebot, was sagen die Nutzer?',sentiment:'Stimmungsanalyse der Kommentare: positiv/negativ/gemischt. 3 konkrete Beispiele mit Kurzinhalten.',questions:'Welche Fragen, Probleme oder Unsicherheiten wurden erwaehnt? Als Stichpunkte.',highlights:'Die 5 wichtigsten Kommentare (Reaktionen/Replies/Inhalt). Erklaere kurz warum jeder wichtig ist.',problems:'Berichte ueber Probleme, Fehler, Warnungen? Alles kritische zusammenfassen.',verdict:'Lohnt sich der Deal? Pro/Contra-Liste und Fazit in 2 Saetzen.'};
// Score: helpful*3 + replies*3 + like*2 + funny (mehr Replies = wichtigerer Kommentar)
function score(c){const r=c.reactions||{};return(c.replyCount||0)*3+(r.helpful||0)*3+(r.like||0)*2+(r.funny||0);}

document.addEventListener('DOMContentLoaded',()=>{
  chrome.runtime.sendMessage({type:'GET_EXPORT_DATA'},data=>{
    if(!data){showError('Keine Daten. Bitte auf der Deal-Seite neu exportieren.');return;}
    deal=data;renderMeta();renderStats();renderComments();setupTabs();setupSort();setupStatFilters();setupExport();setupAI();
  });
});

function renderMeta(){
  const{meta}=deal;
  document.title=(meta.title||'Deal')+' – MDE';
  document.getElementById('topbar-info').textContent=`${deal.stats?.totalTopLevel} Komm. · ${deal.stats?.totalRepliesVisible} Replies`;
  document.getElementById('meta-section').innerHTML=`<div class="meta-card"><h2>${esc(meta.title||'?')}</h2><div style="font-size:13px;color:var(--muted);margin-bottom:6px">${meta.price?`<strong style="color:var(--accent)">${esc(meta.price)}</strong> · `:''} ${esc(meta.merchant||'')}</div><a href="${esc(meta.url)}" target="_blank" class="deal-link">🔗 Deal oeffnen</a></div>`;
}
function renderStats(){
  const s=deal.stats;const tot=s.reactions.like+s.reactions.helpful+s.reactions.funny;
  document.getElementById('stats-section').innerHTML=`<div class="stats-grid"><div class="stat-card" data-filter="toplevel" title="Alle Top-Level Kommentare"><div class="stat-num">${s.totalTopLevel}</div><div class="stat-lbl">Top-Level</div></div><div class="stat-card" data-filter="replies" title="Nur Threads mit Replies"><div class="stat-num">${s.totalRepliesVisible}</div><div class="stat-lbl">Replies</div></div><div class="stat-card ${s.totalHiddenReplies>0?'warn':''}"><div class="stat-num">${s.totalHiddenReplies}</div><div class="stat-lbl">verborgen ⚠</div></div><div class="stat-card" data-filter="reactions" title="Kommentare mit Reaktionen"><div class="stat-num">${tot}</div><div class="stat-lbl">Reaktionen</div></div><div class="stat-card" data-filter="like" title="Kommentare mit 👍"><div class="stat-num">${s.reactions.like}</div><div class="stat-lbl">👍</div></div><div class="stat-card" data-filter="helpful" title="Kommentare mit 💡"><div class="stat-num">${s.reactions.helpful}</div><div class="stat-lbl">💡</div></div><div class="stat-card" data-filter="funny" title="Kommentare mit 😄"><div class="stat-num">${s.reactions.funny}</div><div class="stat-lbl">😄</div></div></div>${s.totalHiddenReplies>0?`<p class="warn-note">⚠ ${s.totalHiddenReplies} Replies nicht abrufbar (mydealz API-Limit)</p>`:''}`;
}

function renderComments(){
  let items=[...deal.comments];
  if(currentTab==='hot') items=items.filter(c=>score(c)>=3);
  else if(currentTab==='top') items=items.filter(c=>(c.reactions?.like||0)+(c.reactions?.helpful||0)>=1);
  if(currentFilter==='replies') items=items.filter(c=>(c.replyCount||0)>0);
  else if(currentFilter==='reactions') items=items.filter(c=>((c.reactions?.like||0)+(c.reactions?.helpful||0)+(c.reactions?.funny||0))>0);
  else if(currentFilter==='like') items=items.filter(c=>(c.reactions?.like||0)>0);
  else if(currentFilter==='helpful') items=items.filter(c=>(c.reactions?.helpful||0)>0);
  else if(currentFilter==='funny') items=items.filter(c=>(c.reactions?.funny||0)>0);
  if(currentSort==='score') items.sort((a,b)=>score(b)-score(a));
  else if(currentSort==='replies') items.sort((a,b)=>(b.replyCount||0)-(a.replyCount||0));
  const wrap=document.getElementById('comments-section');
  wrap.innerHTML=items.length?items.map(c=>commentHtml(c,false)).join(''):'<div style="padding:20px;color:var(--muted);text-align:center">Keine Kommentare.</div>';
}

function commentHtml(c,isReply){
  const r=c.reactions||{};const sc=score(c);const isHot=!isReply&&sc>=5;
  const rx=[r.like?`<span class="reaction reaction-like">👍 ${r.like}</span>`:'',r.helpful?`<span class="reaction reaction-helpful">💡 ${r.helpful}</span>`:'',r.funny?`<span class="reaction reaction-funny">😄 ${r.funny}</span>`:''].filter(Boolean).join('');
  const badges=[c.deleted?`<span class="badge badge-del">🗑 ${esc(c.deleted)}</span>`:'',isHot?`<span class="badge badge-hot">🔥${sc}</span>`:'',c._hiddenReplies?`<span class="badge badge-hidden">+${c._hiddenReplies} verborgen</span>`:''].filter(Boolean).join('');
  const repliesHtml=c.replies?.length?c.replies.map(r=>commentHtml(r,true)).join(''):'';
  return `<div class="${isReply?'comment-card reply-card':'comment-card'}"><div class="comment-header"><span class="comment-author">@${esc(c.author||'?')}</span><span class="comment-date">${esc(c.date||'')}</span>${c.replyCount>0&&!isReply?`<span class="badge badge-score">${c.replyCount} Replies</span>`:''} ${badges}</div><div class="comment-text${c.deleted?' deleted':''}">${esc(c.text||'(geloescht)')}</div>${rx?`<div class="reactions">${rx}</div>`:''}</div>${repliesHtml}`;
}
function setupTabs(){document.querySelectorAll('.tab').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));btn.classList.add('active');currentTab=btn.dataset.tab;renderComments();});});}
function setupSort(){document.querySelectorAll('.sort-btn').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');currentSort=btn.dataset.sort;renderComments();});});}
function setupStatFilters(){
  document.querySelectorAll('.stat-card[data-filter]').forEach(card=>{
    card.addEventListener('click',()=>{
      const f=card.dataset.filter;
      // toplevel = reset; others toggle
      currentFilter=(f==='toplevel'||currentFilter===f)?null:f;
      document.querySelectorAll('.stat-card[data-filter]').forEach(c=>c.classList.remove('active-filter'));
      if(currentFilter) document.querySelector(`.stat-card[data-filter="${currentFilter}"]`)?.classList.add('active-filter');
      renderComments();
    });
  });
}
function setupExport(){
  document.getElementById('btn-export-json').addEventListener('click',()=>download(JSON.stringify(deal,null,2),'mydealz-export.json','application/json'));
  document.getElementById('btn-export-md').addEventListener('click',()=>download(buildMarkdown(),'mydealz-export.md','text/markdown'));
  document.getElementById('btn-copy').addEventListener('click',async()=>{await navigator.clipboard.writeText(JSON.stringify(deal,null,2));flash('btn-copy','✅ Kopiert!');});
  document.getElementById('ai-copy-btn').addEventListener('click',async()=>{await navigator.clipboard.writeText(document.getElementById('ai-output').textContent);flash('ai-copy-btn','✅');});
}
function buildMarkdown(){
  const{meta,comments,stats}=deal;
  const lines=[`# ${meta.title||'Deal'}`,`**URL:** ${meta.url}`,`**Kommentare:** ${stats.totalTopLevel}+${stats.totalRepliesVisible}`,stats.totalHiddenReplies>0?`⚠ ${stats.totalHiddenReplies} verborgen`:'',' ','---',' '];
  const walk=(c,d)=>{const p='  '.repeat(d);const sc=score(c);lines.push(`${p}**@${c.author}** (${c.date})${sc>=3?' 🔥':''}: ${(c.text||'(geloescht)')}`);if(c._hiddenReplies)lines.push(`${p}*(+${c._hiddenReplies} verborgen)*`);lines.push('');c.replies?.forEach(r=>walk(r,d+1));};
  comments.forEach(c=>walk(c,0));return lines.filter(Boolean).join('\n');
}
function download(content,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();}
// ── Smart Context Builder ─────────────────────────────────────────────────
// Erkennt Query-Typ und baut minimalen Kontext:
// - Preis/Haendler-Fragen → nur Deal-Header (kein Comment-Overhead)
// - Filter: !deleted && (reactions>=1 || replies>=1 || len>=50)
// - Kommentare sortiert nach Score, abgeschnitten bei ~20k Zeichen (Nano-Limit)
// - 300+ Kommentare → Map-Reduce (Batch-Zusammenfassungen)

const CONTEXT_LIMIT = 20000; // Zeichen (~5k Tokens, konservativ für Gemini Nano)
const PRICE_HINTS = ['preis','euro','kost','günstig','rabatt','prozent','discount','angebot','händler','merchant'];

function needsComments(prompt){return !PRICE_HINTS.some(k=>prompt.toLowerCase().includes(k))||prompt.toLowerCase().includes('kommentar');}

function dealHeader(){
  const{meta}=deal;
  return [`DEAL: ${meta.title}`,meta.price?`PREIS: ${meta.price}`:'',meta.merchant?`HAENDLER: ${meta.merchant}`:''].filter(Boolean).join('\n');
}

function commentLine(c,depth){
  const prefix='  '.repeat(depth);
  const r=c.reactions||{};
  const rx=[r.like?`like:${r.like}`:'',r.helpful?`helpful:${r.helpful}`:'',r.funny?`funny:${r.funny}`:''].filter(Boolean).join(' ');
  const meta=[rx,c.replyCount>0?`${c.replyCount}replies`:''].filter(Boolean).join(' ');
  return `${prefix}@${c.author}${meta?` [${meta}]`:''}: ${(c.text||'')}`;
}

function relevantComments(){
  return [...(deal.comments||[])].sort((a,b)=>score(b)-score(a)).filter(c=>!c.deleted&&(c.totalReactions>=1||c.replyCount>=1||(c.text||'').length>=50));
}

function buildAIContext(prompt=''){
  const header=dealHeader();
  if(!needsComments(prompt)) return header+'\n\n(Nur Deal-Metadaten benoetigt fuer diese Frage)';

  const filtered=relevantComments();
  const total=deal.comments?.length||0;
  const lines=[header,'','=== KOMMENTARE (Score: helpful*3 + replies*3 + likes*2 + funny) ==='];
  let chars=lines.join('\n').length;let included=0;

  for(const c of filtered){
    const cLine=commentLine(c,0);
    const rLines=(c.replies||[]).filter(r=>!r.deleted&&(r.totalReactions>=1||r.replyCount>=1||(r.text||'').length>=50)).map(r=>commentLine(r,1));
    const block=[cLine,...rLines].join('\n');
    if(chars+block.length>CONTEXT_LIMIT) break;
    lines.push('',block);chars+=block.length+2;included++;
  }
  const skipped=total-included;
  lines.push('',`--- ${included}/${total} Kommentare (${skipped>0?skipped+' Kurz-/Niedrig-Score-Kommentare uebersprungen':'alle relevant'}) ---`);
  return lines.join('\n');
}
// ── Map-Reduce für 300+ Kommentar-Threads ──────────────────────────────────
async function callAI(prompt,ctx){
  if(typeof ai!=='undefined'){
    const model=ai.languageModel||ai.assistant;
    if(model?.create){
      const session=await model.create({systemPrompt:'Du analysierst mydealz.de Deals und Kommentare. Antworte auf Deutsch, praezise.'});
      return await session.prompt(`${prompt}\n\n${ctx}`);
    }
  }
  const{apiKey}=await new Promise(r=>chrome.storage.sync.get('apiKey',r));
  if(!apiKey) throw new Error('Kein API-Key und Chrome-AI nicht verfuegbar.');
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({systemInstruction:{parts:[{text:'Du analysierst mydealz.de Deals. Antworte auf Deutsch.'}]},contents:[{parts:[{text:`${prompt}\n\n${ctx}`}]}]})});
  const json=await resp.json();
  const txt=json.candidates?.[0]?.content?.parts?.[0]?.text||json.error?.message;
  if(!txt) throw new Error(JSON.stringify(json));
  return txt;
}

async function runMapReduce(prompt,onStatus){
  const BATCH=40;const filtered=relevantComments();
  const summaries=[];
  for(let i=0;i<filtered.length;i+=BATCH){
    const batch=filtered.slice(i,i+BATCH);
    const batchNum=Math.floor(i/BATCH)+1;const total=Math.ceil(filtered.length/BATCH);
    if(onStatus)onStatus(`Batch ${batchNum}/${total} zusammenfassen...`);
    const batchLines=[dealHeader(),'',`=== KOMMENTAR-BATCH ${batchNum}/${total} (${batch.length} Kommentare) ===`];
    batch.forEach(c=>{batchLines.push('',commentLine(c,0));(c.replies||[]).filter(r=>!r.deleted&&(r.totalReactions>=1||r.replyCount>=1||(r.text||'').length>=50)).forEach(r=>batchLines.push(commentLine(r,1)));});
    const summary=await callAI(`Fasse diese ${batch.length} Kommentare in 3-4 Saetzen zusammen. Wichtige Punkte, Probleme, Themen:`,batchLines.join('\n'));
    summaries.push(`Batch ${batchNum}: ${summary}`);
  }
  if(onStatus)onStatus('Finale Analyse...');
  const finalCtx=[dealHeader(),'','=== BATCH-ZUSAMMENFASSUNGEN (alle Kommentare) ===',...summaries].join('\n');
  return callAI(prompt,finalCtx);
}

function setupAI(){
  document.querySelectorAll('.ai-prompt-btn').forEach(btn=>{btn.addEventListener('click',()=>runAI(PROMPTS[btn.dataset.prompt]||btn.dataset.prompt));});
  const inp=document.getElementById('custom-prompt');
  document.getElementById('btn-custom-ai').addEventListener('click',()=>{const q=inp.value.trim();if(q)runAI(q);});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'){const q=e.target.value.trim();if(q)runAI(q);}});
}

async function runAI(prompt){
  const out=document.getElementById('ai-output');
  out.textContent='⏳ Analysiere...';
  document.querySelectorAll('.ai-prompt-btn').forEach(b=>b.disabled=true);
  try{
    const total=deal.comments?.length||0;
    const filtered=relevantComments();
    // Map-Reduce bei >250 relevanten Kommentaren
    if(filtered.length>250&&needsComments(prompt)){
      out.textContent=`⚙ Grosser Thread (${total} Kommentare) → Map-Reduce...`;
      const result=await runMapReduce(prompt,msg=>{out.textContent='⚙ '+msg;});
      out.textContent=result;
    } else {
      const ctx=buildAIContext(prompt);
      out.textContent=await callAI(prompt,ctx);
    }
  }catch(e){
    out.textContent='❌ '+e.message;
    if(e.message.includes('API-Key')){out.textContent+='\n\nBitte Key im Extension-Popup eintragen.';}
  }finally{document.querySelectorAll('.ai-prompt-btn').forEach(b=>b.disabled=false);}
}

function esc(str){return String(str??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function flash(id,msg){const btn=document.getElementById(id);if(!btn)return;const orig=btn.textContent;btn.textContent=msg;setTimeout(()=>btn.textContent=orig,1500);}
function showError(msg){document.body.innerHTML=`<div style="padding:40px;color:#ef4444;font:16px/1.5 system-ui">${esc(msg)}</div>`;}
