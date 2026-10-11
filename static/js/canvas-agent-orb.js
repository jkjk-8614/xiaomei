/* 平面柔光 Agent 球：固定圆形身体，不形变、不追鼠标。
   唯二动画：眼睛跟随全局鼠标（平移）+ 眨眼（scaleY），分层互不覆盖：
   .agent-eyes-position 只做 translate3d 追踪，.agent-eyes-blink 只做 scaleY 眨眼。
   入口按钮带 data-agent-orb 即启用，同一页面可放多个实例（画布 Agent、商品研究入口）。
   面板开合时 canvas-agent.js 调用 window.CanvasAgentOrb.reset()；
   _tick 供自动化测试在 rAF 被宿主暂停的环境里手动推进帧。 */
(function(){
    'use strict';
    const toggles=Array.from(document.querySelectorAll('[data-agent-orb]'));
    if(!toggles.length)return;

    // ======== 可调参数：眼睛追踪范围 / 平滑 / 眨眼 ========
    const EYE={maxX:6,maxY:5,nearRange:180,lerp:.2};   // 位移上限 px；距离 <180px 线性衰减；平滑系数 0.16~0.25
    const BLINK={min:2500,max:5000,duration:150,doubleChance:.18};
    // =====================================================

    const mouse={x:0,y:0,inside:false};
    const orbs=toggles.map(function(toggle){
        if(toggle.dataset.eyesBound)return null;
        toggle.dataset.eyesBound='1';
        const eyesPosition=toggle.querySelector('.agent-eyes-position');
        const eyesBlink=toggle.querySelector('.agent-eyes-blink');
        if(!eyesPosition||!eyesBlink)return null;
        // 初始眨眼时刻按实例错开，多球同屏时不同步眨眼
        return {toggle,eyesPosition,eyesBlink,cur:{x:0,y:0},blink:{next:performance.now()+1200+Math.random()*2000,start:0,second:false}};
    }).filter(Boolean);
    if(!orbs.length)return;

    const reduced=matchMedia('(prefers-reduced-motion: reduce)');

    function onMove(event){
        if(event.pointerType&&event.pointerType!=='mouse'&&event.pointerType!=='pen')return;
        mouse.x=event.clientX;mouse.y=event.clientY;mouse.inside=true;
    }
    function onLeaveWindow(){mouse.inside=false;}
    // 全局鼠标感知：绑在 window 上，鼠标在页面任何位置都有效
    window.addEventListener('pointermove',onMove,{passive:true});
    window.addEventListener('blur',onLeaveWindow,{passive:true});
    document.documentElement.addEventListener('mouseleave',onLeaveWindow,{passive:true});

    // 面板打开时入口按钮会被隐藏（hidden），隐藏期间眼睛停在中性位
    function orbVisible(toggle){
        for(let node=toggle;node;node=node.parentElement){
            if(node.hidden)return false;
        }
        return true;
    }

    function tick(now){
        // 眼睛方向 = atan2 单位向量 × 上限 × 距离衰减；鼠标贴近脸时回到中央
        for(const orb of orbs){
            let targetX=0,targetY=0;
            if(mouse.inside&&!orb.toggle.classList.contains('active')&&orbVisible(orb.toggle)){
                const rect=orb.toggle.getBoundingClientRect();
                const dx=mouse.x-(rect.left+rect.width/2);
                const dy=mouse.y-(rect.top+rect.height/2);
                const distance=Math.hypot(dx,dy);
                if(distance>.5){
                    const strength=Math.min(distance/EYE.nearRange,1);
                    targetX=dx/distance*EYE.maxX*strength;
                    targetY=dy/distance*EYE.maxY*strength;
                }
            }
            orb.cur.x+=(targetX-orb.cur.x)*EYE.lerp;
            orb.cur.y+=(targetY-orb.cur.y)*EYE.lerp;
            orb.eyesPosition.style.transform=`translate3d(${orb.cur.x.toFixed(2)}px, ${orb.cur.y.toFixed(2)}px, 0)`;

            // 眨眼：随机 2.5~5s，scaleY 1→0.1→1（约 150ms），偶尔连眨两次
            let scaleY=1;
            const blink=orb.blink;
            if(blink.start){
                const p=(now-blink.start)/BLINK.duration;
                if(p>=1){
                    if(blink.second){blink.second=false;blink.start=now+90;}
                    else blink.start=0;
                }else scaleY=1-.9*Math.sin(Math.PI*p);
            }else if(now>=blink.next&&!orb.toggle.classList.contains('active')&&orbVisible(orb.toggle)){
                blink.start=now;
                blink.second=Math.random()<BLINK.doubleChance;
                blink.next=now+BLINK.min+Math.random()*(BLINK.max-BLINK.min);
            }
            orb.eyesBlink.style.transform=`scaleY(${scaleY.toFixed(3)})`;
        }
    }

    // reset：面板开合时目标归零，眼睛由 lerp 平滑滑回中央
    window.CanvasAgentOrb={reset(){mouse.inside=false;},_tick:tick};

    let loopStarted=false;
    function startLoop(){
        if(loopStarted)return;
        loopStarted=true;
        requestAnimationFrame(function loop(now){
            if(!document.hidden)tick(now);
            requestAnimationFrame(loop);
        });
    }
    // 尊重系统减弱动态偏好：不追踪不眨眼，保持静止中性脸
    if(reduced.matches)tick(performance.now());
    else startLoop();
    reduced.addEventListener?.('change',()=>{if(!reduced.matches)startLoop();});
})();
