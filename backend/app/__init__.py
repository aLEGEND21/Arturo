"""Load backend/.env for host-run dev servers (`uvicorn app.main:app`), before
any submodule reads the environment. Real environment variables win, so under
compose (env_file + environment) this is a no-op; the file is not copied into
the image anyway."""
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
