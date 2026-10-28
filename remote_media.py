"""Public media downloads with address validation and pinned connections."""
import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urljoin, urlsplit

import requests
from requests.structures import CaseInsensitiveDict


def resolve_public_url(value):
    text = str(value or "").strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in text) or "\\" in text:
        raise ValueError("远程下载地址含非法字符")
    try:
        parsed = urlsplit(text)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        raise ValueError("远程下载地址无效") from None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("远程下载地址必须是公开的 HTTP/HTTPS 地址")
    try:
        addresses = {row[4][0] for row in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)}
    except OSError:
        raise ValueError("远程下载地址无法解析") from None
    for value in addresses:
        address = ipaddress.ip_address(value)
        mapped = getattr(address, "ipv4_mapped", None)
        if not address.is_global or (mapped is not None and not mapped.is_global):
            raise ValueError("远程下载地址不能指向本机或内网地址")
    if not addresses:
        raise ValueError("远程下载地址无法解析")
    return parsed, sorted(addresses)[0], port


def pinned_connection(parsed, address, port):
    if parsed.scheme == "https":
        context = ssl.create_default_context(cafile=requests.certs.where())
        connection = http.client.HTTPSConnection(parsed.hostname, port, timeout=10, context=context)
    else:
        connection = http.client.HTTPConnection(parsed.hostname, port, timeout=10)
    # Keep the original host for Host, SNI and certificate verification.  Only
    # the TCP destination uses the validated numeric address; no second DNS
    # lookup or environment proxy can select a different destination.
    connection._create_connection = lambda target, timeout, source_address=None: socket.create_connection(
        (address, port), timeout, source_address
    )
    return connection


class RemoteResponse:
    def __init__(self, connection, response):
        self.connection = connection
        self.response = response
        self.status_code = response.status
        self.headers = CaseInsensitiveDict(response.getheaders())

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def iter_content(self, chunk_size):
        while True:
            chunk = self.response.read(chunk_size)
            if not chunk:
                break
            yield chunk

    def close(self):
        try:
            self.response.close()
        finally:
            self.connection.close()


def open_public_remote_response(url, headers=None, max_redirects=4, allow_error_status=False):
    """Open a public HTTP(S) URL with pinned DNS.

    ``allow_error_status`` keeps 4xx/5xx responses readable instead of raising.
    Site-icon discovery needs it: a blocked or legal-restricted landing page
    (403/451) often still ships its ``<link rel="icon">`` in the HTML body.
    """
    current = str(url or "").strip()
    for hop in range(max_redirects + 1):
        parsed, address, port = resolve_public_url(current)
        connection = pinned_connection(parsed, address, port)
        response = None
        try:
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            connection.request("GET", path, headers=headers or {})
            if connection.sock:
                connection.sock.settimeout(60)
            response = RemoteResponse(connection, connection.getresponse())
            if response.status_code in {301, 302, 303, 307, 308}:
                location = str(response.headers.get("location") or "").strip()
                response.close()
                if not location:
                    raise ValueError("远程下载重定向缺少目标地址")
                if hop == max_redirects:
                    raise ValueError("远程下载重定向次数过多")
                current = urljoin(current, location)
                continue
            if not allow_error_status:
                response.raise_for_status()
            return response, current
        except Exception:
            if response is not None:
                response.close()
            else:
                connection.close()
            raise
    raise ValueError("远程下载重定向次数过多")
