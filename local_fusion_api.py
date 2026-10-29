"""Bounded, cancellable local fusion jobs, registered by the existing application."""
import asyncio
import json
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from local_fusion import FusionRequest, FusionCancelled, fuse


def create_fusion_router(resolve, save_image, register_media):
    router = APIRouter(prefix='/api/local-fusion', tags=['local-fusion'])
    jobs = {}
    tasks = set()
    lock = threading.RLock()
    slots = asyncio.Semaphore(2)

    def snapshot(job):
        return {k: v for k, v in job.items() if k != 'cancel'}

    def worker(job, payload):
        saved = []
        try:
            def progress(message):
                with lock:
                    job['message'] = message
            image, mask, report = fuse(payload, resolve, job['cancel'].is_set, progress)
            with lock:
                if job['cancel'].is_set():
                    raise FusionCancelled()
            stem = 'local_fusion_' + uuid.uuid4().hex
            url = save_image(image, stem+'.png')
            saved.append(Path(resolve(url)))
            mask_url = save_image(mask, stem+'_mask.png')
            saved.append(Path(resolve(mask_url)))
            image.close()
            mask.close()
            metadata = saved[0].with_suffix('.json')
            temporary = metadata.with_suffix('.json.tmp')
            saved.extend([metadata, temporary])
            temporary.write_text(json.dumps({'request': payload.model_dump(), 'report': report}, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, metadata)
            with lock:
                if job['cancel'].is_set():
                    raise FusionCancelled()
                record = register_media(url, name='局部融合结果.png', kind='image', source='generated',
                                        derived_from=[payload.sourceUrl]+[p.url for p in payload.patches],
                                        metadata={'operation': 'local-fusion', 'paid_api': False})
                job.update(status='completed', message='融合预览已完成，请检查后输出',
                           result={'url': url, 'maskUrl': mask_url, 'name': '局部融合结果.png',
                                   'width': report['width'], 'height': report['height'], 'report': report,
                                   'asset_ref_id': (record or {}).get('id', '')})
        except FusionCancelled:
            for path in saved:
                path.unlink(missing_ok=True)
            with lock:
                job.update(status='cancelled', message='已取消融合')
        except Exception as exc:
            for path in saved:
                path.unlink(missing_ok=True)
            with lock:
                job.update(status='failed', message=str(exc) if isinstance(exc, ValueError) else '图片处理失败，请检查输入图片后重试')
        finally:
            with lock:
                job['finishedAt'] = time.time()

    async def run(job, payload):
        async with slots:
            with lock:
                if job['cancel'].is_set():
                    job.update(status='cancelled', message='已取消融合', finishedAt=time.time())
                    return
                job['status'] = 'running'
            await asyncio.to_thread(worker, job, payload)

    @router.post('/jobs', status_code=202)
    async def start(payload: FusionRequest):
        with lock:
            for key in list(jobs):
                if jobs[key].get('finishedAt', float('inf')) < time.time()-3600:
                    del jobs[key]
            if sum(j['status'] in ('queued', 'running') for j in jobs.values()) >= 8:
                raise HTTPException(429, '本地融合任务较多，请稍后重试')
            if len(jobs) >= 100:
                finished = [key for key in jobs if jobs[key]['status'] not in ('queued', 'running')]
                if finished:
                    del jobs[finished[0]]
            job = {'id': uuid.uuid4().hex, 'status': 'queued', 'message': '等待本地融合',
                   'createdAt': time.time(), 'cancel': threading.Event()}
            jobs[job['id']] = job
            task = asyncio.create_task(run(job, payload))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            return snapshot(job)

    @router.get('/jobs/{job_id}')
    async def status(job_id: str):
        with lock:
            if job_id not in jobs:
                raise HTTPException(404, '融合任务已结束或服务已重启，请重新融合')
            return snapshot(jobs[job_id])

    @router.delete('/jobs/{job_id}')
    async def cancel(job_id: str):
        with lock:
            if job_id not in jobs:
                raise HTTPException(404, '融合任务不存在')
            job = jobs[job_id]
            if job['status'] in ('queued', 'running'):
                job['cancel'].set()
                job['message'] = '正在取消融合'
            return snapshot(job)

    return router
