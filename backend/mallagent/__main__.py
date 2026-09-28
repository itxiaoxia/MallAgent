from __future__ import annotations

import argparse

import uvicorn

from .api import app


def main() -> None:
    parser = argparse.ArgumentParser(description="MallAgent local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=45831)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
