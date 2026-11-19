import os

import uvicorn

from .logs import uvicorn_log_config

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        log_config=uvicorn_log_config(),
        workers=1,  # one process: models are loaded once; concurrency is the FACESWAP_WORKERS thread pool
        timeout_keep_alive=30,
    )
