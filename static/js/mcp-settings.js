(() => {
    'use strict';
    let servers = [], selected = -1, dirty = false, busy = false, loadError = false, previousFocus;
    const modal = document.createElement('div');
    modal.id = 'mcp-modal'; modal.className = 'studio-modal'; modal.hidden = true;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'mcp-title');
    modal.innerHTML = `<div class="studio-modal-panel">
      <div class="studio-modal-head"><div><h2 class="studio-modal-title" id="mcp-title">MCP 设置</h2><p class="mcp-muted">管理小美画布的外部工具服务</p></div><button class="studio-modal-close" id="mcp-close" aria-label="关闭">×</button></div>
      <nav class="mcp-tabs" aria-label="MCP 页面"><button id="mcp-settings-tab" class="studio-modal-btn" aria-pressed="true">我的配置</button><button id="mcp-market-tab" class="studio-modal-btn" aria-pressed="false">MCP 市场</button></nav>
      <div class="mcp-layout" id="mcp-settings-view"><aside class="mcp-sidebar"><div class="mcp-toolbar"><button class="studio-modal-btn" id="mcp-add">＋ 添加</button><button class="studio-modal-btn" id="mcp-import">导入 JSON</button></div><input id="mcp-file" type="file" accept=".json,application/json" hidden><div id="mcp-list"></div></aside>
      <div class="mcp-editor"><div id="mcp-empty"><h3>添加你的第一个 MCP 服务</h3><p class="mcp-muted">支持本地命令（STDIO）和远程地址（Streamable HTTP）。可导入服务文档提供的 mcpServers JSON 配置。</p></div>
      <form id="mcp-form" hidden>
        <div class="mcp-row"><label class="mcp-field">服务名称<input id="mcp-name" required maxlength="80" placeholder="例如 Photoshop / Blender"></label><label class="mcp-field">连接方式<select id="mcp-transport"><option value="stdio">本地命令 · STDIO</option><option value="http">远程地址 · Streamable HTTP</option></select></label></div>
        <label class="mcp-field"><span><input id="mcp-enabled" type="checkbox" style="width:auto"> 启用此配置</span></label>
        <div id="mcp-stdio"><label class="mcp-field">启动命令<input id="mcp-command" placeholder="例如 npx、uvx 或程序绝对路径"></label><label class="mcp-field">启动参数（JSON 数组）<textarea id="mcp-args" spellcheck="false" placeholder='["-y", "服务包名"]'></textarea></label><label class="mcp-field">工作目录（选填）<input id="mcp-cwd" placeholder="服务所在文件夹的绝对路径"></label><label class="mcp-field">环境变量（JSON 对象，选填）<textarea id="mcp-env" spellcheck="false" placeholder="{}"></textarea></label></div>
        <div id="mcp-http" hidden><label class="mcp-field">MCP 地址<input id="mcp-url" type="url" placeholder="http://127.0.0.1:8000/mcp"></label><label class="mcp-field">请求头（JSON 对象，选填）<textarea id="mcp-headers" spellcheck="false" placeholder='{"Authorization":"Bearer …"}'></textarea></label></div>
        <p class="mcp-muted">测试会启动或连接此服务并读取工具列表。连接成功不代表 Photoshop 或 Blender 已就绪；当前设置尚未接入画布 Agent 的工具执行。</p>
        <div class="mcp-toolbar"><button class="studio-modal-btn" id="mcp-test" type="button">测试连接</button><button class="studio-modal-btn" id="mcp-delete" type="button">移除配置</button></div><div id="mcp-result" role="status"></div>
      </form></div></div>
      <section id="mcp-market-view" class="mcp-market" hidden aria-label="MCP 市场">
        <form id="mcp-search-form" class="mcp-search"><label class="mcp-field">搜索官方目录<input id="mcp-search" maxlength="160" placeholder="输入服务名称，如 Blender、Photoshop" autocomplete="off"></label><button class="studio-modal-btn primary" id="mcp-search-button">搜索</button></form>
        <p class="mcp-muted">来源：MCP 官方目录 · 搜索词会发送到官方目录。收录不等于安全认证；请核对发布者与项目文档。添加只生成停用的配置草稿，不安装、不运行。</p>
        <div id="mcp-market-status" role="status"></div>
        <div id="mcp-market-results" class="mcp-market-results"></div>
        <button id="mcp-market-more" class="studio-modal-btn" hidden>加载更多</button>
        <section id="mcp-market-detail" class="mcp-market-detail" hidden aria-label="服务详情"></section>
      </section>
      <div class="studio-modal-actions"><span id="mcp-status" role="status"></span><button class="studio-modal-btn primary" id="mcp-save">保存设置</button></div></div>`;
    document.body.append(modal);
    const $ = id => document.getElementById('mcp-' + id);
    function status(text) { $('status').textContent = text; }
    async function request(url, options = {}) {
        const response = await fetch('/api/mcp/' + url, {cache:'no-store', ...options});
        if (response.status === 404) throw Error('请重启小美画布，加载新增的 MCP 设置功能。');
        const data = await response.json();
        if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '配置格式有误，请检查必填项、服务名称和 JSON 格式。');
        return data;
    }
    function object(text, label, array = false) {
        let value; try { value = JSON.parse(text || (array ? '[]' : '{}')); } catch { throw Error(label + '不是有效 JSON'); }
        const valid = array ? Array.isArray(value) && value.every(x => typeof x === 'string') : value && !Array.isArray(value) && typeof value === 'object' && Object.values(value).every(x => typeof x === 'string');
        if (!valid) throw Error(label + (array ? '应为字符串数组' : '应为字符串键值对象'));
        return value;
    }
    function capture() {
        if (selected < 0) return;
        const s = {name:$('name').value.trim(), transport:$('transport').value, enabled:$('enabled').checked,
            command:$('command').value.trim(), args:object($('args').value, '启动参数', true), cwd:$('cwd').value.trim(),
            env:object($('env').value, '环境变量'), url:$('url').value.trim(), headers:object($('headers').value, '请求头')};
        if (!s.name) throw Error('请填写服务名称');
        if (s.transport === 'stdio' && !s.command) throw Error('请填写启动命令');
        if (s.transport === 'http' && !/^https?:\/\//i.test(s.url)) throw Error('请填写 HTTP/HTTPS MCP 地址');
        if (servers.some((x,i) => i !== selected && x.name.toLowerCase() === s.name.toLowerCase())) throw Error('服务名称不能重复');
        servers[selected] = s;
    }
    function renderList() {
        $('list').replaceChildren();
        servers.forEach((s,i) => {
            const button = document.createElement('button'); button.className = 'mcp-server'; button.setAttribute('aria-current', String(i === selected));
            const name = document.createElement('strong'); name.textContent = s.name;
            const sub = document.createElement('small'); sub.textContent = `${s.transport === 'http' ? 'HTTP' : 'STDIO'} · ${s.enabled ? '已启用配置' : '已停用配置'}`;
            button.append(name,sub); button.onclick = () => safe(() => {capture(); selected=i; render();}); $('list').append(button);
        });
    }
    function transport() { $('stdio').hidden = $('transport').value !== 'stdio'; $('http').hidden = !$('stdio').hidden; }
    function render() {
        renderList(); $('form').hidden = selected < 0; $('empty').hidden = selected >= 0;
        if (selected < 0) return;
        const s = servers[selected];
        for (const k of ['name','transport','command','cwd','url']) $(k).value = s[k] || '';
        for (const k of ['args','env','headers']) $(k).value = JSON.stringify(s[k] || (k === 'args' ? [] : {}), null, 2);
        $('enabled').checked = s.enabled; transport(); $('result').textContent = '';
    }
    function safe(fn) { if (busy) return; try { fn(); } catch(e) { status(e.message); } }
    function setBusy(value) { busy=value; modal.querySelectorAll('button,input,textarea,select').forEach(el => el.disabled=value || (loadError && el.id !== 'mcp-close')); }
    function changed() { dirty=true; status('有未保存的更改'); $('result').textContent=''; }
    window.openMcpSettings = async () => {
        if (!modal.hidden) return;
        previousFocus=document.activeElement; modal.hidden=false; loadError=false; showView(false); setNativeCommerceOverlayActive(true); setBusy(true); status('正在读取配置…');
        try { const data=await request('settings'); servers=data.servers; selected=servers.length?0:-1; dirty=false; render(); status(''); }
        catch(e) { loadError=true; servers=[]; selected=-1; render(); status(e.message); }
        finally { setBusy(false); $('close').focus(); }
    };
    function close() {
        if (busy || (dirty && !confirm('放弃尚未保存的 MCP 设置？'))) return;
        if(marketLoading)$('market-status').textContent='查询已取消，可重新搜索。';
        marketAbort?.abort(); marketSequence++; marketLoading=false;
        modal.hidden=true; setNativeCommerceOverlayActive(false); previousFocus?.focus();
    }
    $('close').onclick=close; modal.onclick=e => {if(e.target===modal)close();};
    modal.addEventListener('keydown',e => {
        if(e.key==='Escape'){e.stopPropagation();close();}
        if(e.key==='Tab'){
            const nodes=[...modal.querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled&&x.getClientRects().length);
            const first=nodes[0],last=nodes[nodes.length-1];
            if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
            if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
        }
    });
    $('form').onsubmit=e=>e.preventDefault(); $('form').oninput=changed; $('transport').onchange=transport;
    $('add').onclick=()=>safe(()=>{capture(); let n=1; while(servers.some(s=>s.name===`新服务 ${n}`))n++;
        servers.push({name:`新服务 ${n}`,transport:'stdio',enabled:true,args:[],env:{},headers:{}});selected=servers.length-1;changed();render();$('name').focus();});
    $('delete').onclick=()=>safe(()=>{if(confirm('移除此 MCP 配置？软件和服务文件会保留。')){servers.splice(selected,1);selected=servers.length?0:-1;changed();render();}});
    $('import').onclick=()=>$('file').click();
    $('file').onchange=async()=>{
        const file=$('file').files[0]; if(!file)return;
        try { capture(); if(file.size>256000)throw Error('配置文件不能超过 256 KB');
            const data=JSON.parse(await file.text());
            if(!data.mcpServers||typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers))throw Error('文件需要包含 mcpServers 对象');
            const added=Object.entries(data.mcpServers).map(([name,s])=>{
                if(!s||typeof s!=='object'||Array.isArray(s))throw Error('服务配置格式有误');
                if(s.type&& !['stdio','http','streamable-http'].includes(s.type))throw Error('目前仅支持 STDIO 和 Streamable HTTP');
                if(servers.some(x=>x.name.toLowerCase()===name.toLowerCase()))throw Error(`服务 ${name} 已存在，请先修改名称`);
                return {name,transport:s.url?'http':'stdio',enabled:s.enabled!==false,command:s.command||'',args:s.args||[],cwd:s.cwd||'',env:s.env||{},url:s.url||'',headers:s.headers||{}};
            });
            if(!added.length)throw Error('没有找到服务配置');
            servers.push(...added);selected=servers.length-added.length;changed();render();status(`已导入 ${added.length} 个服务，请检查后保存。`);
        }catch(e){status(e.message);}finally{$('file').value='';}
    };
    $('save').onclick=async()=>{
        if(busy)return;
        try{capture();setBusy(true);await request('settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({servers})});dirty=false;renderList();status('设置已保存');}
        catch(e){status(e.message);}finally{setBusy(false);}
    };
    $('test').onclick=async()=>{
        if(busy)return;
        try{capture();if(!servers[selected].enabled)throw Error('请先启用此服务再测试连接');setBusy(true);$('result').textContent='正在测试连接，最多等待 30 秒…';
            const data=await request('test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(servers[selected])});
            $('result').textContent=data.ok?`连接测试成功 · ${data.server}\n读取到 ${data.tools.length} 个工具${data.truncated?'（部分）':''}\n`+data.tools.map(t=>t.name).join('\n'):data.error;
        }catch(e){$('result').textContent=e.message;}finally{setBusy(false);}
    };

    let marketAbort, marketSequence=0, marketLoading=false, marketCursor='', marketQuery='';
    function showView(market) {
        $('settings-view').hidden=market; $('market-view').hidden=!market; $('save').hidden=market;
        $('settings-tab').setAttribute('aria-pressed',String(!market));
        $('market-tab').setAttribute('aria-pressed',String(market));
    }
    $('settings-tab').onclick=()=>showView(false);
    $('market-tab').onclick=()=>{showView(true);$('search').focus();};
    function element(tag, text, className) {
        const el=document.createElement(tag); el.textContent=text;
        if(className)el.className=className;
        return el;
    }
    function showDetail(item) {
        const detail=$('market-detail'); detail.replaceChildren(); detail.hidden=false;
        detail.append(element('h3',item.title),element('p',`${item.name} · ${item.version}`,'mcp-muted'),element('p',item.description));
        try {
            const url=new URL(item.website);
            if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){
                const link=element('a','查看项目文档 ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';detail.append(link);
            }
        } catch {}
        const original=element('details','');original.append(element('summary','目录原始配置与安装要求'),element('pre',JSON.stringify(item.metadata,null,2)));
        detail.append(original);
        if(!item.options.length) {
            detail.append(element('p','此服务暂不能自动转换为小美画布配置。请查看项目文档，在“我的配置”中手动添加；支持 STDIO 和 Streamable HTTP。','mcp-muted'));
        } else {
            const label=element('label','选择连接方式','mcp-field'),select=document.createElement('select');
            select.id='mcp-market-option';
            item.options.forEach((option,i)=>{const node=element('option',option.label);node.value=String(i);select.append(node);});label.append(select);
            const preview=element('pre','');preview.id='mcp-market-preview';
            const update=()=>{preview.textContent=JSON.stringify(item.options[Number(select.value)].config,null,2);};
            select.onchange=update; update();
            const add=element('button','添加到我的配置','studio-modal-btn primary');add.id='mcp-market-add';
            add.onclick=()=>safe(()=>{
                capture();
                const config=structuredClone(item.options[Number(select.value)].config);
                if(servers.length>=50)throw Error('最多保存 50 个服务，请先移除不需要的配置。');
                if(servers.some(s=>s.name.toLowerCase()===config.name.toLowerCase()))throw Error('此名称的配置已存在，请在“我的配置”中查看；未重复添加。');
                servers.push(config);selected=servers.length-1;changed();render();showView(false);
                status('已添加停用的配置草稿。请核对命令、地址与鉴权信息，再保存。');$('name').focus();
            });
            detail.append(label,preview,element('p','请补齐空的环境变量、请求头及地址中的占位符。npm 服务测试时可能下载并运行第三方代码，需要本机 Node.js/npx；远程服务可能需要 API Key，浏览器 OAuth 登录尚不支持。PS / Blender 配套插件需按项目文档安装。','mcp-muted'),add);
        }
        detail.scrollIntoView({block:'nearest'});
    }
    async function searchMarket(more=false) {
        if(more && (marketLoading || !marketCursor))return;
        marketAbort?.abort(); const controller=new AbortController(); marketAbort=controller;
        const sequence=++marketSequence; marketLoading=true;
        const timer=setTimeout(()=>controller.abort(),25000);
        if(!more){marketQuery=$('search').value.trim();marketCursor='';$('market-results').replaceChildren();$('market-detail').hidden=true;}
        $('market-more').hidden=true;$('market-status').textContent='正在查询 MCP 官方目录…';
        try {
            const params=new URLSearchParams({q:marketQuery,cursor:more?marketCursor:''});
            const data=await request('market?'+params,{signal:controller.signal});
            if(sequence!==marketSequence)return;
            for(const item of data.items){
                const card=element('article','','mcp-market-card');
                card.append(element('h3',item.title),element('small',item.name,'mcp-muted'),element('p',item.description));
                const button=element('button','查看详情','studio-modal-btn');button.onclick=()=>showDetail(item);
                card.append(element('small',`版本 ${item.version}`,'mcp-muted'),button);$('market-results').append(card);
            }
            marketCursor=data.nextCursor;
            $('market-status').textContent=$('market-results').childElementCount?`已显示 ${$('market-results').childElementCount} 个服务`:'没有找到匹配的服务。试试英文名称或更短的关键词，也可以手动添加配置。';
        } catch(e) {
            if(sequence===marketSequence)$('market-status').textContent=e.name==='AbortError'?'查询超时，请重新搜索。':e.message;
        } finally {
            clearTimeout(timer);
            if(sequence===marketSequence){marketLoading=false;$('market-more').hidden=!marketCursor;}
        }
    }
    $('search-form').onsubmit=e=>{e.preventDefault();searchMarket();};
    $('market-more').onclick=()=>searchMarket(true);
})();
