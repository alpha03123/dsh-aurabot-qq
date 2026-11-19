#!/usr/bin/env python3
"""
本地 CPU 向量检索服务（OpenAI /v1/embeddings 兼容接口），供 Aurabot memory.vector 使用。
优先使用 fastembed（ONNX Runtime 纯 CPU，轻量极速，默认 BAAI/bge-small-zh-v1.5），
若未安装 fastembed 则回退到 sentence-transformers（纯 CPU）。

用法：
  python tools/local-bge-embed.py --host 127.0.0.1 --port 11435 --model BAAI/bge-small-zh-v1.5

Aurabot 面板设置：
  服务地址：http://127.0.0.1:11435/v1
  模型：BAAI/bge-small-zh-v1.5
  API Key：留空
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Embedder:
    def __init__(self, model_name: str, threads: int = 4):
        self.model_name = model_name
        self.lock = threading.Lock()
        self.backend = None
        self.model = None
        self._load(model_name, threads)

    def _load(self, model_name: str, threads: int):
        t0 = time.time()
        try:
            from fastembed import TextEmbedding

            self.model = TextEmbedding(model_name=model_name, threads=threads)
            self.backend = "fastembed"
            # 预热一次，确保首次查询不超时
            list(self.model.embed(["预热"]))
            print(
                f"[local-bge-embed] loaded {model_name} via fastembed (CPU) in {time.time() - t0:.2f}s",
                flush=True,
            )
            return
        except Exception as e:
            print(f"[local-bge-embed] fastembed unavailable ({e}), trying sentence-transformers...", flush=True)

        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device="cpu")
        self.backend = "sentence-transformers"
        self.model.encode(["预热"], normalize_embeddings=True)
        print(
            f"[local-bge-embed] loaded {model_name} via sentence-transformers (CPU) in {time.time() - t0:.2f}s",
            flush=True,
        )

    def encode(self, texts: list[str]) -> list[list[float]]:
        with self.lock:
            if self.backend == "fastembed":
                return [vec.tolist() for vec in self.model.embed(texts)]
            vecs = self.model.encode(texts, normalize_embeddings=True)
            return [vec.tolist() for vec in vecs]


def make_handler(embedder: Embedder):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, payload: dict):
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt, *args):
            return

        def do_GET(self):
            if self.path in ("/health", "/v1/health"):
                return self._send(200, {"ok": True, "backend": embedder.backend, "model": embedder.model_name})
            if self.path in ("/v1/models", "/models"):
                return self._send(
                    200,
                    {"object": "list", "data": [{"id": embedder.model_name, "object": "model"}]},
                )
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path not in ("/v1/embeddings", "/embeddings"):
                return self._send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 8 * 1024 * 1024:
                    return self._send(400, {"error": "invalid body size"})
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                raw_input = body.get("input", [])
                if isinstance(raw_input, str):
                    texts = [raw_input]
                elif isinstance(raw_input, list):
                    texts = [str(x or "") for x in raw_input]
                else:
                    return self._send(400, {"error": "input must be string or list"})
                if not texts:
                    return self._send(200, {"object": "list", "model": embedder.model_name, "data": []})
                vectors = embedder.encode(texts)
                data = [
                    {"object": "embedding", "index": idx, "embedding": vec}
                    for idx, vec in enumerate(vectors)
                ]
                return self._send(
                    200,
                    {
                        "object": "list",
                        "model": body.get("model") or embedder.model_name,
                        "data": data,
                    },
                )
            except Exception as e:
                return self._send(500, {"error": str(e)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Local CPU BGE OpenAI-compatible embedding server")
    parser.add_argument("--host", default=os.environ.get("BGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BGE_PORT", "11435")))
    parser.add_argument("--model", default=os.environ.get("BGE_MODEL", "BAAI/bge-small-zh-v1.5"))
    parser.add_argument("--threads", type=int, default=int(os.environ.get("BGE_THREADS", "4")))
    args = parser.parse_args()

    embedder = Embedder(args.model, threads=args.threads)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(embedder))
    print(f"[local-bge-embed] listening on http://{args.host}:{args.port}/v1/embeddings", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[local-bge-embed] shutting down", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
