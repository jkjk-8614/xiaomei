"""Transactional, project scoped journal for autonomous canvas agents (stdlib only)."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

TERMINAL = {"completed", "failed", "cancelled"}
STATUSES = TERMINAL | {"queued", "running", "waiting_dependency", "awaiting_approval", "waiting_result"}


def now():
    return int(time.time() * 1000)


def uid(prefix):
    return prefix + uuid.uuid4().hex


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class AgentError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class AgentRunStore:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.lock = threading.RLock()
        self.local = threading.local()
        self.initialized = False

    @contextmanager
    def transaction(self):
        with self.lock:
            active = getattr(self.local, "db", None)
            if active is not None:
                yield active
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(self.path, timeout=15)
            db.row_factory = sqlite3.Row
            try:
                db.execute("PRAGMA foreign_keys=ON")
                if not self.initialized:
                    db.execute("PRAGMA journal_mode=WAL")
                    version = db.execute("PRAGMA user_version").fetchone()[0]
                    if version > 1:
                        raise AgentError("store_version", "运行记录来自更新版本，请升级小美画布", 503)
                    db.executescript("""
                        CREATE TABLE IF NOT EXISTS runs (
                            run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, canvas_id TEXT NOT NULL,
                            idem TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id,canvas_id,idem));
                        CREATE TABLE IF NOT EXISTS tasks (
                            task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                            parent_task_id TEXT NOT NULL, idem TEXT NOT NULL, payload TEXT NOT NULL,
                            UNIQUE(run_id,parent_task_id,idem));
                        CREATE TABLE IF NOT EXISTS actions (
                            action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                            task_id TEXT NOT NULL REFERENCES tasks(task_id), idem TEXT NOT NULL,
                            payload TEXT NOT NULL, UNIQUE(task_id,idem));
                        CREATE TABLE IF NOT EXISTS events (
                            seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id),
                            task_id TEXT NOT NULL, payload TEXT NOT NULL);
                        CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
                        CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id,canvas_id);
                        PRAGMA user_version=1;
                    """)
                    self.initialized = True
                db.execute("BEGIN IMMEDIATE")
                self.local.db = db
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                self.local.db = None
                db.close()

    @staticmethod
    def get(db, table, ident):
        keys = {"runs": "run_id", "tasks": "task_id", "actions": "action_id"}
        row = db.execute(f"SELECT payload FROM {table} WHERE {keys[table]}=?", (ident,)).fetchone()
        if not row:
            raise AgentError("not_found", "未找到当前项目的代理任务", 404)
        return json.loads(row[0])

    @staticmethod
    def put(db, table, value):
        key = {"runs": "run_id", "tasks": "task_id", "actions": "action_id"}[table]
        value["updated_at"] = now()
        db.execute(f"UPDATE {table} SET payload=? WHERE {key}=?", (dump(value), value[key]))
        return value

    @staticmethod
    def rows(db, table, run_id):
        return [json.loads(r[0]) for r in db.execute(f"SELECT payload FROM {table} WHERE run_id=? ORDER BY rowid", (run_id,))]

    @staticmethod
    def event(db, run_id, task_id, kind, **data):
        db.execute("INSERT INTO events(run_id,task_id,payload) VALUES(?,?,?)",
                   (run_id, task_id, dump({"at": now(), "task_id": task_id, "type": kind, **data})))

    @staticmethod
    def scoped(db, run_id, project_id, canvas_id=""):
        run = AgentRunStore.get(db, "runs", run_id)
        if run["project_id"] != project_id or canvas_id and run["canvas_id"] != canvas_id:
            raise AgentError("not_found", "未找到当前项目的代理任务", 404)
        return run

    def create(self, request, context):
        payload = request.model_dump()
        signature = digest(payload)
        with self.transaction() as db:
            old = db.execute("SELECT payload FROM runs WHERE project_id=? AND canvas_id=? AND idem=?",
                             (request.project_id, request.canvas_id, request.idempotency_key)).fetchone()
            if old:
                run = json.loads(old[0])
                if run["signature"] != signature:
                    raise AgentError("idempotency_conflict", "同一任务编号不能提交不同内容，请新建任务")
                return run, False
            run_id, task_id, timestamp = uid("mar_"), uid("mat_"), now()
            run = {"run_id": run_id, "root_task_id": task_id, "project_id": request.project_id,
                   "canvas_id": request.canvas_id, "goal": request.goal, "status": "queued",
                   "limits": request.limits.model_dump(), "policy": request.policy.model_dump(),
                   "context": context, "steps": 0, "estimated_cost": 0.0, "generation_count": 0,
                   "token_usage": {"input_tokens": 0, "output_tokens": 0, "estimated_tokens": 0},
                   "created_at": timestamp, "updated_at": timestamp, "signature": signature,
                   "cancel_requested": False, "recovery_required": False, "error": ""}
            task = self.new_task(run, task_id, "", "main", 0, request.goal, request.instructions,
                                 request.provider_id, request.model, request.allowed_tools, [], "root")
            db.execute("INSERT INTO runs VALUES(?,?,?,?,?)", (run_id, request.project_id, request.canvas_id, request.idempotency_key, dump(run)))
            self.insert_task(db, task)
            self.event(db, run_id, task_id, "created", message="智能分工任务已创建")
            return run, True

    @staticmethod
    def new_task(run, task_id, parent, role, depth, goal, instructions, provider, model, allowed, deps, idem):
        return {"run_id": run["run_id"], "task_id": task_id, "parent_task_id": parent or None,
                "project_id": run["project_id"], "canvas_id": run["canvas_id"], "agent_role": role,
                "depth": depth, "goal": goal, "instructions": instructions, "provider_id": provider,
                "model": model, "allowed_tools": allowed, "dependencies": deps,
                "status": "waiting_dependency" if deps else "queued", "result_refs": [], "summary": "",
                "created_at": now(), "updated_at": now(), "token_usage": {}, "estimated_cost": 0.0,
                "steps": 0, "messages": [], "waiting_for": None, "error": "", "idempotency_key": idem}

    @staticmethod
    def insert_task(db, task):
        db.execute("INSERT INTO tasks VALUES(?,?,?,?,?)", (task["task_id"], task["run_id"], task["parent_task_id"] or "", task["idempotency_key"], dump(task)))

    def snapshot(self, run_id, project_id, canvas_id="", after=0):
        with self.transaction() as db:
            run = self.scoped(db, run_id, project_id, canvas_id)
            tasks = self.rows(db, "tasks", run_id)
            actions = self.rows(db, "actions", run_id)
            events = [{"seq": row[0], **json.loads(row[1])} for row in db.execute(
                "SELECT seq,payload FROM events WHERE run_id=? AND seq>? ORDER BY seq DESC LIMIT 300", (run_id, after))][::-1]
            public = {k: v for k, v in run.items() if k not in {"context", "signature"}}
            # Browser execution leases are never part of model or history context.
            actions = [{k: v for k, v in a.items() if k not in {"lease_token", "request_signature"}}
                       | {"submission_started": bool(a.get("request_signature"))} for a in actions]
            return {"run": public, "tasks": tasks, "actions": actions, "events": events,
                    "cursor": events[-1]["seq"] if events else after}

    def history(self, project_id, canvas_id=""):
        with self.transaction() as db:
            rows = db.execute("SELECT payload FROM runs WHERE project_id=? AND (?='' OR canvas_id=?) ORDER BY rowid DESC LIMIT 50", (project_id, canvas_id, canvas_id))
            return [{k: v for k, v in json.loads(row[0]).items() if k not in {"context", "signature"}} for row in rows]

    def usage(self, project_id):
        with self.transaction() as db:
            runs = [json.loads(r[0]) for r in db.execute("SELECT payload FROM runs WHERE project_id=?", (project_id,))]
            return {"estimated_cost": round(sum(r["estimated_cost"] for r in runs), 8),
                    "generation_count": sum(r["generation_count"] for r in runs),
                    "token_usage": {k: sum(r["token_usage"].get(k, 0) for r in runs) for k in ("input_tokens", "output_tokens", "estimated_tokens")}}

    def recover(self):
        with self.transaction() as db:
            runs = [json.loads(r[0]) for r in db.execute("SELECT payload FROM runs")]
            for run in runs:
                if run["status"] in TERMINAL:
                    continue
                run.update(status="waiting_result", recovery_required=True, error="应用已重启，请核对已有任务后继续")
                self.put(db, "runs", run)
                for task in self.rows(db, "tasks", run["run_id"]):
                    if task["status"] == "running":
                        task.update(status="waiting_result", error="模型调用在重启时中断，继续后才重新分析", interrupted_model=True)
                        self.put(db, "tasks", task)
                for action in self.rows(db, "actions", run["run_id"]):
                    if action["status"] in {"claimed", "executing"}:
                        action.update(status="waiting_result", error="执行状态待核对；不会自动重新提交")
                        self.put(db, "actions", action)
                self.event(db, run["run_id"], run["root_task_id"], "recovery", message=run["error"])
