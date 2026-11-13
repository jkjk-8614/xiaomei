"""Request bodies for OpenAI-compatible image gateways."""

from contextlib import ExitStack
from pathlib import Path


def generation_payload(model, prompt, size, *, quality="", background=None, references=(), aspect=""):
    payload = dict(model=model, prompt=prompt, size=size, n=1, response_format="url")
    if references:
        payload["image"] = references
    if aspect:
        payload["aspect_ratio"] = aspect
    if quality:
        payload["quality"] = quality
    payload.update(background or {})
    return payload


def json_proxy_payload(model, prompt, size, references):
    options = {"response_format": "url"}
    if references:
        options["image"] = references
    return dict(model=model, prompt=prompt, size=size, extra_body=options)


async def post_video_image_request(
    client, base_url, model, prompt, ratio, references, *,
    resolve_local, publish, content_type, headers, post_with_retry,
):
    api_root = base_url if base_url.endswith("/v1") else f"{base_url}/v1"
    endpoint = f"{api_root}/videos"
    fields = dict(model=model, prompt=prompt, aspect_ratio=ratio)
    inputs = [(ref, resolve_local(ref)) for ref in references[:6]]
    if not any(path for _, path in inputs):
        if inputs:
            fields["images"] = [await publish(ref) for ref, _ in inputs]
        return await post_with_retry(client, "POST", endpoint, attempts=2, headers=headers(), json=fields)

    public_urls = []
    for ref, path in inputs:
        if not path:
            url = await publish(ref)
            if url:
                public_urls.append(url)
    if public_urls:
        fields["images"] = public_urls
    with ExitStack() as uploads:
        files = []
        for _, path in inputs:
            if path:
                stream = uploads.enter_context(open(path, "rb"))
                files.append(("images", (Path(path).name, stream, content_type(path))))
        return await client.post(endpoint, data=fields, files=files, headers=headers(multipart=True))
