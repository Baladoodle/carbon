import base64
import io
import json
import urllib.error

from PIL import Image
import pytest

from genforge.provider import GenerationError, Images, load_env


def png(size=(1024, 1024)):
    stream = io.BytesIO()
    Image.new("RGBA", size, (90, 80, 70, 255)).save(stream, "PNG")
    return stream.getvalue()


CALL = {"model": "gpt-image-2.5-flare", "prompt": "a stone", "size": [1024, 1024],
        "quality": "low", "background": "transparent"}


def test_generation_and_edit_send_one_request_each():
    requests = []
    def transport(request, timeout):
        requests.append(request)
        assert timeout == 600
        return json.dumps({"data": [{"b64_json": base64.b64encode(png()).decode()}], "usage": {"total_tokens": 12}}).encode(), "request-1"
    client = Images("test-only", transport=transport)
    result = client.generate(CALL)
    assert result.usage == {"total_tokens": 12}
    assert requests[0].full_url.endswith("/images/generations")
    assert json.loads(requests[0].data)["n"] == 1
    client.generate(CALL, [png()], png())
    assert len(requests) == 2
    assert requests[1].full_url.endswith("/images/edits")
    assert b'name="image[]"' in requests[1].data and b'name="mask"' in requests[1].data


@pytest.mark.parametrize("exception,status", [
    (TimeoutError(), "indeterminate"),
    (urllib.error.HTTPError("https://api.openai.com", 400, "bad", {}, None), "provider_failed"),
    (urllib.error.HTTPError("https://api.openai.com", 503, "bad", {}, None), "indeterminate"),
])
def test_errors_are_classified_without_retry_or_secret_output(exception, status):
    calls = []
    def transport(request, timeout):
        calls.append(request)
        raise exception
    with pytest.raises(GenerationError) as caught:
        Images("secret-test-value", transport=transport).generate(CALL)
    assert caught.value.status == status
    assert "secret-test-value" not in str(caught.value)
    assert len(calls) == 1


def test_unreadable_success_is_indeterminate():
    with pytest.raises(GenerationError) as caught:
        Images("test", transport=lambda *_: (b'{"data":[]}', None)).generate(CALL)
    assert caught.value.status == "indeterminate"


def test_missing_key_never_contacts_provider():
    def unexpected(*_):
        pytest.fail("provider contacted")
    with pytest.raises(GenerationError, match="OPENAI_API_KEY"):
        Images("", transport=unexpected).generate(CALL)


def test_dotenv_is_literal_and_environment_wins(tmp_path):
    path = tmp_path / ".env"
    path.write_text("OPENAI_API_KEY='file-key'\nGENFORGE_IMAGE_MODEL='$(touch must-not-exist)' # comment\nUNRELATED=value\n")
    env = {"OPENAI_API_KEY": "injected-key"}
    load_env(path, env)
    assert env == {"OPENAI_API_KEY": "injected-key", "GENFORGE_IMAGE_MODEL": "$(touch must-not-exist)"}
    assert not (tmp_path / "must-not-exist").exists()


def test_bad_dotenv_does_not_echo_values(tmp_path):
    path = tmp_path / ".env"
    path.write_text('OPENAI_API_KEY="secret-test-value\n')
    with pytest.raises(ValueError) as caught:
        load_env(path, {})
    assert "secret-test-value" not in str(caught.value)
