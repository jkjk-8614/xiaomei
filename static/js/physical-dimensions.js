(function(root,factory){
    const api=factory();
    if(typeof module==='object'&&module.exports)module.exports=api;
    else root.XiaomeiPhysicalDimensions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    const units=Object.freeze({mm:1,cm:10,m:1000,in:25.4});
    const empty=value=>value===null||value===undefined||value==='';
    function numeric(value){
        if(empty(value))return null;
        if(typeof value==='boolean'||!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim()||!Number.isFinite(Number(value)))throw new Error('请输入有效的尺寸数字；不知道的尺寸请留空');
        return Number(value);
    }
    function convertToMillimeters(value,unit){if(!Object.hasOwn(units,unit))throw new Error('单位仅支持 mm、cm、m、in');const n=numeric(value);return n===null?null:n*units[unit];}
    function convertFromMillimeters(value,unit){if(!Object.hasOwn(units,unit))throw new Error('单位仅支持 mm、cm、m、in');const n=numeric(value);return n===null?null:n/units[unit];}
    function calculateAspectRatio(width,height){
        const w=numeric(width),h=numeric(height);if(w===null||h===null||w<=0||h<=0)return null;
        // A display fraction is derived only; it never replaces physical input.
        let a=w/h,b=1;
        for(let denominator=1;denominator<=10000;denominator++){
            const numerator=Math.round(w/h*denominator);
            if(numerator>0&&Math.abs(numerator/denominator-w/h)<1e-10){a=numerator;b=denominator;break;}
        }
        return {value:w/h,label:Number.isInteger(a)?a+':'+b:Number(a.toPrecision(10))+':1'};
    }
    function calculateThicknessRatio(width,height,depth){
        const w=numeric(width),h=numeric(height),d=numeric(depth);
        return [w,h,d].some(v=>v===null||v<=0)?null:{depthToWidth:d/w,depthToHeight:d/h};
    }
    function defaults(){return {version:2,enabled:false,width:null,height:null,depth:null,unit:'cm',shape:'rectangle',constraintMode:'prompt',aspectRatioLock:true,thicknessLock:true,outlineLock:true,guideAssetId:null,validationSettings:{enabled:true,tolerancePct:3}};}
    function migrate(raw={},geometry='plane'){
        const base=defaults();
        if((raw.version||1)===1){
            for(const key of ['width','height','depth'])base[key]=empty(raw[key])||Number(raw[key])===0?null:convertToMillimeters(raw[key],raw.unit||'cm');
            base.unit=raw.unit||'cm';base.shape={plane:'rectangle',box:'cuboid',circle:'circle'}[geometry]||'rectangle';
            return base;
        }
        if(raw.version!==2)throw new Error('真实尺寸配置版本暂不支持');
        return {...base,...raw,validationSettings:{...base.validationSettings,...raw.validationSettings}};
    }
    function validatePhysicalDimensions(data){
        const errors=[];
        if(!Object.hasOwn(units,data.unit))errors.push('单位仅支持 mm、cm、m、in');
        if(!['rectangle','cuboid','circle'].includes(data.shape))errors.push('商品形状仅支持矩形平面、立体方盒和圆形平面');
        if(!['prompt','guide','protect'].includes(data.constraintMode))errors.push('尺寸处理方式无效，请重新选择');
        for(const [key,label] of [['width','宽度'],['height','高度'],['depth','厚度']]){
            try{const n=numeric(data[key]);if(n!==null&&(n<=0||n>1e9))errors.push(label+'必须大于 0 且不超过 10亿 mm；未知请留空');else if(n===null&&data.enabled&&key!=='depth')errors.push('已开启商品实物尺寸，请填写'+label);}
            catch{errors.push(label+'请输入有效数字，不知道时请留空');}
        }
        if(!errors.length&&data.enabled&&data.shape==='circle'&&data.width!==null&&data.height!==null&&Math.abs(data.width/data.height-1)>1e-10)errors.push('圆形平面宽、高均表示直径，必须相同；厚度为轴向深度');
        const tolerance=Number(data.validationSettings?.tolerancePct??3);
        if(!Number.isFinite(tolerance)||tolerance<.1||tolerance>20)errors.push('比例误差提示阈值应为 0.1–20%');
        return {valid:!errors.length,errors};
    }
    function buildNormalizedDimensions(data){
        const v=validatePhysicalDimensions(data);if(!v.valid)throw new Error(v.errors.join('；'));
        return {width:data.width,height:data.height,depth:data.depth,unit:'mm',shape:data.shape,aspectRatio:calculateAspectRatio(data.width,data.height),thicknessRatio:calculateThicknessRatio(data.width,data.height,data.depth)};
    }
    function signature(data){return JSON.stringify(['enabled','width','height','depth','shape','constraintMode','aspectRatioLock','thicknessLock','outlineLock','validationSettings'].map(key=>data[key]));}
    class GeometryGuideGenerator{
        static draw(canvas,data,annotated=true){
            const dims=buildNormalizedDimensions(data),w=dims.width,h=dims.height,d=dims.depth;
            canvas.width=960;canvas.height=annotated?405:360;
            const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
            if(!w||!h)return;
            const scale=Math.min(230/Math.max((w+(d||0))*.866,d||0,w),260/(h+(w+(d||0))*.5));
            const W=w*scale,H=h*scale,D=d===null?null:d*scale;
            const polygon=(points,fill='#e3e7eb')=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle='#25333f';ctx.lineWidth=2;ctx.stroke();};
            for(const center of [160,800]){
                const x=center-W/2,y=180-H/2;
                if(center===800){
                    if(dims.shape==='circle')continue;
                    const ix=center-(W+(D||0))*.866/2,iy=180-(H+W*.5)/2+(D||0)*.25;
                    const front=[[ix,iy],[ix+W*.866,iy+W*.5],[ix+W*.866,iy+W*.5+H],[ix,iy+H]];
                    polygon(front);
                    if(D!==null){const dx=D*.866,dy=-D*.5;polygon([front[0],[ix+dx,iy+dy],[ix+W*.866+dx,iy+W*.5+dy],front[1]],'#f1f3f5');polygon([front[1],[front[1][0]+dx,front[1][1]+dy],[front[2][0]+dx,front[2][1]+dy],front[2]],'#bfc8d0');}
                    continue;
                }
                if(dims.shape==='circle'){ctx.beginPath();ctx.ellipse(center,180,W/2,H/2,0,0,2*Math.PI);ctx.fillStyle='#e3e7eb';ctx.fill();ctx.strokeStyle='#25333f';ctx.stroke();}
                else polygon([[x,y],[x+W,y],[x+W,y+H],[x,y+H]]);
            }
            if(D!==null)polygon([[480-D/2,180-H/2],[480+D/2,180-H/2],[480+D/2,180+H/2],[480-D/2,180+H/2]]);
            if(annotated){
                ctx.fillStyle='#25333f';ctx.font='18px sans-serif';ctx.textAlign='center';
                const display=key=>data[key]===null?'未知':Number(convertFromMillimeters(data[key],data.unit).toPrecision(12))+' '+data.unit;
                ['正面 '+display('width')+' × '+display('height'),D===null?'侧面：厚度未知':'侧面 '+display('depth')+' × '+display('height'),dims.shape==='circle'?'圆形平面（直径／轴向厚度）':'简化轴测代理'].forEach((s,i)=>ctx.fillText(s,160+i*320,380));
            }
        }
    }
    return {units,defaults,migrate,signature,convertToMillimeters,convertFromMillimeters,calculateAspectRatio,calculateThicknessRatio,validatePhysicalDimensions,buildNormalizedDimensions,GeometryGuideGenerator};
});
