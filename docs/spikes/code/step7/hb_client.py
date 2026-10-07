"""A tiny Homebox API client for the step-7 spikes (stdlib only).

Routes are the ones Homebox v0.26.2 mounts in backend/app/api/routes.go; request bodies follow
the swagger document the running server serves at /swagger/doc.json.
"""

import json
import mimetypes
import os
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("HB_BASE", "http://127.0.0.1:3197/api/v1")


class HBError(Exception):
    pass


class Client:
    def __init__(self, token=None, tenant=None, base=BASE):
        self.token = token
        self.tenant = tenant
        self.base = base

    def _headers(self, extra=None):
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = self.token if self.token.startswith("Bearer ") else "Bearer " + self.token
        if self.tenant:
            h["X-Tenant"] = self.tenant
        if extra:
            h.update(extra)
        return h

    def req(self, method, path, body=None, raw=False, headers=None, data=None):
        if body is not None:
            data = json.dumps(body).encode()
            headers = {**(headers or {}), "Content-Type": "application/json"}
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=self._headers(headers))
        try:
            with urllib.request.urlopen(r) as resp:
                content = resp.read()
                if raw:
                    return resp.status, dict(resp.headers), content
                if not content:
                    return None
                return json.loads(content)
        except urllib.error.HTTPError as e:
            raise HBError(f"{method} {path} -> {e.code}: {e.read()[:500]!r}") from None

    def get(self, path, **kw):
        return self.req("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.req("POST", path, body=body, **kw)

    def put(self, path, body=None, **kw):
        return self.req("PUT", path, body=body, **kw)

    def upload(self, path, file_path, fields):
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in fields.items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
            )
        name = os.path.basename(file_path)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(file_path, "rb") as f:
            blob = f.read()
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode()
            + blob
            + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode())
        return self.req(
            "POST",
            path,
            data=b"".join(parts),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )


def login(email, password):
    c = Client()
    out = c.post("/users/login", {"username": email, "password": password, "stayLoggedIn": False})
    return out["token"]
