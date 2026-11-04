"""Product retouch strategies and local checks; generation uses the shared queue."""
import copy
import math
import hashlib
import json
import re

import numpy as np
from PIL import Image, ImageDraw

from product_fidelity import load_image


class ProductRetouchService:
    PLAN_MARKER = '<!-- xiaomei-product-retouch-plan:v1 -->'
    BAG_PLAN_NAME = '箱包 · 平整挺括'
    LEGACY_CLOTHING_BAGS_RULE = (
        '以商品整理到位后的棚拍效果为目标，修平挤压、折叠或摆放造成的杂乱皱褶、鼓包和局部塌陷。'
        '箱包重点整理正面大面、前袋和底角，让包身平整饱满、边角利落，在原有外轮廓内恢复自然撑开的立体感。'
        '服饰重点整理大面积压皱，保留自然垂坠、接缝起伏和设计自带的褶裥。'
        '柔化皱褶造成的斑驳高光和暗纹，以均匀柔和的光线呈现原有色彩，保留细微织纹、皮革纹理和符合材质的光泽。'
        '避免磨皮、塑料感和过度锐化。保留原有版型、比例及肩带、提手、拉链、车线和口袋的形状与位置。'
    )
    CATEGORIES = {
        'general': ('通用', '自然改善材质、柔和光影、边缘、纹理和清晰度，消除压缩噪声，避免过度锐化和塑料感。'),
        'jewelry': ('饰品', '保留镶嵌、爪位、链节和宝石数量；改善金属光泽和真实宝石反光，不添加钻石或刻字。'),
        'hardware': ('五金', '保护孔位、螺纹、切口、边缘、倒角和零件数量；清晰呈现真实金属加工纹理，不补画未知孔洞。'),
        'electronics': (
            '3C 数码',
            '以干净的电商棚拍效果为目标，清理指纹、浮尘、污渍和表面细小划痕，还原产品原色。'
            '沿原有光线方向整理反光，压低刺眼亮斑，保留均匀的明暗过渡和清晰边缘。'
            '区分哑光塑料、亮面金属、玻璃与橡胶的原有质感，保留细微纹理，避免过度锐化或统一磨成镜面。'
            '保留接口、插孔、按键、指示灯、接缝、线材及接头的数量、形状和相对位置，保留原有标识、图标和印字。'
            '保持原视角与构图，未点亮的屏幕和指示灯保持原状。',
        ),
        'clothing': (
            '服饰',
            '按熨烫并整理后的电商棚拍效果精修。抚平衣身和袖面因悬挂、折叠或挤压产生的皱褶、波浪和鼓包，淡化对应的深浅皱痕。'
            '顺着原有剪裁整理可见的领口、肩线、门襟、袖口和下摆，让门襟平直、领口与袖型自然挺顺、下摆边缘利落。'
            '只校正摆放造成的局部歪斜，保留原视角、原版型、肩宽、衣长、袖长和设计自带的褶裥与不对称结构。'
            '结构与外轮廓保护以服装本体为准。清除确认属于拍摄道具的衣架、挂钩和固定夹，包括领口内露出的衣架。'
            '保留服装自带的挂袢、领标、纽扣、缝线、口袋和装饰。'
            '用均匀柔和的光线呈现原有面料颜色与细微织纹，保留自然垂坠和接缝处的立体层次，避免磨皮和塑料感。',
        ),
        'bags': (
            '箱包',
            '先按同一只包填充撑开、整理定型后的状态修复软质包身，再整理光影。让包身平整饱满，呈现干净挺括的棚拍效果。'
            '把主包正面和前袋面修成连续平整、略带自然弧度的大面，消除挤压形成的深折、凹坑、波浪和鼓包。'
            '撑开塌进去的侧片和底角，修顺因塌陷而内凹的局部外边线。包口沿原有弧线连贯顺滑，前袋边缘整齐，底边自然承托包身。'
            '同步消除压皱产生的暗沟和碎亮斑，用柔和均匀的棚拍光呈现连续的明暗过渡。保留原色和低对比的细微材质纹理，避免强化织纹或产生塑料感。'
            '保留原有包型、硬壳结构和设计性的折边，保留肩带、提手、拉链轨迹与拉头、车线、口袋和五金的数量及相对位置。',
        ),
        'glass': ('玻璃透明', '改善透明度、边缘、反射与折射，保留真实透光、液体和厚度；不得把透明区域填成不透明材质。'),
        'pouch': (
            '包装袋',
            '把袋身修得平整、饱满，抚平正面和袋底的杂乱压皱，减弱封口处不均匀的波浪皱与刺眼反光。'
            '用均匀柔和的光线呈现原有材质、色彩和渐变，保留边角轻微的起伏与高光，维持软包装的立体感。'
            '保留原袋型、比例、挂孔、撕口、拉链、封边及折边的位置与结构。'
            '让真实印刷清晰可读，保留原有 Logo、文字、条码的内容、字形、颜色和排版。'
            '去除能明确辨认的反光、透印或拍摄叠影造成的重复虚像，保留真实印刷本身；'
            '无法判断是真实印刷还是叠影时保持原样。',
        ),
        'plush': ('毛绒玩具', '保留轮廓、缝线、五官、配件和绒毛方向；改善真实毛绒质感，不增删肢体或改变表情。'),
    }

    @staticmethod
    def text(value, label, limit, required=False):
        if not isinstance(value, str):
            raise ValueError(f'{label}必须是文字')
        value = value.strip()
        if len(value) > limit:
            raise ValueError(f'{label}不能超过 {limit} 字')
        if required and not value:
            raise ValueError(f'请填写{label}')
        return value

    @classmethod
    def normalize_plan(cls, raw):
        if not isinstance(raw, dict):
            raise ValueError('精修方案格式无效')
        result = {}
        for key, label, limit, required in (
            ('name', '方案名称', 120, True), ('subject', '产品与材质', 500, False),
            ('improve', '改善要求', 3000, True), ('preserve', '保留要求', 3000, False),
            ('skill_id', '方案 Skill 编号', 120, False), ('skill_version', '方案版本', 128, False),
        ):
            result[key] = cls.text(raw.get(key, ''), label, limit, required)
        return result

    @classmethod
    def builtin_plans(cls):
        names = {'general': '通用 · 自然提质', 'hardware': '金属 · 自然提质', 'electronics': '3C 数码 · 洁净提质',
                 'clothing': '服饰 · 熨平整形', 'bags': cls.BAG_PLAN_NAME, 'glass': '玻璃 · 保留透光'}
        plans = [dict(key=key, name=names.get(key, name), category=key,
                      plan=cls.normalize_plan(dict(name=names.get(key, name), subject=name, improve=rule)))
                 for key, (name, rule) in cls.CATEGORIES.items()]
        for key, name, subject, improve, preserve, category in (
            ('metal-refurbish', '金属厨具 · 去污翻新', '金属厨具及其非金属配件',
             '去除表面污渍和锈斑，恢复原有材质质感，柔化杂乱反光。',
             '保留真实金属加工纹理、原始材质底色和配件；不修成镜面，不重设计商品。', 'hardware'),
            ('vintage', '旧物 · 保留包浆', '旧物、古董及有使用痕迹的商品',
             '改善曝光、清晰度和光影，清理拍摄噪声。',
             '保留包浆、锈色、磨损、划痕及年代感，不翻新、不抛光。', 'general'),
            ('leather', '皮具 · 保留纹理', '皮革箱包及皮具',
             '改善光影和色彩层次，呈现自然皮革纹理。',
             '保留毛孔、车线、压纹和自然褶皱，不磨成塑料质感。', 'bags'),
        ):
            plans.append(dict(key=key, name=name, category=category,
                              plan=cls.normalize_plan(dict(name=name, subject=subject, improve=improve, preserve=preserve))))
        return plans

    @classmethod
    def plan_skill_instructions(cls, plan):
        plan = cls.normalize_plan(plan)
        rules = {key: plan[key] for key in ('name', 'subject', 'improve', 'preserve')}
        return (cls.PLAN_MARKER + '\n\n'
                '对商品原图执行以下精修规则。保持产品身份、部件与构图；本次要求仅在保护约束内补充。\n'
                '不根据效果参考替换当前商品的造型、文字或 Logo。\n\n```json\n' +
                json.dumps(rules, ensure_ascii=False, indent=2) + '\n```\n')

    @classmethod
    def plan_from_skill(cls, record):
        if not record or record.get('enabled') is False or record.get('lifecycle') == 'draft':
            return None
        instructions = str(record.get('instructions') or '')
        if not instructions.lstrip().startswith(cls.PLAN_MARKER):
            return None
        match = re.search(r'^```json\s*\n(.*?)\n```\s*$', instructions, re.M | re.S)
        if not match:
            return None
        try:
            raw = json.loads(match.group(1))
            if not isinstance(raw, dict):
                return None
            raw.update(name=record.get('display_name') or record.get('name') or raw.get('name', ''),
                       skill_id=record.get('id', ''),
                       skill_version=hashlib.sha256(instructions.encode('utf-8')).hexdigest())
            return cls.normalize_plan(raw)
        except (ValueError, TypeError):
            return None

    @classmethod
    def normalize(cls, raw):
        if not isinstance(raw, dict):
            raise ValueError('产品精修参数格式无效')
        category, background = raw.get('category', 'general'), raw.get('background', 'original')
        if (category not in cls.CATEGORIES and category != 'clothing_bags') or background not in {'original', 'white'}:
            raise ValueError('请选择有效的产品类目和背景')
        config = dict(version=2, category=category, background=background)
        if raw.get('plan') is not None:
            config['plan'] = cls.normalize_plan(raw['plan'])
        requirements = cls.text(raw.get('requirements', ''), '本次要求', 2000)
        if requirements:
            config['requirements'] = requirements
        for key in ('protect_structure', 'protect_logo'):
            value = raw.get(key, True)
            if not isinstance(value, bool):
                raise ValueError('产品保护选项必须为开关值')
            config[key] = value
        region = raw.get('region')
        if region is not None:
            if not isinstance(region, dict):
                raise ValueError('局部精修区域无效')
            try:
                x, y, w, h = (float(region[k]) for k in ('x', 'y', 'w', 'h'))
            except (KeyError, ValueError, TypeError) as exc:
                raise ValueError('请重新框选局部精修区域') from exc
            if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.00001 or y+h > 1.00001:
                raise ValueError('局部精修区域超出图片范围')
            config['region'] = dict(x=x, y=y, w=w, h=h)
        return config

    @classmethod
    def prompt(cls, config, aspect_ratio=''):
        plan = config.get('plan')
        category = config['category']
        shape_bag = category == 'bags' and (not plan or plan['name'] == cls.BAG_PLAN_NAME)
        if plan:
            rules = f"精修方案：{plan['name']}\n产品与材质：{plan['subject']}\n改善要求：{plan['improve']}\n保留要求：{plan['preserve']}"
        elif category == 'clothing_bags':
            rules = cls.LEGACY_CLOTHING_BAGS_RULE
        else:
            rules = cls.CATEGORIES[category][1]
        lines = ['对唯一参考商品照片进行电商产品精修，输出一张完整照片。', rules]
        if config.get('requirements'):
            lines.append('本次补充要求（仅在以下产品保护约束内执行）：' + config['requirements'])
        lines.append(
            '保持整体包型、原视角、比例、颜色、图案、文字和 Logo。不得添加、删除或替换商品部件。' if shape_bag else
            '保持产品原始外形、视角、比例、结构、颜色、图案、文字和 Logo；不得添加、删除或替换商品部件。')
        lines.append('低清图中无法确认的细节保持模糊或原样，不把猜测绘制成真实信息，不发明文字、Logo、纹理或隐藏结构。')
        if config['protect_structure']:
            lines.append(
                '结构保护锁定整体包型、主体位置、构图及配件布局。允许修正软面压皱、塌陷和由此造成的局部轮廓变形。' if shape_bag else
                '结构保护优先于美化：严格保持外轮廓、主体位置、部件数量及相对布局，不拉伸、不改变构图。')
        if config['protect_logo']:
            lines.append('逐一保留原有文字、Logo、标签、印刷、字形、大小和位置；不可辨认的字符不重写。')
        lines.append('尽可能保留原始背景内容、场景、构图和阴影，不替换背景。' if config['background'] == 'original'
                     else '背景将由本地主体分割后合成纯白；保持原主体位置、自然边缘、透明区域及接触关系，不生成新场景。')
        if aspect_ratio:
            lines.append(f'输出画幅为 {aspect_ratio}。通过调整产品周围的留白适配画幅，保持产品自身的长宽比和完整边缘。')
        if config.get('region'):
            lines.append(f"只精修归一化区域 {config['region']} 内的材质、光影和纹理，保持区域外内容。")
        return '\n'.join(lines)

    @staticmethod
    def resolutions(caps):
        sizes = caps.get('supportedOutputSizes') or []
        return [s.lower() for s in sizes if s in {'1K', '2K', '4K'}] or ['1k', '2k', '4k']

    @classmethod
    def validate(cls, payload, provider, caps):
        config = cls.normalize(payload.product_retouch)
        if not provider.get('enabled', True) or payload.model not in (provider.get('image_models') or []):
            raise ValueError('精修模型已移除或不可用，请重新选择')
        if not caps.get('supportsImageEditing') or not caps.get('supportsImageReferences'):
            raise ValueError('所选模型不支持当前产品精修参考图编辑，请选择兼容模型')
        if payload.resolution not in cls.resolutions(caps):
            raise ValueError('所选模型不支持该输出清晰度，请重新选择')
        if len(payload.reference_images) != 1 or not payload.reference_images[0].url:
            raise ValueError('每个精修任务需要一张已导入画布的商品原图')
        if payload.operation or payload.outpaint_mode or payload.product_fidelity.get('enabled'):
            raise ValueError('产品精修不能与扩图、放大或其他产品保真任务同时执行')
        if payload.n != 1:
            raise ValueError('每个精修任务只处理一张图片；批量图片请分别提交')
        return config

    @classmethod
    def prepare(cls, payload, provider, caps, resolve, segment=None):
        config = cls.validate(payload, provider, caps)
        url = payload.reference_images[0].url
        source = load_image(url, resolve)
        warnings = []
        if min(source.size) < 512:
            warnings.append('原图较低清，文字、Logo、螺纹、车线及细小部件可能无法确认，请对照原图逐项检查。')
        mask = None
        if source.getchannel('A').getextrema()[0] < 255:
            mask = source.getchannel('A')
        elif segment:
            cutout = segment(resolve(url))
            mask = cutout.getchannel('A')
            cutout.close()
        if config['background'] == 'white' and mask is None:
            raise ValueError('白底精修需要本地主体分割，请先在“去背景”入口完成模型下载')
        if mask is not None and not mask.point(lambda p: 255 if p > 32 else 0).getbbox():
            raise ValueError('未识别到商品主体，请替换图片或先检查去背景结果')
        if config['category'] == 'glass' and config['background'] == 'white':
            warnings.append('透明玻璃的折射、半透明边缘和原背景残色需人工检查。')
        warnings.append('文字、Logo 和部件语义尚未自动核验，请使用原图对比；保护选项属于模型约束，不保证逐像素不变。')
        return dict(config=config, source=source, source_url=url, mask=mask, segment=segment,
                    resolution=payload.resolution, model=payload.model, provider_id=provider['id'], warnings=warnings)

    @staticmethod
    def geometry(source_mask, output_mask):
        if source_mask is None or output_mask is None:
            return dict(status='unknown', reason='缺少可靠主体分割，尚未自动核验外轮廓、主体位置和结构')
        masks = [np.asarray(m.resize((256, 256), Image.Resampling.BILINEAR)) > 96 for m in (source_mask, output_mask)]
        a, b = masks
        if min(int(a.sum()), int(b.sum())) < 64 or max(float(a.mean()), float(b.mean())) > .98:
            return dict(status='unknown', reason='主体分割范围不可靠，请人工核对')
        iou = float((a & b).sum() / max(1, (a | b).sum()))
        centers = [np.array(np.where(m)).mean(axis=1) / 256 for m in masks]
        shift = float(np.linalg.norm(centers[0] - centers[1]))
        area = abs(float(b.sum() / a.sum()) - 1)
        failed = iou < .72 or shift > .06 or area > .22
        return dict(status='warning' if failed else 'checked', outline_iou=round(iou, 4),
                    center_shift=round(shift, 4), area_change=round(area, 4),
                    reason='发现明显主体轮廓或位置差异，请检查原图与结果' if failed else '主体分割轮廓及位置接近；孔位、部件和文字仍需人工检查')

    @classmethod
    def finish(cls, context, url, resolve, save):
        generated = load_image(url, resolve)
        source, config = context['source'], context['config']
        warnings = list(context['warnings'])
        actual_size = list(generated.size)
        expected_ratio = context.get('submitted_aspect_ratio')
        expected_width, expected_height = map(int, expected_ratio.split(':')) if expected_ratio else source.size
        aspect_ratio_changed = abs(generated.width / generated.height / (expected_width / expected_height) - 1) > .035
        expected_frame = f'目标 {expected_ratio}' if expected_ratio else f'原图 {source.width}×{source.height}'
        aspect_ratio_reason = (f'画幅比例变化（{expected_frame}，'
                               f'结果 {generated.width}×{generated.height}），请核对构图。')
        requested_edge = {'1k': 1024, '2k': 2048, '4k': 4096}[context['resolution']]
        # Report decoded pixels; never resize the result to claim a higher resolution.
        if max(generated.size) < requested_edge * .9:
            warnings.append(f'实际输出 {generated.width}×{generated.height}，未达到所选 {context["resolution"].upper()} 长边档位；未进行插值放大。')
        output_mask = None
        if generated.getchannel('A').getextrema()[0] < 255:
            output_mask = generated.getchannel('A')
        elif context.get('segment'):
            cutout = context['segment'](resolve(url))
            output_mask = cutout.getchannel('A')
            cutout.close()
        validation = cls.geometry(context['mask'], output_mask)
        warnings.append(validation['reason'])
        if aspect_ratio_changed:
            warnings.append(aspect_ratio_reason)
            validation = {**validation, 'status': 'warning', 'reason': aspect_ratio_reason, 'aspect_ratio_changed': True}
        validation['scope'] = '主体分割轮廓、面积与位置；不包含 OCR、部件语义或真实材质鉴定'
        region = config.get('region')
        if region:
            if aspect_ratio_changed:
                raise ValueError('局部精修输出画幅变化过大，已停止合成，请选择兼容原图比例的模型')
            original = source.resize(generated.size, Image.Resampling.LANCZOS)
            local_mask = Image.new('L', generated.size, 0)
            x, y, w, h = (region[k] for k in ('x', 'y', 'w', 'h'))
            ImageDraw.Draw(local_mask).rectangle((round(x*generated.width), round(y*generated.height),
                                                 round((x+w)*generated.width)-1, round((y+h)*generated.height)-1), fill=255)
            generated = Image.composite(generated, original, local_mask)
            warnings.append('局部精修区域外使用原图等比采样像素；请检查区域接缝。')
        if config['background'] == 'white':
            if output_mask is None:
                raise ValueError('输出主体分割不可用，未将模型背景当作白底精修结果')
            if not output_mask.point(lambda p: 255 if p > 32 else 0).getbbox():
                raise ValueError('结果未识别到商品主体，请检查模型输出')
            if region and context['mask'] is not None:
                output_mask = Image.composite(output_mask, context['mask'].resize(generated.size), local_mask)
            # Fractional alpha preserves hair and glass edges; do not threshold or recenter.
            generated = Image.composite(generated.convert('RGB'), Image.new('RGB', generated.size, 'white'), output_mask)
        final_url = save(generated)
        record = dict(config=copy.deepcopy(config), source_url=context['source_url'], model=context['model'],
                      provider_id=context['provider_id'], requested_resolution=context['resolution'], actual_size=actual_size,
                      validation=validation, warnings=list(dict.fromkeys(warnings)), review_required=True,
                      background_method='local-segmentation-composite' if config['background'] == 'white' else 'reference-preserve',
                      submitted_prompt=cls.prompt(config, expected_ratio))
        return final_url, record
