"""Isolated UI harness; never reads or writes production settings."""
import sys
import tempfile
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import mcp_settings

if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as folder:
        mcp_settings.CONFIG_PATH = Path(folder) / 'settings.json'
        app = FastAPI()
        app.include_router(mcp_settings.router)
        app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')

        @app.get('/')
        def index():
            return FileResponse(ROOT / 'static' / 'index.html')

        uvicorn.run(app, host='127.0.0.1', port=3129, log_level='error')
